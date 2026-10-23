const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), { spawn } = require("child_process");
const T = __dirname;
const env = Object.assign({}, process.env, { NODE_PATH: [require("path").join(__dirname, "..", "agent", "node_modules"), process.env.NODE_PATH || ""].join(require("path").delimiter), OP_DISCOVERY_PORT: "39377" });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pba-"));
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
function start(args, extra, tag) {
  const p = spawn("node", args, { env: Object.assign({}, env, extra || {}) });
  p.out = ""; p.stdout.on("data", (d) => { p.out += d; }); p.stderr.on("data", (d) => { p.out += d; });
  procs.push(p); return p;
}
const status = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "status.json"))); } catch (e) { return {}; } };
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(250); } return false; };
(async () => {
  const webA = start([T + "/fake-web.js", "3601", "srv_aaa111"]);
  await sleep(500);
  const t0 = Date.now();
  const agent = start(["-e", "require(" + JSON.stringify(require('path').join(__dirname, '..', 'agent', 'agent.js')) + ").startManaged()"], {
    OFFICE_PRINTING_MANAGED: "1", PRINT_AGENT_DIR: dir, OP_ROLE: "printer", OP_NAME: "Front desk", OP_SERVER: "127.0.0.1:3999",
  });
  ok(await waitFor(() => status().state === "connected", 20000), "typed address dead -> found the website by asking the network, registered and connected (" + ((Date.now() - t0) / 1000).toFixed(1) + " s)");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json")));
  ok(cfg.serverId === "srv_aaa111" && /:3601\/agent$/.test(cfg.serverUrl) && cfg.serverName === "MAIN-PC" && fs.existsSync(path.join(dir, "config.json.bak")), "connection saved with id, name and a backup copy");
  // the main computer comes back with a different address (simulated with another port)
  webA.kill(); await sleep(300);
  const t1 = Date.now();
  const webB = start([T + "/fake-web.js", "3602", "srv_aaa111"], { ACCEPT_ANY: "1" });
  ok(await waitFor(() => /:3602\/agent$/.test((JSON.parse(fs.readFileSync(path.join(dir, "config.json"))).serverUrl || "")) && status().state === "connected", 45000),
    "main computer's address changed -> switched over by itself (" + ((Date.now() - t1) / 1000).toFixed(1) + " s)");
  // power cut wipes config.json -> backup is used, same connection
  agent.kill(); await sleep(300);
  fs.writeFileSync(path.join(dir, "config.json"), Buffer.alloc(300));
  fs.rmSync(path.join(dir, "status.json"), { force: true });
  const agent2 = start(["-e", "require(" + JSON.stringify(require('path').join(__dirname, '..', 'agent', 'agent.js')) + ").startManaged()"], {
    OFFICE_PRINTING_MANAGED: "1", PRINT_AGENT_DIR: dir, OP_ROLE: "printer", OP_NAME: "Front desk", OP_SERVER: "",
  });
  ok(await waitFor(() => status().state === "connected", 15000) && !/Registered this computer/.test(agent2.out), "config.json wiped by a power cut -> reconnected from the backup copy, without registering again");
  console.log("--- agent log (first run) ---\n" + agent.out.split("\n").filter(Boolean).slice(0, 14).join("\n"));
  procs.forEach((p) => p.kill());
  console.log(n + " checks passed");
  process.exit(0);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
