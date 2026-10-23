// Stand-in for an installer in t10-updates.js.
//   node fake-install.js <installer file>
// The "installer" is a JSON file: { version, broken, fail }. Like the real
// ones, it stops the running program, replaces the installed program file
// and starts the new one.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const status = path.join(process.env.OP_DATA_DIR, "status.json");
const installed = process.env.OP_UPDATE_INSTALLED_BIN;

try { process.kill(parseInt(fs.readFileSync(status + ".pid", "utf8"), 10)); } catch (err) { /* not running */ }
fs.appendFileSync(process.env.OP_DATA_DIR + "/installer-runs.txt", spec.version + "\n");
if (spec.fail) process.exit(4); // like Setup's "couldn't replace the program" (left as it was)
fs.writeFileSync(installed, "program " + spec.version);
const child = spawn(process.execPath, [path.join(__dirname, "fake-sup.js"), status, spec.version].concat(spec.broken ? ["broken"] : []),
  { detached: true, stdio: "ignore" });
child.unref();
