const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), { spawn } = require("child_process");
const T = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbsup-"));
const env = Object.assign({}, process.env, { NODE_PATH: [require("path").join(__dirname, "..", "agent", "node_modules"), process.env.NODE_PATH || ""].join(require("path").delimiter), OP_DATA_DIR: dir, OP_LOCK_PORT: "39471", OP_OUTBOX_LOCK_PORT: "39475", OP_DISCOVERY_PORT: "39378", DISPLAY: "" });
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
function start(args, tag) { const p = spawn("node", args, { env }); p.out = ""; p.stdout.on("data", (d) => p.out += d); p.stderr.on("data", (d) => p.out += d); procs.push(p); return p; }
const json = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f))); } catch (e) { return null; } };
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(250); } return false; };
const count = (p, re) => (p.out.match(re) || []).length;
(async () => {
  process.env.OP_DATA_DIR = dir;
  const P = require(require("path").join(__dirname, "..") + "/desktop/lib/paths");
  P.writeSettings({ role: "printer", name: "Front desk", server: "" });
  const web = start([T + "/fake-web.js", "3604", "srv_sup111"]);
  await sleep(400);
  const svc = start([T + "/run-sup.js", "service"]);
  ok(await waitFor(() => count(web, /HELLO Front desk/g) === 1, 15000), "startup task (service) runs printer sharing, connected");
  const signin = start([T + "/run-sup.js", "signin"]);
  ok(await waitFor(() => { const s = json("status-signin.json"); return s && s.parts.outbox && s.parts.outbox.running; }, 10000), "sign-in runs the printouts part");
  await sleep(6000);
  ok(count(web, /HELLO Front desk/g) === 1 && json("status.json").startedAs.includes("startup task"), "sign-in does NOT start a second printer sharing while the task runs it");
  const sup = require(require("path").join(__dirname, "..") + "/desktop/lib/supervisor");
  ok((await sup.ask(39471, "restart-parts")) === "ok", "\"Restart\" request answered by the task's copy");
  ok(await waitFor(() => count(web, /HELLO Front desk/g) === 2, 15000), "printer sharing restarted on request (no admin rights needed)");
  ok((await sup.ask(39475, "who")).includes("printouts"), "printouts part answers too");
  // a printout through the PrintBridge printer: written to the port file
  const pdf = "%PDF-1.4\n" + "x".repeat(200) + "\n%%EOF\n";
  fs.writeFileSync(require(require("path").join(__dirname, "..") + "/desktop/lib/printout").portPath(), pdf);
  ok(await waitFor(() => /PRINTOUT \d+/.test(web.out), 15000), "printout sent to the printing website");
  // the startup task stops (crash): the sign-in copy takes over printer sharing
  svc.kill("SIGKILL");
  ok(await waitFor(() => count(web, /HELLO Front desk/g) === 3, 30000), "startup task gone -> the signed-in copy takes over printer sharing by itself");
  ok(/signed in/.test(json("status.json").startedAs), "status says who runs it now");
  procs.forEach((p) => p.kill());
  console.log("--- office-printing.log ---\n" + fs.readFileSync(path.join(dir, "logs", "office-printing.log"), "utf8").trim().split("\n").slice(-12).join("\n"));
  console.log("--- printouts.log ---\n" + fs.readFileSync(path.join(dir, "logs", "printouts.log"), "utf8").trim());
  console.log(n + " checks passed");
  process.exit(0);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
