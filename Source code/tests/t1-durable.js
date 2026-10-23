const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbt-"));
process.env.OP_DATA_DIR = dir;
const R = require("path").join(__dirname, "..");
const durable = require(R + "/agent/lib/durable");
const P = require(R + "/desktop/lib/paths");
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };

// write/read + backup
const f = path.join(dir, "x.json");
durable.writeJson(f, { a: 1 });
ok(fs.existsSync(f) && fs.existsSync(f + ".bak") && !fs.existsSync(f + ".tmp"), "writes file and backup, no temp left");
ok(durable.readJson(f).a === 1, "reads it back");
// simulate the power-cut damage: zero bytes / NULs / empty
fs.writeFileSync(f, Buffer.alloc(40)); ok(durable.readJson(f).a === 1, "all-zero file -> backup copy used");
fs.writeFileSync(f, ""); ok(durable.readJson(f).a === 1, "empty file -> backup copy used");
fs.writeFileSync(f, '{"a":'); ok(durable.readJson(f).a === 1, "half-written file -> backup copy used");
fs.rmSync(f); ok(durable.readJson(f).a === 1, "missing file -> backup copy used");
ok(durable.whichCopy(f) === "backup", "whichCopy says backup");
durable.removeJson(f); ok(durable.readJson(f) === null && !fs.existsSync(f + ".bak"), "removeJson removes both, nothing comes back");

// settings
P.writeSettings({ role: "client", name: "Front desk", server: "192.168.1.20" });
ok(P.readSettings().role === "client" && P.readSettings().server === "192.168.1.20", "settings saved");
fs.writeFileSync(P.SETTINGS_FILE, Buffer.alloc(100));
const s = P.readSettings();
ok(s.role === "client" && s.server === "192.168.1.20" && s.name === "Front desk", "settings.json wiped by a power cut -> still a client with its address (from backup)");
ok(P.isConfigured(), "still counts as set up");
fs.rmSync(P.SETTINGS_FILE); fs.rmSync(P.SETTINGS_FILE + ".bak");
ok(!P.isConfigured() && P.readSettings().role === "printer", "with no copy at all: not set up, default role as before");
// record
P.updateRecord({ startupTask: true }); P.updateRecord({ brand: "PrintBridge" });
ok(P.readRecord().startupTask === true && P.readRecord().brand === "PrintBridge", "install record merges and is durable");
console.log(n + " checks passed");
