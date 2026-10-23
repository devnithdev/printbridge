// Runs automatic updates the way the background program does, for
// t10-updates.js (one fresh process per case). "ask" = as if "Update
// PrintBridge now" was chosen.
const path = require("path");
const u = require(path.join(__dirname, "..", "..", "desktop", "lib", "updater"));
const h = u.start({ mode: "all" });
console.log("START " + h.checkNow.toString().length);
if (process.argv[2] === "ask") console.log("ASKED " + h.checkNow());
setTimeout(() => process.exit(0), parseInt(process.argv[3] || "20000", 10));
