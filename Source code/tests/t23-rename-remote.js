// A renamed printer: the drop page ("print from anywhere") shows and accepts the new name,
// a person whose allowed list was saved with the printer's own name can still print to it,
// and printers that are hidden or out of order are never picked.
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbr-"));
process.env.PRINT_DATA_DIR = dir;
process.env.PRINT_UPLOAD_DIR = path.join(dir, "u");
fs.mkdirSync(process.env.PRINT_UPLOAD_DIR);
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };

const S = path.join(__dirname, "..", "server");
const { db } = require(S + "/lib/store");
const agents = require(S + "/lib/agents");
const remote = require(S + "/lib/remote");

db.agents.push({ id: "a1", name: "Front", createdAt: 1 }, { id: "a2", name: "Back", createdAt: 2 });
const P = (id, agentId, name) => ({ id, agentId, name, hidden: false, capabilities: null });
db.printers.push(P("p1", "a1", "HP LaserJet P1102"), P("p2", "a2", "HP LaserJet P1102"), P("p3", "a2", "Canon LBP6230"));
remote.start({ file: path.join(dir, "remote.json"), uploadDir: path.join(dir, "u"), db });
remote.stop();

ok(remote.findPrinter("Canon LBP6230").id === "p3", "a printer is found by its own name");
ok(agents.setDisplayName(db.printers[2], "Front desk laser"), "it is renamed");
ok(remote.findPrinter("Front desk laser").id === "p3", "the drop page finds it by the new name");
ok(remote.findPrinter("Canon LBP6230").id === "p3", "...and a list saved with the old name still finds it");
ok(remote.status().printers.includes("Front desk laser") && !remote.status().printers.includes("Canon LBP6230"), "the people choosing printers are offered the new name, not the old");
ok(remote.findPrinter("HP LaserJet P1102").id === "p1", "two printers with one name: the one on the oldest computer wins, as before");

db.printers[2].broken = true;
ok(remote.findPrinter("Front desk laser") === null, "an out of order printer is not picked, by either name");
db.printers[2].broken = false; db.printers[2].hidden = true;
ok(remote.findPrinter("Canon LBP6230") === null, "a hidden printer is not picked");
db.printers[2].hidden = false;

ok(!agents.setDisplayName(db.printers[0], "front desk laser"), "no printer can take a name another one shows");
ok(!agents.setDisplayName(db.printers[0], "canon lbp6230"), "...or another printer's own name");
ok(agents.setDisplayName(db.printers[0], "HP LASERJET P1102") && !db.printers[0].displayName, "typing its own name again just clears the rename");

console.log(n + " checks passed");
process.exit(0);
