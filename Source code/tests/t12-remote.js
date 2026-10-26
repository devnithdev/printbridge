// Remote printing ("the fax", 4.2.0+): the online drop page (relay/worker.js,
// run here with a stand-in for Cloudflare's store), the main computer
// collecting from it (server/lib/remote.js) and a stand-in printer computer.
// Files are locked in the "browser" exactly as relay/app.js does it.
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), assert = require("assert");
const crypto = require("crypto"), { fork, execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const NODE_PATH = [path.join(ROOT, "agent", "node_modules"), path.join(ROOT, "server", "node_modules"), process.env.NODE_PATH || ""].join(path.delimiter);
const WebSocket = require(path.join(ROOT, "server", "node_modules", "ws"));
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200); } return false; };
const WEB = 3721, RELAY = 3722;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbr-"));
const procs = [];

// --- the drop page, with a stand-in for Workers KV -------------------------------------
const kv = new Map();
const KV = {
  async get(key, type) {
    const e = kv.get(key);
    if (!e) return null;
    if (type === "json") return JSON.parse(Buffer.from(e).toString("utf8"));
    if (type === "arrayBuffer") return e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength);
    return Buffer.from(e).toString("utf8");
  },
  async put(key, value) { kv.set(key, typeof value === "string" ? Buffer.from(value) : Buffer.from(new Uint8Array(value))); },
  async delete(key) { kv.delete(key); },
  async list({ prefix }) { return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix || "")).map((name) => ({ name })) }; },
};
let worker;
let fakeIp = "203.0.113.1";
const relayServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    headers.set("CF-Connecting-IP", fakeIp);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request("http://127.0.0.1:" + RELAY + req.url, { method: req.method, headers, body: req.method === "GET" ? undefined : body }), { PB: KV });
    const out = Buffer.from(await r.arrayBuffer());
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h); res.end(out);
  });
});

// --- small http helpers ----------------------------------------------------------------
function call(port, method, p, body, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let data = null; const headers = {};
    if (body instanceof Buffer) { data = body; headers["Content-Type"] = opts.type; }
    else if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); headers["Content-Type"] = "application/json"; }
    if (data) headers["Content-Length"] = data.length;
    if (opts.bearer) headers.Authorization = "Bearer " + opts.bearer;
    const req = http.request({ host: opts.host || "127.0.0.1", localAddress: opts.from, port, path: p, method, headers }, (r) => {
      const c = []; r.on("data", (x) => c.push(x));
      r.on("end", () => { const b = Buffer.concat(c); let j = null; try { j = JSON.parse(b.toString()); } catch (e) { /* not json */ } resolve({ status: r.statusCode, json: j || {}, body: b, headers: r.headers }); });
    });
    req.on("error", (e) => resolve({ status: 0, json: { error: e.message }, body: Buffer.alloc(0) }));
    if (data) req.write(data);
    req.end();
  });
}
const web = (m, p, b, o) => call(WEB, m, p, b, o);
const relay = (m, p, b, o) => call(RELAY, m, p, b, o);

// What relay/app.js does in the browser: lock the file, then send it as a form.
async function lockFile(name, data, publicKey) {
  const subtle = crypto.webcrypto.subtle;
  const pub = await subtle.importKey("spki", Buffer.from(publicKey, "base64"), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const header = Buffer.from(JSON.stringify({ name, type: "application/pdf", size: data.length }));
  const plain = Buffer.alloc(4 + header.length + data.length);
  plain.writeUInt32BE(header.length, 0); header.copy(plain, 4); data.copy(plain, 4 + header.length);
  const iv = crypto.randomBytes(12);
  const raw = await subtle.exportKey("raw", aes);
  const key = Buffer.from(await subtle.encrypt({ name: "RSA-OAEP" }, pub, raw)).toString("base64");
  const locked = Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv }, aes, plain));
  return { key, iv: iv.toString("base64"), data: locked };
}
async function send(code, printer, name, data, publicKey, extra) {
  const l = await lockFile(name, data, publicKey);
  const form = new FormData();
  const fields = Object.assign({ code, printer, copies: "2", color: "monochrome", sides: "two-sided-long-edge", name, iv: l.iv, key: l.key }, extra || {});
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", new Blob([l.data], { type: "application/octet-stream" }), "locked.bin");
  const r = new Response(form);
  const body = Buffer.from(await r.arrayBuffer());
  const res = await relay("POST", "/api/send", body, { type: r.headers.get("content-type") });
  res.locked = l.data;
  return res;
}
const relayStatus = async (id, code) => (await relay("POST", "/api/status", { id, code })).json.status;
const pdf = (text) => Buffer.from("%PDF-1.4\n% " + text + "\n" + crypto.randomBytes(2000).toString("hex") + "\n%%EOF\n");

// --- the main computer and a stand-in printer computer --------------------------------------
function startWebsite() {
  const p = fork(path.join(ROOT, "server", "server.js"), [], {
    silent: true,
    env: Object.assign({}, process.env, { NODE_PATH, PORT: String(WEB), PRINT_DATA_DIR: dir, PRINT_UPLOAD_DIR: path.join(dir, "up"), NO_DISCOVERY: "1", OP_REMOTE_POLL_MS: "700" }),
  });
  p.out = ""; p.stdout.on("data", (d) => { p.out += d; }); p.stderr.on("data", (d) => { p.out += d; });
  procs.push(p); return p;
}
const printed = []; // { job, options, data }
let agentSocket = null;
function startAgent(token) {
  const ws = new WebSocket("ws://127.0.0.1:" + WEB + "/agent");
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, agentName: "FRONT-PC", platform: "linux", version: "test",
    printers: [{ name: "Front desk" }, { name: "Back office" }] })));
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== "job") return;
    ws.send(JSON.stringify({ type: "status", jobId: m.jobId, status: "printing" }));
    const f = await web("GET", m.fileUrl, undefined, { bearer: token });
    printed.push({ job: m, data: f.body });
    await sleep(300);
    ws.send(JSON.stringify({ type: "status", jobId: m.jobId, status: "done" }));
  });
  ws.on("error", () => {});
  agentSocket = ws;
  return ws;
}

(async () => {
  // The drop page, built the way it is pasted into Cloudflare.
  const built = path.join(dir, "worker.mjs");
  execFileSync(process.execPath, [path.join(ROOT, "relay", "build.js"), "TEST-PAIR-CODE"], { env: Object.assign({}, process.env, { OUT: built }) });
  worker = (await import("file://" + built)).default;
  await new Promise((r) => relayServer.listen(RELAY, "127.0.0.1", r));
  const page = await relay("GET", "/");
  ok(page.status === 200 && /Print to the office/.test(page.body) && /script-src 'self'/.test(page.headers["content-security-policy"]) && !/__PAGE__|__APP__|__CLAIM_CODE__/.test(fs.readFileSync(built, "utf8")),
    "the built drop page serves its page with a strict content policy, and nothing is left unfilled");
  ok((await relay("GET", "/app.js")).status === 200 && (await relay("GET", "/api/info")).json.ready === false, "its script loads, and before pairing it says it isn't ready");

  let site = startWebsite();
  ok(await waitFor(async () => (await web("GET", "/api/remote")).status === 200, 20000), "the main computer's website is up");
  const comp = await web("POST", "/api/manage/computers", { name: "FRONT-PC" });
  startAgent(comp.json.token);
  ok(await waitFor(async () => (await web("GET", "/api/remote")).json.printers.length === 2, 10000), "a printer computer with two printers is online");

  // --- pairing -----------------------------------------------------------------------------
  let r = await web("POST", "/api/remote/connect", { relayUrl: "http://127.0.0.1:" + RELAY, claim: "WRONG-CODE-0000" });
  ok(r.status === 400 && /pairing code/i.test(r.json.error) && !(await web("GET", "/api/remote")).json.connected, "a wrong pairing code is refused and nothing is saved");
  r = await web("POST", "/api/remote/connect", { relayUrl: "http://printbridge.example.com", claim: "TEST-PAIR-CODE" });
  ok(r.status >= 400 && /https/.test(r.json.error), "a drop page address without https is refused");
  r = await web("POST", "/api/remote/connect", { relayUrl: "http://127.0.0.1:" + RELAY, claim: "test pair code" });
  ok(r.status === 200, "the right pairing code connects (typed in small letters with spaces)");
  let st = (await web("GET", "/api/remote")).json;
  ok(st.connected && st.local && kv.has("office") && kv.has("config"), "the main computer is connected and the page has its config");
  const savedState = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
  ok(/BEGIN PRIVATE KEY/.test(savedState.privateKey) && !JSON.stringify([...kv.values()].map(String)).includes("PRIVATE KEY"), "the private key stays on the main computer (it is not on the page)");
  const stranger = await call(RELAY, "POST", "/office/claim", { claim: "TEST-PAIR-CODE", token: "x".repeat(40) });
  ok(stranger.status === 409, "once paired, the pairing code can't be used again by someone else");
  ok((await relay("GET", "/office/queue")).status === 401 && (await call(RELAY, "GET", "/office/queue", undefined, {})).status === 401, "the office side of the page refuses anyone without the office's secret");

  // --- managing people is only for the main computer itself --------------------------------------
  // "Another computer on the network": this machine's own network address
  // (not 127.0.0.1), so the website sees the request as coming from outside.
  const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal);
  const lan = { host: lanIp ? lanIp.address : "127.0.0.1" };
  if (!lanIp) console.log("  (no network card: skipping the other-computer checks)");
  if (lanIp) ok((await call(WEB, "POST", "/api/remote/people", { name: "Guest" }, lan)).status === 403, "from another computer on the network, adding a person is refused");
  if (lanIp) ok((await call(WEB, "POST", "/api/remote/connect", { relayUrl: "http://127.0.0.1:" + RELAY, claim: "x" }, lan)).status === 403, "...and so is connecting the page");
  const lanView = (await call(WEB, "GET", "/api/remote", undefined, lan)).json;
  if (lanIp) ok(lanView.local === false && lanView.people === undefined && lanView.log === undefined, "...and it isn't shown the people or the log");

  r = await web("POST", "/api/remote/people", { name: "Amara", printers: ["Front desk"], dailyLimit: 3 });
  const amara = r.json.person, amaraCode = r.json.code;
  ok(/^PB-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(amaraCode) && amara.hint === amaraCode.slice(-4), "adding a person gives a code like PB-XXXX-XXXX-XXXX, once");
  ok(!fs.readFileSync(path.join(dir, "remote.json"), "utf8").includes(amaraCode) && !JSON.stringify([...kv.values()].map(String)).includes(amaraCode.replace(/-/g, "").slice(2)),
    "the code itself is kept neither on the main computer nor on the page (only its fingerprint)");
  r = await web("POST", "/api/remote/people", { name: "Kasun", hold: true });
  const kasun = r.json.person, kasunCode = r.json.code;

  // --- the code ------------------------------------------------------------------------------------
  r = await relay("POST", "/api/code", { code: amaraCode.toLowerCase().replace(/-/g, " ") });
  ok(r.status === 200 && r.json.name === "Amara" && r.json.printers.join() === "Front desk" && r.json.left === 3 && r.json.publicKey === savedState.publicKey,
    "the right code (typed any old way) shows only her printers, her limit and the office's key");
  ok((await relay("POST", "/api/code", { code: kasunCode })).json.printers.length === 2, "someone with no printers chosen gets them all");
  fakeIp = "203.0.113.50";
  for (let i = 0; i < 10; i++) r = await relay("POST", "/api/code", { code: "PB-AAAA-BBBB-" + (2222 + i) });
  ok(r.status === 403, "a wrong code is refused");
  r = await relay("POST", "/api/code", { code: amaraCode });
  ok(r.status === 429, "after 10 wrong codes from one address, even the right code waits 15 minutes");
  fakeIp = "203.0.113.1";

  // --- sending and printing --------------------------------------------------------------------------
  const doc1 = pdf("first");
  r = await send(amaraCode, "Back office", "a.pdf", doc1, savedState.publicKey);
  ok(r.status === 400 && /isn't available to you/.test(r.json.error), "a printer that isn't hers is refused");
  r = await send(amaraCode, "Front desk", "evil.exe", doc1, savedState.publicKey);
  ok(r.status === 400, "a file type that can't be printed is refused");
  r = await send(amaraCode, "Front desk", "Invoice 12.pdf", doc1, savedState.publicKey);
  ok(r.status === 200 && /^[0-9a-f]{24}$/.test(r.json.id) && r.json.online === true, "a locked file is accepted, and the page says the office is online");
  const id1 = r.json.id;
  const stored = kv.get("blob:" + id1);
  ok(stored && !stored.includes(doc1.subarray(0, 200)) && !stored.includes(Buffer.from("Invoice")), "what the page keeps is locked: neither the file nor its name can be read from it");
  ok(await waitFor(() => printed.length === 1, 10000), "the main computer collects it and it prints");
  ok(printed[0].data.equals(doc1), "the printed file is exactly the one sent");
  ok(printed[0].job.printer === "Front desk" && printed[0].job.options.copies === 2 && printed[0].job.options.sides === "two-sided-long-edge", "on her printer, with her copies and both sides");
  ok(await waitFor(async () => (await relayStatus(id1, amaraCode)) === "done", 10000), "the sender's page then shows Printed");
  ok(!kv.has("blob:" + id1) && !kv.has("job:" + id1) && !(await KV.get("queue", "json")).includes(id1), "once collected, the file is gone from the page");
  ok((await relay("POST", "/api/status", { id: id1, code: kasunCode })).status === 404, "someone else's code can't see what happened to it");
  st = (await web("GET", "/api/remote")).json;
  ok(st.log[0].person === "Amara" && st.log[0].result === "done" && st.log[0].fileName === "Invoice 12.pdf", "the main computer's log shows who printed what, and that it printed");

  // --- the daily limit -----------------------------------------------------------------------------------
  await send(amaraCode, "Front desk", "b.pdf", pdf("b"), savedState.publicKey);
  await send(amaraCode, "Front desk", "c.pdf", pdf("c"), savedState.publicKey);
  r = await send(amaraCode, "Front desk", "d.pdf", pdf("d"), savedState.publicKey);
  ok(r.status === 429 && /limit of 3/.test(r.json.error), "the 4th printout of the day is refused (limit 3)");
  ok((await relay("POST", "/api/code", { code: amaraCode })).json.left === 0, "and the page shows none left today");
  ok(await waitFor(() => printed.length === 3, 10000), "the two within the limit print");

  // --- hold for approval -----------------------------------------------------------------------------------
  const doc2 = pdf("held");
  r = await send(kasunCode, "Back office", "contract.pdf", doc2, savedState.publicKey);
  const id2 = r.json.id;
  ok(await waitFor(async () => (await relayStatus(id2, kasunCode)) === "held", 10000), "someone set to \"ask first\": the page shows Waiting for approval");
  ok(printed.length === 3, "...and nothing prints yet");
  const lanPending = (await call(WEB, "GET", "/api/remote", undefined, lan)).json.pending;
  ok(lanPending.length === 1 && lanPending[0].fileName === "contract.pdf", "the waiting printout is shown on the setup page, also from other office computers");
  r = await call(WEB, "POST", "/api/remote/pending/" + id2 + "/approve", { printer: "Front desk" }, lan);
  ok(r.status === 200 && await waitFor(() => printed.length === 4, 10000) && printed[3].data.equals(doc2) && printed[3].job.printer === "Front desk", "pressing Print (on another printer) prints it there");
  ok(await waitFor(async () => (await relayStatus(id2, kasunCode)) === "done", 10000), "...and the sender sees Printed");
  r = await send(kasunCode, "Back office", "nope.pdf", pdf("nope"), savedState.publicKey);
  const id3 = r.json.id;
  await waitFor(async () => (await relayStatus(id3, kasunCode)) === "held", 10000);
  await web("POST", "/api/remote/pending/" + id3 + "/reject");
  ok(await waitFor(async () => (await relayStatus(id3, kasunCode)) === "rejected", 10000) && printed.length === 4 && (await web("GET", "/api/remote")).json.pending.length === 0,
    "pressing Don't print: it doesn't print and the sender is told");

  // --- switching off, new codes, removing --------------------------------------------------------------------
  await web("POST", "/api/remote/people/" + kasun.id, { active: false });
  ok((await relay("POST", "/api/code", { code: kasunCode })).status === 403, "a switched-off code stops working on the page straight away");
  await web("POST", "/api/remote/people/" + kasun.id, { active: true });
  ok((await relay("POST", "/api/code", { code: kasunCode })).status === 200, "switched on again, it works again");
  r = await web("POST", "/api/remote/people/" + kasun.id + "/new-code");
  ok(r.json.code !== kasunCode && (await relay("POST", "/api/code", { code: kasunCode })).status === 403 && (await relay("POST", "/api/code", { code: r.json.code })).status === 200,
    "a new code replaces the old one");
  const kasunCode2 = r.json.code;
  await web("DELETE", "/api/remote/people/" + kasun.id);
  ok((await relay("POST", "/api/code", { code: kasunCode2 })).status === 403, "a removed person's code stops working");

  // --- the main computer switched off -------------------------------------------------------------------------
  site.kill(); await sleep(500);
  kv.set("seen", Buffer.from(String(Date.now() - 30 * 60 * 1000))); // as if it went off half an hour ago
  await web("POST", "/api/remote/people", {}); // (nothing answers)
  const amaraNext = (await relay("POST", "/api/code", { code: amaraCode })).json;
  ok(amaraNext.online === false, "with the main computer off, the page says the office is offline");
  kv.delete("n:" + crypto.createHash("sha256").update(amaraCode.replace(/[^0-9A-Z]/g, "")).digest("hex") + ":" + new Date().toISOString().slice(0, 10));
  const doc3 = pdf("while off");
  r = await send(amaraCode, "Front desk", "while-off.pdf", doc3, savedState.publicKey);
  ok(r.status === 200 && r.json.online === false, "a file can still be sent: it waits on the page");
  site = startWebsite();
  await waitFor(async () => (await web("GET", "/api/remote")).status === 200, 20000);
  startAgent(comp.json.token); // (the printer computer reconnects by itself)
  ok(await waitFor(() => printed.length === 5, 25000) && printed[4].data.equals(doc3), "when the main computer is back on, it collects the waiting file and prints it");
  ok(await waitFor(async () => (await relayStatus(r.json.id, amaraCode)) === "done", 10000), "...and the sender sees Printed");

  // --- a broken file, and a page that forgot the office --------------------------------------------------------------
  const l = await lockFile("x.pdf", pdf("x"), savedState.publicKey);
  const bad = Buffer.from(l.data); bad[10] ^= 0xff;
  const id4 = "ab".repeat(12);
  kv.set("blob:" + id4, bad);
  kv.set("job:" + id4, Buffer.from(JSON.stringify({ id: id4, hash: amara && crypto.createHash("sha256").update(amaraCode.replace(/[^0-9A-Z]/g, "")).digest("hex"), personId: amara.id, person: "Amara",
    printer: "Front desk", copies: 1, color: "monochrome", sides: "one-sided", name: "x.pdf", iv: l.iv, key: l.key, size: bad.length, at: Date.now() })));
  kv.set("st:" + id4, Buffer.from(JSON.stringify({ status: "waiting", hash: "" })));
  kv.set("queue", Buffer.from(JSON.stringify([id4])));
  ok(await waitFor(async () => { const s = await KV.get("st:" + id4, "json"); return s && s.status === "failed"; }, 10000) && printed.length === 5,
    "a file changed on the way fails to unlock: it isn't printed and the sender is asked to send it again");

  kv.delete("office");
  ok(await waitFor(async () => /no longer recognises/.test((await web("GET", "/api/remote")).json.lastError || ""), 10000), "if the page no longer knows the office, the setup page says to connect it again");

  site.kill(); agentSocket.close(); relayServer.close();
  console.log(n + " checks passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  for (const p of procs) { console.error("--- website log ---\n" + p.out.split("\n").slice(-30).join("\n")); p.kill(); }
  process.exit(1);
});
