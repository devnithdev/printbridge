// Stand-in for the background program in t10-updates.js: reports a version
// in status.json every 300 ms, like supervisor.js does every 15 s.
//   node fake-sup.js <status.json> <version> [broken]
// "broken": reports a part that keeps stopping (never all running).
const fs = require("fs");
const [file, version, broken] = process.argv.slice(2);
fs.writeFileSync(file + ".pid", String(process.pid));
const write = () => {
  const s = { pid: process.pid, version, updatedAt: Date.now(), parts: { printer: { running: broken !== "broken" } } };
  try { fs.writeFileSync(file, JSON.stringify(s)); } catch (err) { /* next time */ }
};
write();
setInterval(write, 300);
setTimeout(() => process.exit(0), 120000);
