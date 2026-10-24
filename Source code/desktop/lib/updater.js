// Automatic updates: every computer installs new versions by itself.
//
// How it works:
//
//   1. Every few hours (update-config.js) the background program downloads
//      latest.json - a small file saying what the newest version is and
//      where its installers are - and latest.json.sig, its signature.
//   2. latest.json is only believed if its signature matches one of the
//      public keys built into this program (update-key.js). The private key
//      that makes signatures never leaves the Mac that publishes updates, so
//      nobody can push a version of their own by changing what is at the
//      download address, or by getting in between.
//   3. If the version is newer than this one, the installer for this kind of
//      computer is downloaded and its size and SHA-256 fingerprint compared
//      with the ones in latest.json. Anything that doesn't match is thrown
//      away.
//   4. It waits until nothing is printing here (a print job on its way, or a
//      printout from the PrintBridge printer still being sent), then hands
//      over to the "update runner": a copy of this same program, started as
//      a separate system task so it keeps going while the installer stops
//      and replaces the background program.
//   5. The runner runs the ordinary installer with no questions (Windows:
//      PrintBridgeSetup.exe /S /UPDATE=1; macOS: installer -pkg), which keeps
//      every setting. It then waits for the new version to report that it is
//      running. If it doesn't within a few minutes, the runner puts the
//      previous program back, starts it again, and notes what happened (the
//      "Check PrintBridge" page shows it). A version that failed is tried
//      again a day later, at most three times.
//
// Only the background program that runs with administrator rights does this
// (Windows: the startup task, as the system account; macOS: the
// LaunchDaemon, as root): installing needs those rights, and it must work
// with nobody signed in.
//
// Everything is kept in an "updates" folder next to the program (Program
// Files, or /Library/Application Support/PrintBridge), which only an
// administrator can change - unlike the data folder, which everyone signed
// in can write to. Otherwise someone without administrator rights could
// swap the downloaded installer (or the runner) for their own program just
// before the system runs it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const P = require("./paths");
// (The checks in tests/t10 pretend to be 4.1.3, whatever the real version is.)
const VERSION = (process.env.OP_UPDATE_TEST === "1" && process.env.OP_UPDATE_TEST_VERSION) || require("./version").VERSION;
const CONFIG = require("./update-config");
const durable = require("../../agent/lib/durable");
const { logger } = require("./log");

const log = logger("updates");

const UPDATE_TASK = "Office Printing Update"; // Windows: the task that runs the runner
const UPDATE_LABEL = "com.printbridge.update"; // macOS: the same, as a launchd job
const UPDATE_PLIST = "/Library/LaunchDaemons/" + UPDATE_LABEL + ".plist";
const SERVICE_LABEL = "com.printbridge.service";
const SERVICE_PLIST = "/Library/LaunchDaemons/" + SERVICE_LABEL + ".plist";

const MAX_INSTALLER_BYTES = 600 * 1024 * 1024;
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_TRIES_PER_VERSION = 3;
const MAX_WAIT_FOR_QUIET_MS = 2 * 60 * 60 * 1000;
const STALE_APPLY_MS = 45 * 60 * 1000;

const num = (name, fallback) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

// --- places --------------------------------------------------------------

function updateDir() {
  if (process.env.OP_UPDATE_DIR) return process.env.OP_UPDATE_DIR;
  return P.IS_PACKAGED ? path.join(P.INSTALL_DIR, "updates") : path.join(P.DATA_DIR, "updates");
}
const STATE = () => path.join(updateDir(), "state.json"); // written by the background program
const RESULT = () => path.join(updateDir(), "last-result.json"); // written by the runner
const APPLY = () => path.join(updateDir(), "apply.json"); // the runner's instructions
// Someone signed in can switch automatic updates off for this computer
// with {"automatic": false} here (in the data folder, so no administrator
// is needed - switching off can't harm anything).
const SETTINGS = () => path.join(P.DATA_DIR, "update-settings.json");

function platformKey() {
  if (P.IS_WINDOWS) return "windows";
  if (P.IS_MAC) return "mac";
  return process.env.OP_UPDATE_PLATFORM || os.platform();
}

// --- versions and signatures ----------------------------------------------

const VERSION_RE = /^\d{1,4}(\.\d{1,4}){1,3}$/;

// -1, 0 or 1, comparing "4.1.10" and "4.1.9" as numbers.
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function trustedKeys() {
  const list = process.env.OP_UPDATE_PUBLIC_KEY
    ? [process.env.OP_UPDATE_PUBLIC_KEY]
    : (require("./update-key").PUBLIC_KEYS || []);
  const keys = [];
  for (const text of list) {
    try {
      keys.push(crypto.createPublicKey({ key: Buffer.from(String(text).trim(), "base64"), format: "der", type: "spki" }));
    } catch (err) {
      log.line("Ignoring an update key that can't be read: " + err.message);
    }
  }
  return keys;
}

function signatureMatches(data, signature) {
  for (const key of trustedKeys()) {
    try {
      if (crypto.verify(null, data, key, signature)) return true;
    } catch (err) { /* a key of another kind, or a damaged signature */ }
  }
  return false;
}

// --- downloading -------------------------------------------------------------

// GET with redirects (GitHub's download addresses redirect), a size limit,
// and the SHA-256 worked out on the way. With toFile, the body is written
// there instead of being kept in memory.
function fetch(url, opts, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (err) { return reject(new Error("not a web address: " + url)); }
    const allowHttp = process.env.OP_UPDATE_ALLOW_HTTP === "1"; // tests only
    if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) {
      return reject(new Error("updates are only downloaded over https (" + url + ")"));
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, { headers: { "User-Agent": "PrintBridge/" + VERSION }, timeout: opts.timeoutMs || 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 6) return reject(new Error("too many redirects"));
        return resolve(fetch(new URL(res.headers.location, u).toString(), opts, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("the server answered " + res.statusCode + " for " + u.pathname.split("/").pop()));
      }
      if (parseInt(res.headers["content-length"], 10) > opts.maxBytes) {
        res.destroy();
        return reject(new Error("the file is bigger than expected"));
      }
      const hash = crypto.createHash("sha256");
      const chunks = [];
      let size = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        res.destroy();
        if (out) out.destroy();
        reject(err);
      };
      const out = opts.toFile ? fs.createWriteStream(opts.toFile) : null;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > opts.maxBytes) return fail(new Error("the file is bigger than expected"));
        hash.update(chunk);
        if (!out) chunks.push(chunk);
      });
      res.on("aborted", () => fail(new Error("the download was cut off")));
      res.on("error", fail);
      const finish = () => { if (!failed) resolve({ size, sha256: hash.digest("hex"), body: out ? null : Buffer.concat(chunks) }); };
      if (out) {
        out.on("error", fail);
        out.on("finish", finish);
        res.pipe(out);
      } else {
        res.on("end", finish);
      }
    });
    req.on("timeout", () => req.destroy(new Error("no answer (timed out)")));
    req.on("error", reject);
  });
}

function manifestUrl() {
  return process.env.OP_UPDATE_URL || CONFIG.MANIFEST_URL;
}

// Downloads and checks latest.json. Throws with a plain-English reason.
async function fetchManifest() {
  const url = manifestUrl();
  const m = await fetch(url, { maxBytes: 256 * 1024 });
  const s = await fetch(url + ".sig", { maxBytes: 8 * 1024 });
  const signature = Buffer.from(s.body.toString("utf8").trim(), "base64");
  if (!signatureMatches(m.body, signature)) {
    throw new Error("latest.json isn't signed with this program's update key, so it was ignored");
  }
  let manifest;
  try { manifest = JSON.parse(m.body.toString("utf8")); } catch (err) { throw new Error("latest.json can't be read"); }
  if (!manifest || manifest.app !== "printbridge" || !VERSION_RE.test(String(manifest.version || ""))) {
    throw new Error("latest.json doesn't describe a PrintBridge version");
  }
  manifest.baseUrl = url;
  return manifest;
}

// This computer's installer in latest.json, checked, or null.
function entryFor(manifest) {
  const e = manifest.files && manifest.files[platformKey()];
  if (!e || typeof e !== "object") return null;
  if (!/^[0-9a-f]{64}$/i.test(String(e.sha256 || "")) || !(e.size > 0) || e.size > MAX_INSTALLER_BYTES || !e.url) return null;
  let url;
  try { url = new URL(String(e.url), manifest.baseUrl).toString(); } catch (err) { return null; }
  return { url, sha256: String(e.sha256).toLowerCase(), size: e.size };
}

function sha256OfFile(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (c) => hash.update(c));
    s.on("end", () => resolve(hash.digest("hex")));
    s.on("error", () => resolve(""));
  });
}

function installerName(version) {
  if (platformKey() === "windows") return "PrintBridgeSetup-" + version + ".exe";
  if (platformKey() === "mac") return "PrintBridge-" + version + ".pkg";
  return "installer-" + version;
}

// The installer for `version`, downloaded and checked (kept, so a computer
// that is busy for a while doesn't download it again).
async function ensureDownloaded(version, entry) {
  const dir = updateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, installerName(version));
  if (fs.existsSync(file) && (await sha256OfFile(file)) === entry.sha256) return file;
  const part = path.join(dir, "download.part");
  try { fs.rmSync(part, { force: true }); } catch (err) { /* fine */ }
  log.line("Downloading version " + version + " (" + Math.round(entry.size / 1048576) + " MB) from " + entry.url);
  const got = await fetch(entry.url, { maxBytes: entry.size, toFile: part, timeoutMs: 60000 });
  if (got.size !== entry.size || got.sha256 !== entry.sha256) {
    try { fs.rmSync(part, { force: true }); } catch (err) { /* fine */ }
    throw new Error("the downloaded installer doesn't match latest.json (size or fingerprint), so it was thrown away");
  }
  fs.renameSync(part, file);
  // Installers for any other version are no longer needed.
  for (const n of fs.readdirSync(dir)) {
    if (n !== path.basename(file) && /^(PrintBridgeSetup-.*\.exe|PrintBridge-.*\.pkg|installer-.*)$/.test(n)) {
      try { fs.rmSync(path.join(dir, n), { force: true }); } catch (err) { /* next time */ }
    }
  }
  return file;
}

// --- state -------------------------------------------------------------------

const readState = () => durable.readJson(STATE()) || {};
const readResult = () => durable.readJson(RESULT()) || {};
function writeState(state) {
  try { durable.writeJson(STATE(), state); } catch (err) { /* informational */ }
}
function writeResult(result) {
  try { durable.writeJson(RESULT(), result); } catch (err) { log.line("Couldn't note the result: " + err.message); }
}

// Why automatic updates don't run in this copy of the program, or "" if they do.
function whyOff(mode) {
  if (!trustedKeys().length) return "no-key";
  const s = durable.readJson(SETTINGS());
  if (s && s.automatic === false) return "switched-off";
  if (process.env.OP_UPDATE_TEST === "1") return "";
  if (!P.IS_PACKAGED) return "not-installed";
  if (P.IS_WINDOWS) return mode === "service" ? "" : "not-system";
  if (P.IS_MAC) return typeof process.getuid === "function" && process.getuid() === 0 ? "" : "not-system";
  return "not-supported";
}

// --- is anything printing? ------------------------------------------------

function localJson(urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: P.PORT, path: urlPath, timeout: 3000 }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => { try { resolve(res.statusCode === 200 ? JSON.parse(text) : null); } catch (err) { resolve(null); } });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// A short reason when something is printing right now, otherwise "".
async function busyReason() {
  const recent = (t) => t && Date.now() - t < 10 * 60 * 1000;
  if (P.readSettings().role === "main") {
    const busy = await localJson("/api/busy");
    if (busy && busy.printing > 0) return busy.printing + " print job(s) on their way to a printer";
  }
  const agent = durable.readJson(path.join(P.PRINTER_DIR, "status.json"));
  if (agent && agent.busy > 0 && recent(agent.busyAt || agent.updatedAt)) return "printing on this computer";
  try {
    for (const n of fs.readdirSync(P.OUTBOX_DIR)) {
      if (/^taken-\d+\.pdf$/.test(n) && recent(fs.statSync(path.join(P.OUTBOX_DIR, n)).mtimeMs)) {
        return "a printout from the PrintBridge printer is being sent";
      }
    }
  } catch (err) { /* no outbox yet */ }
  return "";
}

// --- handing over to the runner -------------------------------------------------

const xmlText = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === "number" ? error.code : -1) : 0, out: String(stdout || "") + String(stderr || ""), error });
    });
  });
}

const SCHTASKS = () => path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "schtasks.exe");

function runnerTaskXml(runner, dir) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Installs a new version of PrintBridge (automatic updates). Started by PrintBridge when an update is ready, and again when Windows starts in case the computer was switched off part-way; does nothing otherwise.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <LogonType>ServiceAccount</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${xmlText(runner)}"</Command>
      <Arguments>apply-update "${xmlText(dir)}"</Arguments>
      <WorkingDirectory>${xmlText(dir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function runnerPlist(runner, dir) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${UPDATE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlText(runner)}</string>
		<string>apply-update</string>
		<string>${xmlText(dir)}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xmlText(path.join(P.LOG_DIR, "launchd-update.log"))}</string>
	<key>StandardErrorPath</key>
	<string>${xmlText(path.join(P.LOG_DIR, "launchd-update.log"))}</string>
</dict>
</plist>
`;
}

// The program file that is installed (the one the installer replaces).
function installedBinary() {
  if (process.env.OP_UPDATE_INSTALLED_BIN) return process.env.OP_UPDATE_INSTALLED_BIN;
  return P.IS_PACKAGED ? process.execPath : "";
}

// Starts the runner, separately from this program (which the installer is
// about to stop). Resolves true if it was started.
async function launchRunner(plan) {
  const dir = updateDir();
  let runner = "";
  if (P.IS_PACKAGED) {
    // A copy under another name: the installer stops and replaces every
    // program called OfficePrinting.exe / PrintBridge, never this one.
    runner = path.join(dir, P.IS_WINDOWS ? "PrintBridgeUpdater.exe" : "PrintBridgeUpdater");
    try { fs.rmSync(runner, { force: true }); } catch (err) { /* replaced below */ }
    fs.copyFileSync(process.execPath, runner);
    try { fs.chmodSync(runner, 0o755); } catch (err) { /* Windows */ }
  }
  durable.writeJson(APPLY(), plan);

  if (P.IS_WINDOWS && P.IS_PACKAGED) {
    const file = path.join(os.tmpdir(), "office-printing-update-task-" + process.pid + ".xml");
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(runnerTaskXml(runner, dir), "utf16le")]));
    const made = await run(SCHTASKS(), ["/Create", "/TN", UPDATE_TASK, "/XML", file, "/F"]);
    try { fs.rmSync(file, { force: true }); } catch (err) { /* temp */ }
    const started = made.ok && (await run(SCHTASKS(), ["/Run", "/TN", UPDATE_TASK])).ok;
    if (!started) log.line("Couldn't start the update task: " + made.out.trim());
    return started;
  }
  if (P.IS_MAC && P.IS_PACKAGED) {
    await run("/bin/launchctl", ["bootout", "system/" + UPDATE_LABEL]);
    fs.writeFileSync(UPDATE_PLIST, runnerPlist(runner, dir), { mode: 0o644 });
    const r = await run("/bin/launchctl", ["bootstrap", "system", UPDATE_PLIST]);
    if (!r.ok) log.line("Couldn't start the update job: " + r.out.trim());
    return r.ok;
  }
  // Tests (and anywhere else): a detached copy of this program.
  const child = spawn(process.execPath, (P.IS_PACKAGED ? [] : [path.join(__dirname, "..", "main.js")]).concat(["apply-update", dir]), {
    detached: true, stdio: "ignore", windowsHide: true, env: process.env,
  });
  child.on("error", () => {});
  child.unref();
  return true;
}

// --- the background program's side ------------------------------------------

let timer = null;
let busyCycle = false;

function schedule(ms, reason) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; cycle(reason); }, ms);
  if (timer.unref) timer.unref();
}

function nextRegularCheckMs() {
  const every = num("OP_UPDATE_EVERY_MS", CONFIG.CHECK_EVERY_HOURS * 3600 * 1000);
  return every + Math.floor(Math.random() * Math.min(every / 4, 30 * 60 * 1000));
}

// A number from 0 to 1 that is always the same for this computer: spreads
// the office's computers out over the first half hour after a release.
function computerSlot() {
  const h = crypto.createHash("sha256").update(os.hostname() + "|" + P.readSettings().name).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

async function cycle(reason) {
  if (busyCycle) return;
  busyCycle = true;
  let next = nextRegularCheckMs();
  try {
    const n = await check(reason);
    if (typeof n === "number") next = n;
  } catch (err) {
    log.line("Update check failed: " + (err && err.message ? err.message : err));
  } finally {
    busyCycle = false;
  }
  schedule(next);
}

// One look. Returns how long until the next one (ms), or undefined for the
// usual interval.
async function check(reason) {
  const state = readState();
  const asked = reason === "asked";
  state.version = VERSION;
  state.off = "";
  const settings = durable.readJson(SETTINGS());
  if (settings && settings.automatic === false) {
    state.off = "switched-off";
    writeState(state);
    return undefined;
  }

  // The runner is (or was) busy installing: leave it alone.
  if (fs.existsSync(APPLY())) {
    const plan = durable.readJson(APPLY()) || {};
    if (Date.now() - Math.max(plan.startedAt || 0, plan.runnerAt || 0) < STALE_APPLY_MS || runnerAlive()) return 60 * 1000;
    log.line("An update to " + plan.version + " didn't finish; tidying up.");
    noteFailure(plan.version, "The update didn't finish (the computer may have been switched off part-way).");
    try { durable.removeJson(APPLY()); } catch (err) { /* fine */ }
  }
  await tidyUp();

  state.lastCheckAt = Date.now();
  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (err) {
    state.lastCheckOk = false;
    state.lastError = err.message;
    writeState(state);
    log.line("Couldn't check for updates: " + err.message);
    return undefined;
  }
  state.lastCheckOk = true;
  state.lastError = "";
  state.lastSuccessAt = Date.now();
  state.latest = { version: manifest.version, released: String(manifest.released || ""), notes: String(manifest.notes || "").slice(0, 2000) };

  const say = (status, extra) => {
    state.status = status;
    Object.assign(state, extra || {});
    writeState(state);
  };

  if (compareVersions(manifest.version, VERSION) <= 0) {
    say("current", { readyAt: 0, waitingFor: "" });
    return undefined;
  }
  if (manifest.paused) {
    say("paused");
    log.line("Version " + manifest.version + " is published but paused; not installing it yet.");
    return undefined;
  }
  if (manifest.minVersion && VERSION_RE.test(String(manifest.minVersion)) && compareVersions(VERSION, manifest.minVersion) < 0) {
    say("manual");
    log.line("Version " + manifest.version + " can't be installed automatically from " + VERSION + " (needs " + manifest.minVersion + " or newer first).");
    return undefined;
  }
  const entry = entryFor(manifest);
  if (!entry) {
    say("no-file");
    log.line("Version " + manifest.version + " has no installer for this kind of computer (" + platformKey() + ").");
    return undefined;
  }

  // A version that failed here is tried again a day later, at most three times
  // (unless someone asks for it with "Update PrintBridge now").
  const result = readResult();
  const failures = result.failures && result.failures.version === manifest.version ? result.failures : null;
  if (failures && !asked) {
    if (failures.count >= MAX_TRIES_PER_VERSION) { say("gave-up"); return undefined; }
    if (Date.now() - failures.lastAt < RETRY_FAILED_AFTER_MS) { say("retry-later"); return undefined; }
  }

  // Each computer takes its turn within the first half hour (spreadMinutes).
  if (state.seenVersion !== manifest.version) {
    state.seenVersion = manifest.version;
    state.seenAt = Date.now();
    state.readyAt = 0;
  }
  if (!asked) {
    const spreadMs = num("OP_UPDATE_SPREAD_MS", Math.max(0, Number(manifest.spreadMinutes == null ? 30 : manifest.spreadMinutes)) * 60 * 1000);
    const turnAt = state.seenAt + Math.floor(computerSlot() * spreadMs);
    if (Date.now() < turnAt) {
      say("waiting-turn");
      return turnAt - Date.now() + 1000;
    }
  }

  say("downloading");
  let file;
  try {
    file = await ensureDownloaded(manifest.version, entry);
  } catch (err) {
    say("download-failed", { lastError: err.message });
    log.line("Couldn't download version " + manifest.version + ": " + err.message);
    return 30 * 60 * 1000;
  }

  if (!state.readyAt) state.readyAt = Date.now();
  const busy = await busyReason();
  if (busy && Date.now() - state.readyAt < MAX_WAIT_FOR_QUIET_MS) {
    say("waiting-quiet", { waitingFor: busy });
    return num("OP_UPDATE_BUSY_RETRY_MS", 60 * 1000);
  }

  const plan = {
    version: manifest.version,
    from: VERSION,
    platform: platformKey(),
    file,
    sha256: entry.sha256,
    size: entry.size,
    installedBinary: installedBinary(),
    startedAt: Date.now(),
  };
  log.line("Installing version " + manifest.version + " (this is " + VERSION + ")" + (busy ? " - waited two hours for printing to stop" : "") + ".");
  say("installing", { waitingFor: "" });
  let started = false;
  try {
    started = await launchRunner(plan);
  } catch (err) {
    log.line("Couldn't start the update: " + err.message);
  }
  if (!started) {
    try { durable.removeJson(APPLY()); } catch (err) { /* fine */ }
    noteFailure(manifest.version, "The update couldn't be started on this computer.");
    say("failed");
  }
  return 5 * 60 * 1000;
}

// Is an update runner working right now?
function runnerAlive() {
  try { return pidAlive(parseInt(fs.readFileSync(path.join(updateDir(), "runner.lock"), "utf8"), 10)); } catch (err) { return false; }
}

function noteFailure(version, message) {
  const result = readResult();
  const prev = result.failures && result.failures.version === version ? result.failures : { version, count: 0 };
  writeResult(Object.assign(result, {
    version, ok: false, at: Date.now(), message,
    failures: { version, count: prev.count + 1, lastAt: Date.now() },
  }));
}

// Leftovers from an update that has finished: the runner, the task or job
// that started it.
async function tidyUp() {
  if (fs.existsSync(APPLY())) return;
  const dir = updateDir();
  for (const n of ["PrintBridgeUpdater.exe", "PrintBridgeUpdater", "previous.bin", "runner.lock", "download.part"]) {
    try { fs.rmSync(path.join(dir, n), { force: true }); } catch (err) { /* still running; next time */ }
  }
  if (P.IS_WINDOWS && P.IS_PACKAGED) {
    await run(SCHTASKS(), ["/Delete", "/TN", UPDATE_TASK, "/F"]);
  } else if (P.IS_MAC && P.IS_PACKAGED && fs.existsSync(UPDATE_PLIST)) {
    await run("/bin/launchctl", ["bootout", "system/" + UPDATE_LABEL]);
    try { fs.rmSync(UPDATE_PLIST, { force: true }); } catch (err) { /* next time */ }
  }
}

// Called by the background program once it is running. Returns { checkNow }
// for "Update PrintBridge now".
function start(options) {
  const mode = (options && options.mode) || "all";
  const why = whyOff(mode);
  if (why) {
    // Only the copy that would do the updating says so (on Windows the
    // sign-in copy never does them; the startup task's copy does).
    if (why !== "not-system" && why !== "not-installed") {
      const state = readState();
      state.version = VERSION;
      state.off = why;
      writeState(state);
      log.line(why === "no-key" ? "Automatic updates aren't set up in this build (no update key)." : "Automatic updates are switched off on this computer.");
    }
    return { checkNow: () => "off:" + why };
  }
  const state = readState();
  state.version = VERSION;
  state.off = "";
  writeState(state);
  tidyUp().catch(() => {});
  log.line("Automatic updates are on (this is version " + VERSION + "; looking at " + manifestUrl() + ").");
  schedule(num("OP_UPDATE_FIRST_CHECK_MS", CONFIG.FIRST_CHECK_MINUTES * 60 * 1000 + Math.floor(Math.random() * 60000)));
  return {
    checkNow() {
      if (busyCycle) return "busy";
      schedule(0, "asked");
      return "ok";
    },
  };
}

// --- the runner's side (started as "apply-update <dir>") ----------------------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

// Waits until the background program reports `version` running with every
// part up, twice in a row. Resolves true or false.
async function waitHealthy(version, since, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let goodAt = 0;
  while (Date.now() < end) {
    const s = durable.readJson(P.STATUS_FILE);
    const ok = s && s.version === version && (s.updatedAt || 0) >= since && pidAlive(s.pid) &&
      Object.values(s.parts || {}).every((p) => p.running);
    if (ok && goodAt && s.updatedAt > goodAt) return true;
    if (ok && !goodAt) goodAt = s.updatedAt;
    if (!ok) goodAt = 0;
    await wait(num("OP_UPDATE_POLL_MS", 5000));
  }
  return false;
}

function installCommand(plan) {
  if (process.env.OP_UPDATE_INSTALL_CMD) {
    const parts = JSON.parse(process.env.OP_UPDATE_INSTALL_CMD).map((a) => String(a).replace("{file}", plan.file));
    return { cmd: parts[0], args: parts.slice(1) };
  }
  if (plan.platform === "windows") return { cmd: plan.file, args: ["/S", "/UPDATE=1"] };
  if (plan.platform === "mac") return { cmd: "/usr/sbin/installer", args: ["-pkg", plan.file, "-target", "/"] };
  throw new Error("no installer command for " + plan.platform);
}

// Puts the previous program back and starts it again.
async function restorePrevious(plan, backup) {
  const target = plan.installedBinary;
  if (!target || !fs.existsSync(backup)) {
    log.line("No copy of the previous program to put back.");
  }
  if (plan.platform === "windows" && P.IS_WINDOWS) {
    await run(SCHTASKS(), ["/End", "/TN", P.TASK_NAME]);
    await run("taskkill.exe", ["/F", "/IM", path.basename(target)]);
    for (let i = 0; i < 10; i++) {
      try { fs.copyFileSync(backup, target); break; } catch (err) {
        await run("taskkill.exe", ["/F", "/IM", path.basename(target)]);
        await wait(2000);
      }
    }
    // The startup task (the installer may have removed it), started again,
    // and the sign-in part for whoever is signed in.
    await run(target, ["install-service"], 120000);
    await run(SCHTASKS(), ["/Run", "/TN", P.TASK_NAME]);
    await run(target, ["start-signed-in"], 120000);
    return;
  }
  if (plan.platform === "mac" && P.IS_MAC) {
    await run("/bin/launchctl", ["bootout", "system/" + SERVICE_LABEL]);
    try { fs.copyFileSync(backup, target); fs.chmodSync(target, 0o755); } catch (err) { log.line("Couldn't put the previous program back: " + err.message); }
    if (fs.existsSync(SERVICE_PLIST)) await run("/bin/launchctl", ["bootstrap", "system", SERVICE_PLIST]);
    return;
  }
  // Tests: put the file back, then whatever restarts the stand-in.
  try { if (target && fs.existsSync(backup)) fs.copyFileSync(backup, target); } catch (err) { log.line("Couldn't put the previous program back: " + err.message); }
  if (process.env.OP_UPDATE_RESTART_CMD) {
    const parts = JSON.parse(process.env.OP_UPDATE_RESTART_CMD);
    await run(parts[0], parts.slice(1));
  }
}

async function applyUpdate() {
  const dir = updateDir();
  const plan = durable.readJson(APPLY());
  if (!plan) { log.line("Update runner: nothing to do."); return; }

  // One runner at a time.
  const lockFile = path.join(dir, "runner.lock");
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err) {
    let other = 0;
    try { other = parseInt(fs.readFileSync(lockFile, "utf8"), 10); } catch (e) { /* unreadable */ }
    if (pidAlive(other) && other !== process.pid) { log.line("Update runner: another one is already running."); return; }
    fs.writeFileSync(lockFile, String(process.pid));
  }

  const backup = path.join(dir, "previous.bin");
  const finish = (ok, message) => {
    const result = readResult();
    const failures = ok ? null : {
      version: plan.version,
      count: (result.failures && result.failures.version === plan.version ? result.failures.count : 0) + 1,
      lastAt: Date.now(),
    };
    writeResult({ version: plan.version, from: plan.from, ok, at: Date.now(), message, failures });
    log.line((ok ? "Updated to " : "Didn't update to ") + plan.version + ": " + message);
    try { durable.removeJson(APPLY()); } catch (err) { /* fine */ }
    if (ok) { try { fs.rmSync(plan.file, { force: true }); } catch (err) { /* tidied later */ } }
    try { fs.rmSync(backup, { force: true }); } catch (err) { /* tidied later */ }
    try { fs.rmSync(lockFile, { force: true }); } catch (err) { /* fine */ }
    if (P.IS_MAC && P.IS_PACKAGED) { try { fs.rmSync(UPDATE_PLIST, { force: true }); } catch (err) { /* tidied later */ } }
  };

  try {
    log.line("Update runner: installing " + plan.version + " over " + plan.from + ".");
    // Checked again right before it runs (it may have sat there a while).
    if ((await sha256OfFile(plan.file)) !== plan.sha256) {
      return finish(false, "The downloaded installer was changed or damaged before it could run, so it wasn't used.");
    }
    // Started again after the computer was switched off part-way (Windows
    // starts the runner at boot; macOS reloads its job): the copy of the
    // previous program made the first time is the one to keep - the
    // installed file may already be the new, or a half-copied, one.
    const resuming = !!plan.stage;
    if (resuming) log.line("Update runner: carrying on with an update that was interrupted (" + plan.stage + ").");
    let haveBackup = resuming && fs.existsSync(backup);
    if (!haveBackup && plan.installedBinary && fs.existsSync(plan.installedBinary)) {
      fs.copyFileSync(plan.installedBinary, backup);
      haveBackup = true;
    }

    plan.runnerAt = Date.now();
    plan.stage = "installing";
    durable.writeJson(APPLY(), plan);
    const since = Date.now();
    const { cmd, args } = installCommand(plan);
    const r = await run(cmd, args, num("OP_UPDATE_INSTALL_TIMEOUT_MS", 30 * 60 * 1000));
    log.line("Installer finished (" + (r.ok ? "ok" : "code " + r.code) + ")." + (r.out.trim() ? " " + r.out.trim().split(/\r?\n/).slice(-6).join(" | ") : ""));

    plan.stage = "checking";
    durable.writeJson(APPLY(), plan);
    const healthyMs = num("OP_UPDATE_HEALTH_MS", 4 * 60 * 1000);
    if (r.ok && (await waitHealthy(plan.version, since, healthyMs))) {
      return finish(true, "Installed automatically.");
    }

    const why = r.ok ? "the new version didn't start properly" : "the installer stopped with an error (code " + r.code + ")";
    if (!haveBackup) return finish(false, "The update failed (" + why + ") and there was no copy of the previous program to put back.");
    log.line("Update failed (" + why + "); putting " + plan.from + " back.");
    plan.stage = "restoring";
    durable.writeJson(APPLY(), plan);
    const restoredAt = Date.now();
    await restorePrevious(plan, backup);
    const back = await waitHealthy(plan.from, restoredAt, healthyMs);
    return finish(false, "The update failed (" + why + "). " +
      (back ? "Version " + plan.from + " was put back and is running." : "Version " + plan.from + " was put back but hasn't reported in yet."));
  } catch (err) {
    return finish(false, "The update stopped with a problem: " + (err && err.message ? err.message : err));
  }
}

// Is an update being installed right now? (macOS Setup asks, so that an
// automatic update doesn't open the setup wizard for whoever is signed in.)
function isInstalling() {
  const plan = durable.readJson(APPLY());
  return !!(plan && plan.stage === "installing" && Date.now() - Math.max(plan.startedAt || 0, plan.runnerAt || 0) < STALE_APPLY_MS);
}

// For the Check page.
function report() {
  // Whether updates run at all is decided by the background program (which
  // has the rights to install) and noted in state.json; the Check page runs
  // as whoever opened it, so only the two reasons anyone can see are
  // worked out here.
  const why = whyOff("service");
  const state = readState();
  return {
    version: VERSION, state, result: readResult(), installing: fs.existsSync(APPLY()), url: manifestUrl(),
    off: why === "no-key" || why === "switched-off" ? why : state.off || "",
  };
}

module.exports = {
  start, applyUpdate, isInstalling, report, compareVersions, signatureMatches, fetchManifest, updateDir,
  UPDATE_TASK, UPDATE_LABEL, UPDATE_PLIST,
};
