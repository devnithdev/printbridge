// Saving small settings files so that a power cut can't wipe them out.
//
// A plain writeFileSync() leaves the new text in Windows' memory for a while
// before it reaches the disk. If the power goes off in that moment, the file
// can come back empty or full of zero bytes - and a computer that forgets
// its settings looks like one that was never set up. So:
//
//   1. the new text is written to a temporary file and flushed to the disk
//      (fsync) before anything else happens,
//   2. the temporary file is swapped in by renaming it (the old file stays
//      whole until that moment),
//   3. a second copy is kept next to it (".bak"), written the same way.
//
// readJson() reads the file and, if it is missing or damaged, the ".bak"
// copy. Removing a setting removes both (removeJson), so an old copy can
// never come back to life.

const fs = require("fs");
const path = require("path");

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeAndFlush(file, text) {
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, text);
    try { fs.fsyncSync(fd); } catch (err) { /* some drives can't; the rename below still helps */ }
  } finally {
    fs.closeSync(fd);
  }
}

// Makes the rename itself permanent too (not possible, nor needed, on Windows).
function flushFolder(dir) {
  if (process.platform === "win32") return;
  let fd = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (err) {
    /* best effort */
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (err) { /* fine */ }
  }
}

function replace(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeAndFlush(tmp, text);
  // On Windows the swap can fail for a moment while antivirus, search
  // indexing or backup software has the file open: try again briefly, and
  // as a last resort write the file directly (still flushed).
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.renameSync(tmp, file);
      flushFolder(path.dirname(file));
      return;
    } catch (err) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      pause(100);
    }
  }
  writeAndFlush(file, text);
  try { fs.unlinkSync(tmp); } catch (err) { /* harmless leftover */ }
}

// Saves text (usually JSON) safely, plus a backup copy. The backup is only
// a second chance: failing to write it never fails the save.
function writeText(file, text) {
  replace(file, text);
  try { replace(file + ".bak", text); } catch (err) { /* the main copy is saved */ }
}

function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2));
}

function parse(file) {
  const text = fs.readFileSync(file, "utf8");
  // A file the power cut caught half-way is often all zero bytes, which
  // JSON.parse would report confusingly; treat it as plainly damaged.
  if (!text.replace(/[\s\u0000]/g, "")) throw new Error("empty");
  return JSON.parse(text);
}

// The saved value, or the backup copy if the file is missing or damaged,
// or null if neither can be read.
function readJson(file) {
  try {
    return parse(file);
  } catch (err) {
    try {
      return parse(file + ".bak");
    } catch (err2) {
      return null;
    }
  }
}

// Which copy readJson() would use: "file", "backup" or "" (none).
function whichCopy(file) {
  try { parse(file); return "file"; } catch (err) { /* try the backup */ }
  try { parse(file + ".bak"); return "backup"; } catch (err) { return ""; }
}

function removeJson(file) {
  for (const f of [file, file + ".bak", file + ".tmp"]) {
    try { fs.rmSync(f, { force: true }); } catch (err) { /* already gone */ }
  }
}

module.exports = { writeText, writeJson, readJson, removeJson, whichCopy };
