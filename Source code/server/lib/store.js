// A very small "database".
//
// Everything is kept in one JSON file on disk (server/data/db.json) instead of
// only in memory, so printers and jobs survive a server restart.
// Later you can swap this file for SQLite or Postgres without touching the
// rest of the code, as long as you keep the same `db` shape.
//
// There are no user accounts here on purpose. Anyone on the office network
// can print, the same way anyone who can walk up to a printer can use it.
// A "device" is just a browser that has been here before, remembered by a
// cookie so we can label jobs and let people cancel their own.

const fs = require("fs");
const path = require("path");

// The installed Windows version keeps its data in C:\ProgramData\Office
// Printing (set through PRINT_DATA_DIR), because the program folder itself
// is read-only there. Run from source, it lives in server/data as before.
const DATA_DIR = process.env.PRINT_DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

const EMPTY = {
  agents: [],     // { id, name, tokenHash, platform, createdAt, lastSeenAt }
  printers: [],   // { id, agentId, name, capabilities, hidden, updatedAt }
  jobs: [],       // { id, deviceId, label, fileName, printerId, ... }
  helpAlerts: [], // { id, label, message, createdAt, resolved, resolvedAt }
};

fs.mkdirSync(DATA_DIR, { recursive: true });

// Saved safely: a flushed temporary copy is swapped in, and a backup copy
// is kept next to it, so a power cut can't wipe the list (see
// agent/lib/durable.js).
const durable = require("../../agent/lib/durable");
const ID_FILE = path.join(DATA_DIR, "website-id.json");

function writeFileSafely(file, text) {
  durable.writeText(file, text);
}

function load() {
  if (!fs.existsSync(DATA_FILE) && !fs.existsSync(DATA_FILE + ".bak")) {
    return JSON.parse(JSON.stringify(EMPTY)); // first run: nothing saved yet
  }
  const saved = durable.readJson(DATA_FILE); // falls back to the backup copy
  if (saved && typeof saved === "object") {
    return Object.assign(JSON.parse(JSON.stringify(EMPTY)), saved);
  }
  // Both copies are damaged (very unlikely now). Start fresh so printing
  // keeps working, but keep the damaged copy instead of overwriting it, in
  // case anything in it is ever needed.
  const aside = DATA_FILE + ".damaged-" + Date.now();
  try {
    fs.renameSync(DATA_FILE, aside);
  } catch (renameErr) {
    // Couldn't move it; starting fresh still beats not starting at all.
  }
  console.log("");
  console.log("  The saved printer list was damaged, so it has been set aside");
  console.log("  (" + path.basename(aside) + ") and printing is starting fresh.");
  console.log("  Printer computers connect again by themselves.");
  console.log("");
  return JSON.parse(JSON.stringify(EMPTY));
}

const db = load();

// A permanent id for this printing website. Printer computers remember it,
// so if the main computer's network address ever changes they can search
// the network and recognise it again, instead of needing to be set up anew.
// Also kept in a file of its own, so that even if the list above ever had
// to start fresh, this stays the same website to everyone else.
{
  const kept = durable.readJson(ID_FILE);
  const keptId = kept && typeof kept.id === "string" && /^srv_[a-f0-9]{6,40}$/.test(kept.id) ? kept.id : "";
  if (!db.serverId) db.serverId = keptId || "srv_" + require("crypto").randomBytes(9).toString("hex");
  try {
    if (keptId !== db.serverId) durable.writeJson(ID_FILE, { id: db.serverId });
    if (!saved()) writeFileSafely(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.log("Could not save the website's id yet: " + err.message);
  }
}

function saved() {
  const onDisk = durable.readJson(DATA_FILE);
  return !!(onDisk && onDisk.serverId === db.serverId);
}

let saveTimer = null;

// Write the file at most once every 200ms, so a busy moment doesn't
// hammer the disk. The write is "atomic": we write a temp file first and
// then rename it, so a crash can never leave a half-written db.json.
function saveNow() {
  saveTimer = null;
  try {
    writeFileSafely(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    // Never let a failed save stop the website; try again in a few seconds.
    console.log("Could not save the printer list (" + err.message + "). Trying again shortly.");
    if (!saveTimer) saveTimer = setTimeout(saveNow, 5000);
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 200);
}

// Make sure nothing is lost when the server is stopped.
process.on("exit", () => {
  if (saveTimer) saveNow();
});

// "exit" does not run when the process is killed by a signal, and closing
// the Terminal window that runs the website sends one.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (saveTimer) saveNow();
    process.exit(0);
  });
}

module.exports = { db, save, saveNow, DATA_FILE, ID_FILE };
