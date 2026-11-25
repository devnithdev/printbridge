// An update must never put printer settings back to nothing. Two protections:
//  1. a saved printer list that can't be opened right now (permission, in use) is NOT treated
//     as damaged: the website stops and starts again later, and the file is left exactly as it was;
//  2. the choices made on Printers & setup are also kept by computer name + printer name, so even
//     a lost list, or a computer registering anew with a new id, gets them back.
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), { spawnSync } = require("child_process");
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const S = path.join(__dirname, "..", "server");

// --- 1. an unreadable list is left alone
const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "pbk-"));
const real = JSON.stringify({ serverId: "srv_0123456789abcdef01", agents: [{ id: "agt_1", name: "Front", tokenHash: "x" }], printers: [{ id: "agt_1::Office", agentId: "agt_1", name: "Office", hidden: true }], jobs: [], helpAlerts: [] });
fs.writeFileSync(path.join(dir1, "db.json"), real);
fs.writeFileSync(path.join(dir1, "db.json.bak"), real);
// a program that makes opening db.json fail the way a permission problem or a busy file does
const block = path.join(dir1, "block.js");
fs.writeFileSync(block, `const fs = require("fs"); const rf = fs.readFileSync;
fs.readFileSync = function (p, ...a) { if (/db\\.json(\\.bak)?$/.test(String(p))) { const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e; } return rf.call(this, p, ...a); };`);
const env = Object.assign({}, process.env, { PRINT_DATA_DIR: dir1, PRINT_LOAD_TRIES: "3", PRINT_LOAD_WAIT_MS: "20" });
const r = spawnSync(process.execPath, ["-r", block, "-e", `require(${JSON.stringify(S + "/lib/store")}); console.log("STARTED")`], { env, encoding: "utf8" });
ok(r.status === 1 && !/STARTED/.test(r.stdout), "a list that can't be opened stops the website (it is started again shortly), it does not start empty");
ok(fs.readFileSync(path.join(dir1, "db.json"), "utf8") === real && fs.readFileSync(path.join(dir1, "db.json.bak"), "utf8") === real, "...and the saved list is left exactly as it was");
ok(!fs.readdirSync(dir1).some((f) => f.includes("damaged")), "...not set aside as damaged");
// the same list opens normally once it can be read
const r2 = spawnSync(process.execPath, ["-e", `const {db}=require(${JSON.stringify(S + "/lib/store")}); console.log("PRINTERS", db.printers.length, db.printers[0].hidden)`], { env: Object.assign({}, env, { PRINT_LOAD_TRIES: "1" }), encoding: "utf8" });
ok(/PRINTERS 1 true/.test(r2.stdout), "...and when it can be read again, everything is still there");
// really damaged (not just unreadable) still starts fresh and keeps the damaged copy
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pbk-"));
fs.writeFileSync(path.join(dir2, "db.json"), "{bad"); fs.writeFileSync(path.join(dir2, "db.json.bak"), "{bad");
const r3 = spawnSync(process.execPath, ["-e", `const {db}=require(${JSON.stringify(S + "/lib/store")}); console.log("PRINTERS", db.printers.length)`], { env: Object.assign({}, process.env, { PRINT_DATA_DIR: dir2 }), encoding: "utf8" });
ok(/PRINTERS 0/.test(r3.stdout) && fs.readdirSync(dir2).some((f) => f.startsWith("db.json.damaged-")), "a list that is really damaged still starts fresh, keeping the damaged copy");

// --- 2. settings kept by computer and printer name
const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "pbk-"));
process.env.PRINT_DATA_DIR = dir3;
const { db } = require(S + "/lib/store");
const agents = require(S + "/lib/agents");
const caps = { color: true, duplex: true, paperSizes: ["A4"], defaultPaper: "A4" };
db.agents.push({ id: "agt_old", name: "Front desk PC", tokenHash: "h1" });
agents.rememberPrinters(db.agents[0], [{ name: "HP LaserJet P1102", capabilities: caps }, { name: "EPSON LQ-310", capabilities: caps }]);
const hp = db.printers.find((p) => p.name === "HP LaserJet P1102"), epson = db.printers.find((p) => p.name === "EPSON LQ-310");
agents.setColorMode(hp, "mono");
agents.setDuplexMode(hp, "hand");
agents.setDisplayName(hp, "Front desk laser");
agents.setPrinterType(epson, "dotmatrix");
epson.hidden = true; agents.persistSettings();
ok(fs.existsSync(path.join(dir3, "printer-settings.json")), "choices made on Printers & setup are also written to a file of their own");

// the whole list is lost, and the computer registers again with a brand new id
db.printers.length = 0; db.agents.length = 0; delete db.printerSettings;
db.agents.push({ id: "agt_NEW", name: "Front desk PC", tokenHash: "h2" });
agents.rememberPrinters(db.agents[0], [{ name: "HP LaserJet P1102", capabilities: caps }, { name: "EPSON LQ-310", capabilities: caps }]);
const hp2 = db.printers.find((p) => p.name === "HP LaserJet P1102"), epson2 = db.printers.find((p) => p.name === "EPSON LQ-310");
ok(hp2.id.startsWith("agt_NEW") && hp2.colorMode === "mono" && hp2.duplexMode === "hand" && hp2.displayName === "Front desk laser", "after a lost list and a new computer id, colour, both sides and the rename come back");
ok(epson2.printerType === "dotmatrix" && epson2.hidden === true, "...and the printer type and hidden too");

// a different computer with the same printer name is a different printer
db.agents.push({ id: "agt_other", name: "Back office PC", tokenHash: "h3" });
agents.rememberPrinters(db.agents[1], [{ name: "HP LaserJet P1102", capabilities: caps }]);
const other = db.printers.find((p) => p.agentId === "agt_other");
ok(other.colorMode === "auto" && !other.displayName, "...but only for that computer's printer: another computer's printer of the same name starts with nothing set");

// a computer arriving with nothing set must not wipe what was chosen
agents.rememberPrinters(db.agents[1], [{ name: "HP LaserJet P1102", capabilities: caps }]);
agents.persistSettings();
db.printers.length = 0; db.agents.length = 0;
db.agents.push({ id: "agt_3", name: "Front desk PC", tokenHash: "h4" });
agents.rememberPrinters(db.agents[0], [{ name: "HP LaserJet P1102", capabilities: caps }]);
ok(db.printers[0].displayName === "Front desk laser", "registering never wipes the kept choices");

// putting a choice back to its default is remembered too
agents.setColorMode(db.printers[0], "auto"); agents.setDuplexMode(db.printers[0], "auto"); agents.setDisplayName(db.printers[0], "");
db.printers.length = 0; db.agents.length = 0;
db.agents.push({ id: "agt_4", name: "Front desk PC", tokenHash: "h5" });
agents.rememberPrinters(db.agents[0], [{ name: "HP LaserJet P1102", capabilities: caps }]);
ok(db.printers[0].colorMode === "auto" && !db.printers[0].displayName, "a setting put back to automatic stays automatic");

console.log(n + " checks passed");
process.exit(0);
