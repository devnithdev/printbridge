// Where everything lives on an installed computer.
//
// Windows:
//   C:\Program Files\Office Printing\     the program (read-only)
//     OfficePrinting.exe, SumatraPDF.exe
//   C:\ProgramData\Office Printing\       everything it saves
//
// macOS:
//   /Library/Application Support/PrintBridge/          the program (read-only)
//     PrintBridge                       the program (Intel or Apple Silicon, whichever fits this Mac)
//   /Library/Application Support/PrintBridge/data/      everything it saves
//   (kept under the same folder as the program, rather than in ~/Library,
//   because the background service runs as a LaunchDaemon - system-wide,
//   independent of who if anyone is signed in - and needs one shared place
//   regardless of which user is logged in; see setup-web.js and
//   installer-mac/postinstall for how it's kept readable/writable by
//   whoever is signed in too)
//
// Both keep, inside the data folder:
//     settings.json      what Setup was told (role, name, address)
//     status.json        what the background program is doing right now
//     website\           the list of printers and jobs (main computer only)
//     printer\           this computer's connection to the website
//     outbox\            where the "PrintBridge" printer drops each printout
//     install-record.json what Setup added (so uninstalling removes exactly that)
//     logs\              plain-text logs, for when something needs looking into
//
// Roles: "main" (runs the website), "printer" (shares its printers) and
// "client" (no printer of its own; only prints through the website).

const fs = require("fs");
const os = require("os");
const path = require("path");

const IS_WINDOWS = os.platform() === "win32";
const IS_MAC = os.platform() === "darwin";
const IS_PACKAGED = !!process.pkg;

const INSTALL_DIR = IS_PACKAGED ? path.dirname(process.execPath) : path.join(__dirname, "..");

const DATA_DIR =
  process.env.OP_DATA_DIR ||
  (IS_WINDOWS
    ? path.join(process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData", "Office Printing")
    : IS_MAC
    ? "/Library/Application Support/PrintBridge/data"
    : path.join(os.homedir(), ".office-printing"));

const P = {
  INSTALL_DIR,
  DATA_DIR,
  SETTINGS_FILE: path.join(DATA_DIR, "settings.json"),
  STATUS_FILE: path.join(DATA_DIR, "status.json"),
  // Windows: the printouts part, run for whoever is signed in (see supervisor.js).
  SIGNIN_STATUS_FILE: path.join(DATA_DIR, "status-signin.json"),
  WEBSITE_DIR: path.join(DATA_DIR, "website"),
  UPLOAD_DIR: path.join(DATA_DIR, "website", "uploads"),
  PRINTER_DIR: path.join(DATA_DIR, "printer"),
  OUTBOX_DIR: path.join(DATA_DIR, "outbox"),
  RECORD_FILE: path.join(DATA_DIR, "install-record.json"),
  LOG_DIR: path.join(DATA_DIR, "logs"),
  // How the program starts itself again. Plain `node main.js` and the
  // packaged .exe/mac binary both work this way (see pkg's notes on child
  // processes).
  ENTRY: process.argv[1],
  IS_WINDOWS,
  IS_MAC,
  IS_PACKAGED,
  PORT: 3000,
  LOCK_PORT: parseInt(process.env.OP_LOCK_PORT, 10) || 39271,
  // Only used on macOS - see setup-web.js.
  SETUP_WEB_PORT: parseInt(process.env.OP_SETUP_PORT, 10) || 39273,
  // Only used on macOS: where printouts arrive from the "PrintBridge"
  // printer. Listened to on 127.0.0.1 only - see vprinter.mac.js.
  PRINT_PORT: parseInt(process.env.OP_PRINT_PORT, 10) || 39274,
  // One "sign-in" part (printouts from the PrintBridge printer) per
  // computer, separate from the background parts above - see supervisor.js.
  OUTBOX_LOCK_PORT: parseInt(process.env.OP_OUTBOX_LOCK_PORT, 10) || 39275,
  // Where the main computer answers "where is the printing website?" on the
  // office network (UDP) - see agent/lib/find.js.
  DISCOVERY_PORT: parseInt(process.env.OP_DISCOVERY_PORT, 10) || 39276,
  // Windows only: the task that starts the background parts when Windows
  // starts, before anyone signs in - see service.js.
  TASK_NAME: "Office Printing",
};

function ensureDirs() {
  for (const dir of [P.DATA_DIR, P.WEBSITE_DIR, P.UPLOAD_DIR, P.PRINTER_DIR, P.OUTBOX_DIR, P.LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const ROLES = new Set(["main", "printer", "client"]);

// Settings files are saved with a flushed backup copy (see durable.js), so a
// power cut while one is being written can't leave this computer looking
// as if it had never been set up.
const durable = require("../../agent/lib/durable");

function readSettings() {
  const s = durable.readJson(P.SETTINGS_FILE);
  if (s && typeof s === "object") {
    return {
      role: ROLES.has(s.role) ? s.role : "printer",
      name: String(s.name || "").trim().slice(0, 60) || os.hostname(),
      server: String(s.server || "").trim(),
    };
  }
  return { role: "printer", name: os.hostname(), server: "" };
}

// True when this computer has saved settings (or their backup copy).
function isConfigured() {
  return !!durable.whichCopy(P.SETTINGS_FILE);
}

function writeSettings(settings) {
  ensureDirs();
  durable.writeJson(P.SETTINGS_FILE, settings);
}

function readJson(file) {
  return durable.readJson(file);
}

function writeJson(file, value) {
  durable.writeJson(file, value);
}

function removeJson(file) {
  durable.removeJson(file);
}

// What Setup added to this computer, beyond its own files: the
// "PrintBridge" printer, LibreOffice (only if Setup installed it), old
// folders it replaced (Windows only). Uninstalling reads this to remove
// exactly those things.
function readRecord() {
  return readJson(P.RECORD_FILE) || {};
}

function updateRecord(changes) {
  ensureDirs();
  const record = Object.assign(readRecord(), changes);
  durable.writeJson(P.RECORD_FILE, record);
  return record;
}

module.exports = Object.assign(P, { ensureDirs, readSettings, isConfigured, writeSettings, readJson, writeJson, removeJson, readRecord, updateRecord, ROLES });
