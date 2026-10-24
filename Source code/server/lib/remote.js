// Remote printing ("the fax"): a few chosen people print to the office
// printers from anywhere, with a personal code.
//
// The people send files to PrintBridge's online drop page (relay/worker.js,
// a free Cloudflare Worker). This main computer collects them every ~20
// seconds - it reaches out; nothing on the internet can reach in - unlocks
// them (only this computer has the private key the files were locked with,
// in the sender's browser), turns them into a PDF if needed, and prints them
// like any other job. The sender's page shows what happened.
//
// Kept in remote.json, next to the website's list of printers:
//   relayUrl, token    the drop page, and this office's secret for it
//   privateKey         unlocks the files (never leaves this computer)
//   people             name, the SHA-256 of their code (the code itself is
//                      shown once, when made, and never stored), which
//                      printers they may use, a daily limit, whether their
//                      printouts wait for someone here to press Print
//   pending            printouts waiting for that approval
//   log                the last 100 remote printouts (who, what, where, result)
//
// Managing the people (and connecting the page) is only possible on this
// computer itself: the Printers & setup page is open to everyone on the
// office network, and a guest must never be able to give themselves a code.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const durable = require("../../agent/lib/durable");

const POLL_MS = parseInt(process.env.OP_REMOTE_POLL_MS, 10) || 20000;
const ALIVE_EVERY_MS = 2 * 60 * 1000;
const FULL_EVERY_MS = 10 * 60 * 1000;
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I/L
const ALLOWED = /\.(pdf|docx?|xlsx?|xlsm|pptx?|odt|ods|odp|rtf|txt|csv|png|jpe?g|gif|bmp|tiff?|webp)$/i;

let FILE = "";
let deps = null; // { db, jobs, agents, readyToPrint, uploadDir, log }
let state = null;
let timer = null;
let busy = false;
let lastAlive = 0;
let lastFull = 0;
let lastConfigSig = "";
let lastError = "";
let lastPollOk = 0;

const blank = () => ({ relayUrl: "", token: "", privateKey: "", publicKey: "", people: [], pending: [], log: [], tracking: [], handled: {} });

function load() {
  state = Object.assign(blank(), durable.readJson(FILE) || {});
}
function save() {
  try { durable.writeJson(FILE, state); } catch (err) { deps.log("Remote printing: couldn't save (" + err.message + ")"); }
}

// --- codes ------------------------------------------------------------------------------

function newCode() {
  const chars = Array.from(crypto.randomBytes(12), (b) => ALPHABET[b % ALPHABET.length]).join("");
  return "PB-" + chars.slice(0, 4) + "-" + chars.slice(4, 8) + "-" + chars.slice(8, 12);
}
// The same as the drop page: ignore case, spaces and dashes.
const normal = (code) => String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
const hashCode = (code) => crypto.createHash("sha256").update(normal(code)).digest("hex");

// --- talking to the drop page ---------------------------------------------------------------

function request(method, urlPath, body, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlPath, state.relayUrl); } catch (err) { return reject(new Error("The drop page's address isn't right.")); }
    const lib = u.protocol === "https:" ? https : http;
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { "User-Agent": "PrintBridge", Accept: "*/*" };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    const token = opts.token || state.token;
    if (token) headers.Authorization = "Bearer " + token;
    const req = lib.request(u, { method, headers, timeout: opts.timeoutMs || 30000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 30 * 1024 * 1024) req.destroy(new Error("too big")); else chunks.push(c); });
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (opts.raw && res.statusCode === 200) return resolve(buf);
        let json = {};
        try { json = JSON.parse(buf.toString("utf8") || "{}"); } catch (err) { /* not JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const e = new Error(json.error || "The drop page answered " + res.statusCode + ".");
        e.status = res.statusCode;
        reject(e);
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("The drop page didn't answer.")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const connected = () => !!(state && state.relayUrl && state.token && state.privateKey);

function printerNames() {
  const names = deps.db.printers.filter((p) => !p.hidden).map((p) => p.name);
  return [...new Set(names)].sort();
}

// What the drop page needs to know. Sent again whenever it changes.
function configBody() {
  return {
    name: os.hostname(),
    publicKey: state.publicKey,
    printers: printerNames(),
    people: state.people.map((p) => ({
      id: p.id, hash: p.codeHash, name: p.name,
      printers: p.printers && p.printers.length ? p.printers : null,
      dailyLimit: p.dailyLimit || 0, active: p.active !== false,
    })),
  };
}

async function pushConfig(force) {
  if (!connected()) return;
  const body = configBody();
  const sig = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (!force && sig === lastConfigSig) return;
  await request("PUT", "/office/config", body);
  lastConfigSig = sig;
}

// --- unlocking a file -------------------------------------------------------------------------

function unlock(job, blob) {
  const key = crypto.privateDecrypt(
    { key: state.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(job.key, "base64")
  );
  const iv = Buffer.from(job.iv, "base64");
  if (blob.length < 20) throw new Error("The file is empty.");
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
  const headerLength = plain.readUInt32BE(0);
  if (headerLength > 4096) throw new Error("The file's details aren't readable.");
  const header = JSON.parse(plain.subarray(4, 4 + headerLength).toString("utf8"));
  return { header, data: plain.subarray(4 + headerLength) };
}

// A plain, safe file name (no folders, no odd characters), keeping the extension.
function safeName(name) {
  const base = path.basename(String(name || "Printout.pdf")).replace(/[^\w .()-]/g, "_").slice(-120);
  return ALLOWED.test(base) ? base : base + ".pdf";
}

// --- the log ------------------------------------------------------------------------------------

function addLog(entry) {
  state.log.unshift(Object.assign({ at: Date.now() }, entry));
  state.log = state.log.slice(0, 100);
}
function updateLog(relayId, changes) {
  const e = state.log.find((x) => x.relayId === relayId);
  if (e) Object.assign(e, changes);
}

async function report(relayId, status, message, collected) {
  try {
    await request("POST", "/office/jobs/" + relayId + "/status", { status, message: message || "", collected: !!collected });
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

// --- printing one remote job --------------------------------------------------------------------

function findPrinter(name) {
  const matching = deps.db.printers.filter((p) => p.name === name && !p.hidden);
  return matching.find((p) => deps.agents.isOnline(p.agentId)) || matching[0] || null;
}

// Turns an unlocked file into a print job. Returns the job.
async function printFile(entry, filePath) {
  const printer = findPrinter(entry.printer);
  if (!printer || !deps.agents.canPrintTo(printer)) throw new Error("The printer \"" + entry.printer + "\" isn't available at the office right now.");
  const storedPath = await deps.readyToPrint({ path: filePath, originalname: entry.fileName });
  const options = deps.jobs.cleanOptions({ copies: entry.copies, color: entry.color, sides: entry.sides });
  const job = deps.jobs.createJob({
    deviceId: "remote:" + entry.personId,
    label: "Remote: " + entry.person,
    file: { originalName: entry.fileName, storedPath },
    printer,
    options,
    allowFailover: false,
  });
  deps.jobs.dispatch(job);
  state.tracking.push({ jobId: job.id, relayId: entry.relayId });
  return job;
}

async function collect(job) {
  const person = state.people.find((p) => p.id === job.personId && p.codeHash === job.hash);
  const base = { relayId: job.id, person: job.person, personId: job.personId, printer: job.printer, fileName: safeName(job.name) };
  if (!person || person.active === false) {
    addLog(Object.assign(base, { result: "rejected", message: "code switched off" }));
    await report(job.id, "rejected", "This code has been switched off.", true);
    return;
  }
  const blob = await request("GET", "/office/jobs/" + job.id + "/file", null, { raw: true, timeoutMs: 120000 });
  let unlocked;
  try {
    unlocked = unlock(job, blob);
  } catch (err) {
    addLog(Object.assign(base, { result: "failed", message: "couldn't unlock the file" }));
    await report(job.id, "failed", "The file couldn't be unlocked at the office. Send it again.", true);
    return;
  }
  const fileName = safeName(unlocked.header.name || job.name);
  const tmp = path.join(deps.uploadDir, "remote-" + job.id + path.extname(fileName).toLowerCase());
  fs.writeFileSync(tmp, unlocked.data);
  const entry = {
    relayId: job.id, personId: person.id, person: person.name, printer: job.printer,
    copies: job.copies, color: job.color, sides: job.sides, fileName, filePath: tmp, at: job.at || Date.now(),
  };
  if (person.hold) {
    state.pending.push(entry);
    addLog(Object.assign(base, { fileName, result: "held" }));
    save();
    await report(job.id, "held", "", true);
    return;
  }
  addLog(Object.assign(base, { fileName, result: "printing" }));
  try {
    await printFile(entry, tmp);
    save();
    await report(job.id, "printing", "", true);
  } catch (err) {
    fs.unlink(tmp, () => {});
    updateLog(job.id, { result: "failed", message: err.message });
    save();
    await report(job.id, "failed", err.message, true);
  }
}

// Jobs printed from here: tell the sender when each one is done.
async function reportFinished() {
  const keep = [];
  for (const t of state.tracking) {
    const job = deps.db.jobs.find((j) => j.id === t.jobId);
    if (!job) continue;
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      const status = job.status === "done" ? "done" : "failed";
      const message = job.status === "done" ? "" : job.statusMessage || "The printer couldn't print it.";
      try {
        await report(t.relayId, status, message, false);
        updateLog(t.relayId, { result: status, message: status === "done" ? "" : message });
      } catch (err) { keep.push(t); }
    } else {
      keep.push(t);
    }
  }
  if (keep.length !== state.tracking.length) { state.tracking = keep; save(); }
}

async function poll() {
  if (busy || !connected()) return;
  busy = true;
  try {
    await pushConfig(false);
    const now = Date.now();
    const alive = now - lastAlive > ALIVE_EVERY_MS;
    const full = now - lastFull > FULL_EVERY_MS;
    const res = await request("GET", "/office/queue" + (alive || full ? "?" + [alive ? "alive=1" : "", full ? "full=1" : ""].filter(Boolean).join("&") : ""));
    if (alive) lastAlive = now;
    if (full) lastFull = now;
    // A job already handled can still be listed for a minute (the online
    // store catches up slowly): it is only told "collected" again.
    for (const job of res.jobs || []) {
      if (state.handled[job.id]) {
        report(job.id, state.handled[job.id], "", true).catch(() => {});
        continue;
      }
      try {
        await collect(job);
      } catch (err) {
        deps.log("Remote printing: couldn't collect a job (" + err.message + ")");
        continue;
      }
      state.handled[job.id] = (state.log.find((x) => x.relayId === job.id) || {}).result || "received";
    }
    // Forget handled ids after a day.
    const cutoff = now - 24 * 3600 * 1000;
    for (const id of Object.keys(state.handled)) {
      const e = state.log.find((x) => x.relayId === id);
      if (!e || e.at < cutoff) delete state.handled[id];
    }
    await reportFinished();
    save();
    lastError = "";
    lastPollOk = now;
  } catch (err) {
    lastError = err.message;
    if (err.status === 401) lastError = "The drop page no longer recognises this office. Connect it again.";
  } finally {
    busy = false;
  }
}

// --- what the Printers & setup page uses ---------------------------------------------------------

function publicPerson(p) {
  return {
    id: p.id, name: p.name, printers: p.printers || [], dailyLimit: p.dailyLimit || 0,
    hold: !!p.hold, active: p.active !== false, createdAt: p.createdAt, hint: p.hint || "",
  };
}

function status() {
  return {
    connected: connected(),
    relayUrl: state.relayUrl,
    online: connected() && Date.now() - lastPollOk < 3 * POLL_MS,
    lastError,
    people: state.people.map(publicPerson),
    pending: state.pending.map((e) => ({ id: e.relayId, person: e.person, fileName: e.fileName, printer: e.printer, copies: e.copies, at: e.at })),
    log: state.log.slice(0, 30),
    printers: printerNames(),
  };
}

async function connect(relayUrl, claim) {
  let url;
  try { url = new URL(String(relayUrl || "").trim()); } catch (err) { throw new Error("Type the drop page's address, like https://printbridge.yourname.workers.dev"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) {
    throw new Error("The drop page's address must start with https://");
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const previous = Object.assign({}, state);
  state.relayUrl = url.origin;
  try {
    // A page this office already uses accepts its old secret to pair again.
    await request("POST", "/office/claim", { claim: String(claim || ""), token }, { token: previous.relayUrl === url.origin ? previous.token : "" });
  } catch (err) {
    Object.assign(state, previous);
    throw err;
  }
  state.token = token;
  state.privateKey = privateKey.export({ type: "pkcs8", format: "pem" });
  state.publicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  save();
  lastConfigSig = "";
  await pushConfig(true);
  setTimeout(poll, 500);
}

function disconnect() {
  state.relayUrl = ""; state.token = ""; state.privateKey = ""; state.publicKey = "";
  save();
}

function cleanPerson(input, existing) {
  const p = existing || { id: "rp_" + crypto.randomBytes(6).toString("hex"), createdAt: Date.now() };
  if (input.name !== undefined) p.name = String(input.name || "").trim().slice(0, 60) || "Someone";
  if (input.printers !== undefined) p.printers = Array.isArray(input.printers) ? input.printers.map((n) => String(n).slice(0, 120)).slice(0, 50) : [];
  if (input.dailyLimit !== undefined) p.dailyLimit = Math.max(0, Math.min(500, parseInt(input.dailyLimit, 10) || 0));
  if (input.hold !== undefined) p.hold = !!input.hold;
  if (input.active !== undefined) p.active = !!input.active;
  return p;
}

// Adds a person. Returns their code - the only time it is ever shown.
async function addPerson(input) {
  const p = cleanPerson(input || {});
  const code = newCode();
  p.codeHash = hashCode(code);
  p.hint = code.slice(-4);
  if (p.active === undefined) p.active = true;
  state.people.push(p);
  save();
  await pushConfig(true).catch(() => {});
  return { person: publicPerson(p), code };
}

async function updatePerson(id, input) {
  const p = state.people.find((x) => x.id === id);
  if (!p) throw new Error("That person isn't on the list any more.");
  cleanPerson(input || {}, p);
  save();
  await pushConfig(true).catch(() => {});
  return publicPerson(p);
}

async function newCodeFor(id) {
  const p = state.people.find((x) => x.id === id);
  if (!p) throw new Error("That person isn't on the list any more.");
  const code = newCode();
  p.codeHash = hashCode(code);
  p.hint = code.slice(-4);
  save();
  await pushConfig(true).catch(() => {});
  return { person: publicPerson(p), code };
}

async function removePerson(id) {
  state.people = state.people.filter((x) => x.id !== id);
  save();
  await pushConfig(true).catch(() => {});
}

async function approve(relayId, printerName) {
  const entry = state.pending.find((e) => e.relayId === relayId);
  if (!entry) throw new Error("That printout isn't waiting any more.");
  if (printerName) entry.printer = String(printerName);
  try {
    await printFile(entry, entry.filePath);
  } catch (err) {
    throw err;
  }
  state.pending = state.pending.filter((e) => e !== entry);
  updateLog(relayId, { result: "printing", printer: entry.printer });
  save();
  report(relayId, "printing", "", false).catch(() => {});
}

function reject(relayId) {
  const entry = state.pending.find((e) => e.relayId === relayId);
  if (!entry) return;
  state.pending = state.pending.filter((e) => e !== entry);
  fs.unlink(entry.filePath, () => {});
  updateLog(relayId, { result: "rejected" });
  save();
  report(relayId, "rejected", "", false).catch(() => {});
}

function start(options) {
  deps = options;
  FILE = options.file;
  load();
  if (timer) clearInterval(timer);
  timer = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => { poll().catch(() => {}); }, 3000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, poll, status, connect, disconnect, addPerson, updatePerson, newCodeFor, removePerson, approve, reject, hashCode, newCode };
