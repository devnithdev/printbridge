// Fixes from the second full check: a file named .pdf must really be a PDF, only so many files can wait at once,
// a printout from a program that is too big says so, an unanswered call for help goes after an hour, people's
// "print from anywhere" lists follow a printer that is renamed, and the queue shows the printer's name as it is now.
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), http = require("http"), { fork } = require("child_process");
const ROOT = path.join(__dirname, "..");
const NODE_PATH = [path.join(ROOT, "agent", "node_modules"), path.join(ROOT, "server", "node_modules"), process.env.NODE_PATH || ""].join(path.delimiter);
const PORT = 3725;
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- in-process: help alerts, rename in people's lists, queue label
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "pbf-"));
process.env.PRINT_DATA_DIR = dirA;
process.env.PRINT_UPLOAD_DIR = path.join(dirA, "u");
fs.mkdirSync(process.env.PRINT_UPLOAD_DIR);
const S = path.join(ROOT, "server");
const { db } = require(S + "/lib/store");
const agents = require(S + "/lib/agents");
const jobs = require(S + "/lib/jobs");
const help = require(S + "/lib/help");
const remote = require(S + "/lib/remote");

db.helpAlerts.push({ id: "old", label: "x", message: "", createdAt: Date.now() - 61 * 60 * 1000, resolved: false }, { id: "new", label: "y", message: "", createdAt: Date.now() - 5 * 60 * 1000, resolved: false });
ok(help.listOpen().map((a) => a.id).join() === "new", "a call for help nobody answered goes after an hour");

db.agents.push({ id: "a1", name: "Front", createdAt: 1 });
db.printers.push({ id: "p1", agentId: "a1", name: "Canon LBP6230", hidden: false, capabilities: null });
agents.isOnline = () => false;
agents.sendToAgent = () => true;
const job = jobs.createJob({ deviceId: "dev_aaaaaaaa", label: "x", file: { originalName: "a.pdf", storedPath: path.join(dirA, "u", "a.pdf") }, printer: db.printers[0], options: {} });
ok(jobs.listActiveQueue("dev_aaaaaaaa")[0].printerName === "Canon LBP6230", "the queue shows the printer's name");
agents.setDisplayName(db.printers[0], "Front desk laser");
ok(jobs.listActiveQueue("dev_aaaaaaaa")[0].printerName === "Front desk laser", "...and the new name as soon as it is renamed, for jobs already waiting");

const stateFile = path.join(dirA, "remote.json");
fs.writeFileSync(stateFile, JSON.stringify({ people: [{ id: "pe1", name: "Amara", printers: ["Front desk laser", "Other"], codeHash: "h", active: true }], pending: [{ relayId: "r1", fileName: "x.pdf", filePath: path.join(dirA, "x.pdf"), printer: "Front desk laser", heldAt: Date.now() }], log: [] }));
remote.start({ file: stateFile, uploadDir: path.join(dirA, "u"), db });
remote.stop();

(async () => {
  await remote.renamePrinter("Front desk laser", "Reception");
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  ok(saved.people[0].printers.join() === "Reception,Other" && saved.pending[0].printer === "Reception", "people's saved printer lists, and printouts waiting for approval, follow a renamed printer");
  await remote.renamePrinter("Nothing", "Else"); // a name nobody has: nothing changes, no crash

  // ---- a real website: fake PDFs, the cap on waiting files, an oversize printout
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "pbf-"));
  const web = fork(path.join(S, "server.js"), [], {
    silent: true,
    env: Object.assign({}, process.env, { NODE_PATH, PORT: String(PORT), PRINT_DATA_DIR: dirB, PRINT_UPLOAD_DIR: path.join(dirB, "up"), NO_DISCOVERY: "1", MAX_UPLOAD_MB: "1" }),
  });
  try {
    const up = (name, body) => {
      const form = new FormData();
      form.append("file", new Blob([body], { type: "application/pdf" }), name);
      return fetch("http://127.0.0.1:" + PORT + "/api/uploads", { method: "POST", body: form });
    };
    for (let i = 0; i < 50; i++) { try { await fetch("http://127.0.0.1:" + PORT + "/api/office-printing"); break; } catch (e) { await sleep(200); } }
    const fake = await up("report.pdf", "<html><body>Not a PDF</body></html>");
    ok(fake.status === 400 && /real PDF/.test(await fake.text()), "a file named .pdf that isn't a PDF is refused");
    const good = await up("report.pdf", "%PDF-1.4\n%%EOF\n");
    ok(good.status === 200, "a real PDF is taken");
    let last = 200;
    for (let i = 0; i < 60; i++) last = (await up("f" + i + ".pdf", "%PDF-1.4\n%%EOF\n")).status;
    ok(last === 429, "only so many files can wait at once; the next one is told to try again later");
    const big = await fetch("http://127.0.0.1:" + PORT + "/api/uploads/printout?name=big", { method: "POST", headers: { "content-type": "application/pdf" }, body: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2 * 1024 * 1024)]) });
    ok(big.status === 413 && /bigger than 1 MB/.test(await big.text()), "a printout from a program that is too big says so (413), not 'reload the page'");
  } finally {
    web.kill();
  }
  console.log(n + " checks passed");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
