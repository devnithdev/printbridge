// Files waiting on the "Print this?" screen.
//
// A dropped file is uploaded (and turned into a PDF if needed) as soon as
// it is chosen, so the page can show a preview before anything is printed.
// The same happens to a printout sent to the "PrintBridge" printer from
// Excel, Word or any other program. Until someone presses Print, the file is
// "held" here. Its id is long and random, so only the page it was made for
// can see it.
//
// Held files live in memory: if the website restarts, anything still on a
// "Print this?" screen has to be chosen again. Nobody waits more than a
// few hours, so anything older is deleted.

const fs = require("fs");
const crypto = require("crypto");

const MAX_AGE_MS = 3 * 60 * 60 * 1000;
const held = new Map(); // id -> { id, storedPath, originalName, size, createdAt, source }

function create({ storedPath, originalName, size, source }) {
  const id = crypto.randomBytes(18).toString("hex");
  held.set(id, {
    id,
    storedPath,
    originalName: String(originalName || "Printout.pdf").slice(0, 200),
    size: size || 0,
    createdAt: Date.now(),
    source: source || "page",
  });
  return held.get(id);
}

function get(id) {
  const entry = held.get(String(id || ""));
  if (!entry) return null;
  if (!fs.existsSync(entry.storedPath)) {
    held.delete(entry.id);
    return null;
  }
  return entry;
}

// Hands the file over to a print job; it is no longer held.
function take(id) {
  const entry = get(id);
  if (entry) held.delete(entry.id);
  return entry;
}

function discard(id) {
  const entry = held.get(String(id || ""));
  if (!entry) return false;
  held.delete(entry.id);
  fs.unlink(entry.storedPath, () => {});
  return true;
}

function sweep() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const entry of [...held.values()]) {
    if (entry.createdAt < cutoff) discard(entry.id);
  }
}

function isHeldFile(fullPath) {
  for (const entry of held.values()) if (entry.storedPath === fullPath) return true;
  return false;
}

module.exports = { create, get, take, discard, sweep, isHeldFile };
