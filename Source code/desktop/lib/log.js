// Plain-text logs in C:\ProgramData\Office Printing\logs. Each is kept
// under about 1 MB: when it grows past that, it becomes <name>.old.log and
// a new one starts, so logs never fill the disk.

const fs = require("fs");
const path = require("path");
const P = require("./paths");

const LIMIT = 1024 * 1024;

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
    pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function logger(name) {
  const file = path.join(P.LOG_DIR, name + ".log");
  let partial = "";

  function write(text) {
    try {
      fs.mkdirSync(P.LOG_DIR, { recursive: true });
      try {
        if (fs.statSync(file).size > LIMIT) {
          fs.renameSync(file, path.join(P.LOG_DIR, name + ".old.log"));
        }
      } catch (err) {
        /* no file yet */
      }
      fs.appendFileSync(file, text);
    } catch (err) {
      /* a log that can't be written must never stop printing */
    }
  }

  return {
    file,
    line(message) {
      write("[" + stamp() + "] " + message + "\r\n");
    },
    // For output streamed from a child program: stamp each complete line.
    chunk(data) {
      partial += data.toString("utf8");
      const lines = partial.split(/\r?\n/);
      partial = lines.pop();
      if (lines.length) write(lines.map((l) => "[" + stamp() + "] " + l + "\r\n").join(""));
    },
  };
}

module.exports = { logger, stamp };
