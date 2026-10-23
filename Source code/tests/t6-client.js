const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), { spawn } = require("child_process");
const T = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbcl-"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcltmp-"));
const env = Object.assign({}, process.env, { NODE_PATH: [require("path").join(__dirname, "..", "agent", "node_modules"), process.env.NODE_PATH || ""].join(require("path").delimiter), OP_DATA_DIR: dir, OP_LOCK_PORT: "39481", OP_OUTBOX_LOCK_PORT: "39485", OP_DISCOVERY_PORT: "39380", TMPDIR: tmp, DISPLAY: "" });
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
function start(args) { const p = spawn("node", args, { env }); p.out = ""; p.stdout.on("data", (d) => p.out += d); p.stderr.on("data", (d) => p.out += d); procs.push(p); return p; }
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(250); } return false; };
(async () => {
  process.env.OP_DATA_DIR = dir;
  const P = require(require("path").join(__dirname, "..") + "/desktop/lib/paths");
  // A computer that only prints, set up long ago with the main computer's address typed in;
  // after a power cut the main computer has a NEW address (and an old 4.0 cache file is there too).
  P.writeSettings({ role: "client", name: "Reception", server: "127.0.0.1:3999" });
  P.ensureDirs(); fs.writeFileSync(path.join(P.OUTBOX_DIR, "server.json"), JSON.stringify({ url: "http://127.0.0.1:3998", at: 1 }));
  const web = start([T + "/fake-web.js", "3606", "srv_cl1"]);
  await sleep(400);
  const signin = start([T + "/run-sup.js", "signin"]);
  await sleep(2500);
  const t0 = Date.now();
  fs.writeFileSync(require(require("path").join(__dirname, "..") + "/desktop/lib/printout").portPath(), "%PDF-1.4\n" + "y".repeat(300) + "\n%%EOF\n");
  ok(await waitFor(() => /PRINTOUT \d+/.test(web.out), 20000), "printout from a computer that only prints reached the main computer at its new address (" + ((Date.now() - t0) / 1000).toFixed(1) + " s after printing)");
  ok(!fs.readdirSync(tmp).some((f) => /not-sent/.test(f)), "no \"wasn't printed\" error page");
  const cache = JSON.parse(fs.readFileSync(path.join(P.OUTBOX_DIR, "server.json")));
  ok(/:3606$/.test(cache.url) && cache.id === "srv_cl1" && cache.name === "MAIN-PC", "new address remembered with the main computer's id and name");
  ok(P.readSettings().server === "127.0.0.1:3999", "nothing had to be typed in again (Setup's saved address left as it was)");
  console.log("--- printouts.log ---\n" + fs.readFileSync(path.join(dir, "logs", "printouts.log"), "utf8").trim());
  procs.forEach((p) => p.kill());
  console.log(n + " checks passed");
  process.exit(0);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
