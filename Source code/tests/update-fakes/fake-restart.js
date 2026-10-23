// Stand-in for "start the background program again" after an update was
// undone (t10-updates.js): starts fake-sup.js with whatever version the
// installed program file now holds.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const status = path.join(process.env.OP_DATA_DIR, "status.json");
try { process.kill(parseInt(fs.readFileSync(status + ".pid", "utf8"), 10)); } catch (err) { /* not running */ }
const version = fs.readFileSync(process.env.OP_UPDATE_INSTALLED_BIN, "utf8").replace(/^program /, "").trim();
const child = spawn(process.execPath, [path.join(__dirname, "fake-sup.js"), status, version], { detached: true, stdio: "ignore" });
child.unref();
