// Automatic updates (4.1.3+): only a version signed with the right key is
// installed, only once its installer matches, only when nothing is printing;
// a version that doesn't start is undone; publishing (release/publish-update.js)
// makes files the computers accept.
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto"), assert = require("assert");
const { spawn, execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const FAKES = path.join(__dirname, "update-fakes");
const PORT = 39491;
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200); } return false; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const procs = [];

const www = fs.mkdtempSync(path.join(os.tmpdir(), "pbu-www-"));
const server = http.createServer((req, res) => {
  const f = path.join(www, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(www) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end("no"); }
  res.end(fs.readFileSync(f));
});

const goodKey = crypto.generateKeyPairSync("ed25519");
const otherKey = crypto.generateKeyPairSync("ed25519");
const spki = (k) => k.publicKey.export({ format: "der", type: "spki" }).toString("base64");

// Publishes one "release" into www.
function publish({ version, spec, key, tamper, extra }) {
  for (const f of fs.readdirSync(www)) fs.rmSync(path.join(www, f), { recursive: true, force: true });
  const installer = Buffer.from(JSON.stringify(spec || { version }));
  fs.writeFileSync(path.join(www, "PrintBridgeSetup.exe"), tamper ? Buffer.concat([installer, Buffer.from(" ")]) : installer);
  const manifest = Object.assign({
    app: "printbridge", version, released: "2026-10-22", notes: "test",
    files: { windows: { url: "PrintBridgeSetup.exe", sha256: crypto.createHash("sha256").update(installer).digest("hex"), size: installer.length } },
  }, extra || {});
  const body = Buffer.from(JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(www, "latest.json"), body);
  fs.writeFileSync(path.join(www, "latest.json.sig"), crypto.sign(null, body, (key || goodKey).privateKey).toString("base64"));
}

// A fresh computer: data folder, updates folder, the "installed program", the
// background program running version 4.1.3.
function computer(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbu-"));
  const env = Object.assign({}, process.env, {
    OP_DATA_DIR: dir,
    OP_UPDATE_DIR: path.join(dir, "updates"),
    OP_UPDATE_URL: "http://127.0.0.1:" + PORT + "/latest.json",
    OP_UPDATE_ALLOW_HTTP: "1",
    OP_UPDATE_TEST: "1",
    OP_UPDATE_TEST_VERSION: "4.1.3",
    OP_UPDATE_PUBLIC_KEY: spki(goodKey),
    OP_UPDATE_PLATFORM: "windows",
    OP_UPDATE_FIRST_CHECK_MS: "100",
    OP_UPDATE_EVERY_MS: "600000",
    OP_UPDATE_SPREAD_MS: "0",
    OP_UPDATE_BUSY_RETRY_MS: "500",
    OP_UPDATE_POLL_MS: "250",
    OP_UPDATE_HEALTH_MS: "5000",
    OP_UPDATE_INSTALLED_BIN: path.join(dir, "installed.bin"),
    OP_UPDATE_INSTALL_CMD: JSON.stringify([process.execPath, path.join(FAKES, "fake-install.js"), "{file}"]),
    OP_UPDATE_RESTART_CMD: JSON.stringify([process.execPath, path.join(FAKES, "fake-restart.js")]),
    OP_LOCK_PORT: "39481",
  }, (opts && opts.env) || {});
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
  fs.writeFileSync(env.OP_UPDATE_INSTALLED_BIN, "program 4.1.3");
  fs.mkdirSync(path.join(dir, "outbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ role: "printer", name: "Front desk", server: "" }));
  const sup = spawn(process.execPath, [path.join(FAKES, "fake-sup.js"), path.join(dir, "status.json"), "4.1.3"], { detached: true, stdio: "ignore" });
  sup.unref();
  return { dir, env, upd: env.OP_UPDATE_DIR };
}

function drive(c, how, ms) {
  const p = spawn(process.execPath, [path.join(FAKES, "driver.js"), how || "", String(ms || 20000)], { env: c.env });
  p.out = ""; p.stdout.on("data", (d) => { p.out += d; }); p.stderr.on("data", (d) => { p.out += d; });
  procs.push(p);
  return p;
}
const state = (c) => readJson(path.join(c.upd, "state.json")) || {};
const result = (c) => readJson(path.join(c.upd, "last-result.json")) || {};
const installerRuns = (c) => { try { return fs.readFileSync(path.join(c.dir, "installer-runs.txt"), "utf8").trim().split("\n").filter(Boolean); } catch (e) { return []; } };
const stopSup = (c) => { try { process.kill(parseInt(fs.readFileSync(path.join(c.dir, "status.json.pid"), "utf8"), 10)); } catch (e) { /* gone */ } };
const log = (c) => { try { return fs.readFileSync(path.join(c.dir, "logs", "updates.log"), "utf8"); } catch (e) { return ""; } };

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const u = require(path.join(ROOT, "desktop", "lib", "updater"));
  ok(u.compareVersions("4.1.10", "4.1.9") === 1 && u.compareVersions("4.1.3", "4.1.3.0") === 0 && u.compareVersions("4.2", "4.10") === -1, "versions compare as numbers (4.1.10 is newer than 4.1.9)");

  // 1. The same version: nothing to do.
  let c = computer();
  publish({ version: "4.1.3" });
  let d = drive(c);
  ok(await waitFor(() => state(c).status === "current", 8000), "same version published: \"up to date\", nothing downloaded");
  ok(!installerRuns(c).length && !fs.existsSync(path.join(c.upd, "PrintBridgeSetup-4.1.3.exe")), "...and no installer was run");
  d.kill(); stopSup(c);

  // 2. Signed with someone else's key.
  c = computer();
  publish({ version: "9.9.9", key: otherKey });
  d = drive(c);
  ok(await waitFor(() => state(c).lastCheckOk === false, 8000), "a latest.json signed with another key is refused");
  ok(/isn't signed/.test(state(c).lastError) && !fs.existsSync(path.join(c.upd, "PrintBridgeSetup-9.9.9.exe")) && !installerRuns(c).length, "...said why, downloaded nothing, ran nothing");
  d.kill(); stopSup(c);

  // 3. Properly signed, but the installer was swapped on the way.
  c = computer();
  publish({ version: "4.1.4", tamper: true });
  d = drive(c);
  ok(await waitFor(() => state(c).status === "download-failed", 8000), "an installer that doesn't match its fingerprint is thrown away");
  ok(!installerRuns(c).length && !fs.readdirSync(c.upd).some((f) => /\.exe$|\.part$/.test(f)), "...never run, nothing left behind");
  d.kill(); stopSup(c);

  // 4. A good update, while a printout is being sent: waits, then installs.
  c = computer();
  publish({ version: "4.1.4" });
  const printout = path.join(c.dir, "outbox", "taken-" + Date.now() + ".pdf");
  fs.writeFileSync(printout, "%PDF");
  d = drive(c, "", 40000);
  ok(await waitFor(() => state(c).status === "waiting-quiet", 8000), "downloaded, then waits while something is printing (" + (state(c).waitingFor || "?") + ")");
  await sleep(1500);
  ok(!installerRuns(c).length, "...and doesn't install meanwhile");
  fs.rmSync(printout);
  const t0 = Date.now();
  ok(await waitFor(() => result(c).version === "4.1.4", 20000), "printing done -> installed (" + ((Date.now() - t0) / 1000).toFixed(1) + " s)");
  ok(result(c).ok === true && fs.readFileSync(c.env.OP_UPDATE_INSTALLED_BIN, "utf8") === "program 4.1.4", "the new version is installed and reported running");
  ok(await waitFor(() => !fs.existsSync(path.join(c.upd, "apply.json")) && !fs.existsSync(path.join(c.upd, "PrintBridgeSetup-4.1.4.exe")) && !fs.existsSync(path.join(c.upd, "previous.bin")), 5000), "the runner tidied up after itself");
  d.kill(); stopSup(c);

  // 5. A version that doesn't start properly is undone.
  c = computer();
  publish({ version: "4.1.4", spec: { version: "4.1.4", broken: true } });
  d = drive(c, "", 40000);
  ok(await waitFor(() => result(c).version === "4.1.4", 25000), "a new version that doesn't start properly is noticed");
  const r5 = result(c);
  ok(r5.ok === false && /put back and is running/.test(r5.message) && fs.readFileSync(c.env.OP_UPDATE_INSTALLED_BIN, "utf8") === "program 4.1.3", "...the previous program is put back and running again (" + r5.message + ")");
  ok(readJson(path.join(c.dir, "status.json")).version === "4.1.3" && r5.failures.count === 1, "...reports 4.1.3 again; one failed try noted");
  d.kill();
  // The next regular look doesn't try the same version again straight away...
  d = drive(c);
  ok(await waitFor(() => state(c).status === "retry-later", 8000) && installerRuns(c).length === 1, "the same version isn't tried again until a day later");
  d.kill();
  // ...unless someone asks ("Update PrintBridge now"); an installer that fails outright is undone too.
  publish({ version: "4.1.4", spec: { version: "4.1.4", fail: true } });
  d = drive(c, "ask", 40000);
  ok(await waitFor(() => (result(c).failures || {}).count === 2, 25000), "\"Update PrintBridge now\" tries again at once");
  ok(/installer stopped with an error \(code 4\)/.test(result(c).message) && fs.readFileSync(c.env.OP_UPDATE_INSTALLED_BIN, "utf8") === "program 4.1.3", "an installer that fails outright: noted, previous program kept");
  d.kill(); stopSup(c);

  // 6. Paused by whoever publishes.
  c = computer();
  publish({ version: "4.1.4", extra: { paused: true } });
  d = drive(c);
  ok(await waitFor(() => state(c).status === "paused", 8000) && !installerRuns(c).length, "a paused release isn't installed");
  d.kill(); stopSup(c);

  // 7. No key in this build / switched off on this computer.
  c = computer({ env: { OP_UPDATE_PUBLIC_KEY: "none" } }); // (as if update-key.js were empty)
  d = drive(c, "ask");
  ok(await waitFor(() => state(c).off === "no-key", 5000) && /ASKED off:no-key/.test(d.out), "a build without an update key never updates (and says so)");
  d.kill(); stopSup(c);
  c = computer();
  fs.writeFileSync(path.join(c.dir, "update-settings.json"), JSON.stringify({ automatic: false }));
  publish({ version: "4.1.4" });
  d = drive(c, "ask");
  ok(await waitFor(() => state(c).off === "switched-off", 5000) && !installerRuns(c).length, "switched off on this computer: nothing installed");
  d.kill(); stopSup(c);

  // 9. Switched off part-way through an update: the runner is started again
  //    (Windows at boot, macOS by launchd) and carries on, keeping the copy
  //    of the previous program it made the first time.
  c = computer();
  publish({ version: "4.1.4" });
  fs.mkdirSync(c.upd, { recursive: true });
  const inst = path.join(c.upd, "PrintBridgeSetup-4.1.4.exe");
  fs.copyFileSync(path.join(www, "PrintBridgeSetup.exe"), inst);
  fs.writeFileSync(path.join(c.upd, "previous.bin"), "program 4.1.3");
  fs.writeFileSync(c.env.OP_UPDATE_INSTALLED_BIN, "half-copied");
  fs.writeFileSync(path.join(c.upd, "runner.lock"), "999999");
  const m9 = readJson(path.join(www, "latest.json"));
  fs.writeFileSync(path.join(c.upd, "apply.json"), JSON.stringify({ version: "4.1.4", from: "4.1.3", platform: "windows", file: inst,
    sha256: m9.files.windows.sha256, size: m9.files.windows.size, installedBinary: c.env.OP_UPDATE_INSTALLED_BIN, startedAt: Date.now() - 3600 * 1000, stage: "installing" }));
  process.env.OP_DATA_DIR = c.dir;
  const env9 = Object.assign({}, c.env, { OP_UPDATE_HEALTH_MS: "5000" });
  execFileSync(process.execPath, [path.join(ROOT, "desktop", "main.js"), "apply-update", c.upd], { env: env9 });
  ok(result(c).ok === true && result(c).version === "4.1.4" && !fs.existsSync(path.join(c.upd, "apply.json")), "an update interrupted by switching off is finished when the runner starts again");
  stopSup(c);
  c = computer();
  fs.mkdirSync(c.upd, { recursive: true });
  fs.writeFileSync(path.join(c.upd, "apply.json"), JSON.stringify({ version: "4.1.4", from: "4.1.3", platform: "windows", file: inst + ".gone",
    sha256: "0".repeat(64), size: 1, installedBinary: c.env.OP_UPDATE_INSTALLED_BIN, startedAt: Date.now() - 3600 * 1000, stage: "installing" }));
  execFileSync(process.execPath, [path.join(ROOT, "desktop", "main.js"), "apply-update", c.upd], { env: c.env });
  ok(result(c).ok === false && /changed or damaged/.test(result(c).message) && fs.readFileSync(c.env.OP_UPDATE_INSTALLED_BIN, "utf8") === "program 4.1.3", "...but a missing or changed installer is never run");
  execFileSync(process.execPath, [path.join(ROOT, "desktop", "main.js"), "apply-update", c.upd], { env: c.env });
  ok(/nothing to do/.test(log(c)), "a runner started with nothing to do (Windows starts it at every boot until it is tidied away) just stops");
  stopSup(c);

  // 8. Publishing: keygen, bump, sign with release/publish-update.js, then a
  //    computer installs exactly that.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "pbu-src-"));
  const copy = (rel) => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.cpSync(path.join(ROOT, rel), path.join(src, rel), { recursive: true }); };
  ["desktop/lib", "desktop/package.json", "desktop/tools/relabel-exe/relabel-exe.js", "release", "server/server.js", "server/package.json", "agent/agent.js", "agent/package.json", "installer/OfficePrinting.nsi", "BUILD-ON-MAC.txt", "installer-mac/BUILD-ON-MAC.txt"].forEach(copy);
  fs.writeFileSync(path.join(src, "desktop/lib/update-key.js"), "module.exports = {\n  PUBLIC_KEYS: [\n  ],\n};\n");
  // (The copy starts at 4.1.3, whatever the real version is now.)
  const realVersion = require(path.join(ROOT, "desktop/lib/version.js")).VERSION;
  const at413 = (rel, re, to) => { const f = path.join(src, rel); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(re, to)); };
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(src)) {
    const text = fs.readFileSync(f, "utf8");
    if (text.includes(realVersion)) fs.writeFileSync(f, text.split(realVersion).join("4.1.3"));
  }
  at413("desktop/lib/update-config.js", /MANIFEST_URL: "[^"]+"/, 'MANIFEST_URL: "https://127.0.0.1:9/latest.json"'); // (never the real feed)
  const keyFile = path.join(src, "..", path.basename(src) + "-key", "k.pem");
  const pub = (cmd) => execFileSync(process.execPath, [path.join(src, "release", "publish-update.js")].concat(cmd), { encoding: "utf8" });
  pub(["keygen", "--key", keyFile]);
  const keys = require(path.join(src, "desktop/lib/update-key.js")).PUBLIC_KEYS;
  ok(keys.length === 1 && fs.existsSync(keyFile) && (fs.statSync(keyFile).mode & 0o077) === 0, "keygen: private key kept outside the source (only its owner can read it), public half put in update-key.js");
  let refused = false;
  try { pub(["keygen"]); } catch (e) { refused = /already trusts a signing key/.test(String(e.stderr)); }
  ok(refused, "keygen won't quietly replace a key the build already trusts");
  pub(["bump", "4.1.4"]);
  const nsi = fs.readFileSync(path.join(src, "installer/OfficePrinting.nsi"), "utf8");
  ok(/VERSION: "4.1.4"/.test(fs.readFileSync(path.join(src, "desktop/lib/version.js"), "utf8")) && /!define VERSION "4.1.4"/.test(nsi) &&
    /const VERSION = "4.1.4"/.test(fs.readFileSync(path.join(src, "agent/agent.js"), "utf8")), "bump: the version number changed everywhere it is written");
  fs.mkdirSync(path.join(src, "installer", "dist"), { recursive: true });
  fs.writeFileSync(path.join(src, "installer", "dist", "PrintBridgeSetup.exe"), JSON.stringify({ version: "4.1.4" }));
  let notSigned = false;
  try { pub(["sign", "--key", path.join(os.tmpdir(), "missing.pem")]); } catch (e) { notSigned = true; }
  ok(notSigned, "sign refuses without the private key");
  const otherFile = path.join(src, "other.pem");
  fs.writeFileSync(otherFile, otherKey.privateKey.export({ format: "pem", type: "pkcs8" }));
  let wrongKey = false;
  try { pub(["sign", "--key", otherFile]); } catch (e) { wrongKey = /isn't the one in desktop\/lib\/update-key.js/.test(String(e.stderr)); }
  ok(wrongKey, "sign refuses a key the build doesn't trust (computers would ignore it)");
  pub(["sign", "--key", keyFile, "--notes", "Test release", "--relative"]);
  const rel = path.join(src, "..", "Updates", "4.1.4");
  ok(["latest.json", "latest.json.sig", "PrintBridgeSetup.exe"].every((f) => fs.existsSync(path.join(rel, f))), "sign: latest.json, its signature and the installer are ready in Updates/4.1.4");
  for (const f of fs.readdirSync(www)) fs.rmSync(path.join(www, f), { force: true });
  for (const f of fs.readdirSync(rel)) fs.copyFileSync(path.join(rel, f), path.join(www, f));
  c = computer({ env: { OP_UPDATE_PUBLIC_KEY: keys[0] } });
  d = drive(c, "", 40000);
  ok(await waitFor(() => result(c).version === "4.1.4", 25000) && result(c).ok === true, "a computer installs the published release by itself");
  d.kill(); stopSup(c);
  fs.rmSync(rel, { recursive: true, force: true });

  procs.forEach((p) => p.kill());
  server.close();
  console.log(n + " checks passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  procs.forEach((p) => { console.error(p.out.slice(-1500)); p.kill(); });
  process.exit(1);
});
