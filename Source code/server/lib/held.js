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
// "Print this?" screen (or in a bucket) has to be chosen again. Nothing is
// held for more than an hour: anything older is deleted.
//
// The bucket: a person can keep files here to print later, all at once. A
// bucket file is a held file marked with the device that put it there.

const fs = require("fs");
const crypto = require("crypto");

const MAX_AGE_MS = 60 * 60 * 1000;
const held = new Map(); // id -> { id, storedPath, originalName, size, createdAt, source, bucketOf }

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

// How many files are waiting right now (the website refuses more past MAX_HELD,
// so nobody can fill the disk with uploads that are never printed).
const MAX_HELD = 60;
function count() {
  return held.size;
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

// false when it is gone, or already in someone else's bucket.
function addToBucket(id, deviceId) {
  const entry = get(id);
  if (!entry || (entry.bucketOf && entry.bucketOf !== deviceId)) return false;
  // The bucket's hour starts when the file goes in, not when it was uploaded.
  if (!entry.bucketOf) entry.createdAt = Date.now();
  entry.bucketOf = deviceId;
  return true;
}

function bucketFor(deviceId) {
  return [...held.values()]
    .filter((e) => e.bucketOf === deviceId && fs.existsSync(e.storedPath))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function sweep() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const entry of [...held.values()]) {
    if (entry.createdAt < cutoff) discard(entry.id);
  }
}

module.exports = { create, get, take, discard, sweep, addToBucket, bucketFor, count, MAX_HELD, MAX_AGE_MS };
