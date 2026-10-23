// Run by the uninstaller (Settings > Apps > PrintBridge > Uninstall)
// while the program is still there, to remove everything Setup added
// besides its own files:
//   - a printer computer tells the main computer it is leaving, so its
//     printers disappear from the list instead of showing as switched off,
//   - the "PrintBridge" printer,
//   - LibreOffice, only if this program's Setup installed it,
//   - the files of an older version that Setup replaced,
//   - the small report pages it put in the temp folder.
// The uninstaller itself removes the program, shortcuts, start-up entry,
// firewall rules and (unless asked to keep it) the saved information.

const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("./paths");

async function tellMainComputer() {
  const settings = P.readSettings();
  if (settings.role === "main") return;
  const config = P.readJson(path.join(P.PRINTER_DIR, "config.json"));
  if (!config || !config.token || !config.serverUrl) return;
  const { normalise, request } = require("./outbox");
  const base = normalise(config.serverUrl);
  const r = await request("POST", base + "/api/agent/leave", Buffer.from("{}"), 5000, {
    Authorization: "Bearer " + config.token,
    "Content-Type": "application/json",
  });
  if (r && r.status === 200) console.log("Told the main computer that this computer's printers are no longer shared.");
  else if (r && r.status === 404) console.log("The main computer had already forgotten this computer.");
  else console.log("Couldn't reach the main computer to say goodbye; its printers will show there as switched off until removed on Printers & setup.");
}

// The pages are written by the background program as whoever is signed in,
// so they are in each person's own temp folder - not only in the temp
// folder of whoever runs the uninstaller. Each "wasn't printed" page also
// has a name of its own (office-printing-not-sent-<time>.html).
function removeTempPages() {
  const dirs = new Set([os.tmpdir()]);
  if (P.IS_WINDOWS) {
    const users = path.join(process.env.SystemDrive || "C:", "\\", "Users");
    let people = [];
    try { people = fs.readdirSync(users); } catch (err) { /* only the one above */ }
    for (const person of people) dirs.add(path.join(users, person, "AppData", "Local", "Temp"));
  }
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (err) { continue; }
    for (const name of names) {
      if (!/^office-printing-(check|not-sent(-\d+)?)\.html$/.test(name)) continue;
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch (err) { /* fine */ }
    }
  }
}

async function run(options) {
  const keepLibreOffice = !!(options && options.keepLibreOffice);
  const steps = [
    ["removing the startup task", async () => (await require("./service").remove()).message],
    ["saying goodbye to the main computer", tellMainComputer],
    ["removing the printer", async () => (await require("./vprinter").remove()).message],
    ["removing LibreOffice", () => {
      // Only say anything if this Setup was ever the one that installed
      // it - otherwise (the ordinary case) there's nothing to report,
      // same as before this choice existed.
      if (!P.readRecord().libreofficeBySetup) return "";
      return keepLibreOffice
        ? "Kept LibreOffice, as chosen on the uninstall screen."
        : require("./libreoffice").removeIfInstalledBySetup();
    }],
    ["removing the older version's files", () => require("./oldsetup").removeReplacedCopies()],
    // A fixed network address Setup gave this computer goes back to automatic
    // (one set by hand is left alone - see fixip.js).
    ["setting the network address back to automatic", async () => (await require("./fixip").restore()).message],
    ["tidying up", removeTempPages],
  ];
  // Each step on its own: one failing never stops the others.
  for (const [what, step] of steps) {
    try {
      const out = await step();
      if (typeof out === "string" && out) console.log(out);
    } catch (err) {
      console.log("Problem while " + what + ": " + (err && err.message ? err.message : err));
    }
  }
}

module.exports = { run, tellMainComputer };
