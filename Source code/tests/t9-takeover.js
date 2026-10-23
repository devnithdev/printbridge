// "Make this the only main computer" (4.1.3+): a main computer steps down
// for a newer claim it has checked for itself, and only for that.
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), { fork, spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");
const NODE_PATH = [path.join(ROOT, "agent", "node_modules"), path.join(ROOT, "server", "node_modules"), process.env.NODE_PATH || ""].join(path.delimiter);
const DISCOVERY = "39391";
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

function website(port, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbt-"));
  if (opts.claimAt) fs.writeFileSync(path.join(dir, "claim.json"), JSON.stringify({ at: opts.claimAt }));
  const p = fork(path.join(ROOT, "server", "server.js"), [], {
    silent: true,
    env: Object.assign({}, process.env, { NODE_PATH, PORT: String(port), PRINT_DATA_DIR: dir, PRINT_UPLOAD_DIR: path.join(dir, "up"),
      OP_DISCOVERY_PORT: DISCOVERY, OP_TAKEOVER_CHECK_MS: "1500" }),
  });
  p.out = ""; p.stdout.on("data", (d) => { p.out += d; }); p.stderr.on("data", (d) => { p.out += d; });
  p.stepDown = null; p.on("message", (m) => { if (m && m.type === "step-down") p.stepDown = m; });
  p.dir = dir; procs.push(p); return p;
}
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200); } return false; };
const getJson = (port) => new Promise((resolve) => require("http").get({ host: "127.0.0.1", port, path: "/api/office-printing" }, (r) => {
  let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
}).on("error", () => resolve(null)));

(async () => {
  const oldMain = website(3711, {});
  // Someone pretending: answers the network question with a huge claim, but
  // there is no website behind it to confirm it.
  const find = require(path.join(ROOT, "agent", "lib", "find"));
  process.env.OP_DISCOVERY_PORT = DISCOVERY;
  const stopFake = find.startResponder(() => ({ id: "srv_fake00000000", name: "FAKE", port: 3799, version: "9", claimAt: Date.now() + 1000 }), { discoveryPort: parseInt(DISCOVERY, 10) });
  // (Waits for the website to be up: the first start on a cold disk can take a few seconds.)
  let a = null;
  await waitFor(() => false, 1200);
  for (let i = 0; i < 40 && !a; i++) { a = await getJson(3711); if (!a) await sleep(250); }
  ok(a && a.claimAt === 0 && typeof a.claimAt === "number", "a main computer that never claimed answers claimAt 0 (so Setup knows it can step down)");
  await sleep(5000);
  ok(!oldMain.stepDown, "a claim nobody can confirm over the network is ignored (nothing steps down for it)");
  stopFake();

  // An older version (or a main computer set up before this option) steps
  // down for the first claim it sees...
  let t0 = Date.now();
  const claimedEarlier = website(3713, { claimAt: Date.now() - 60 * 60 * 1000 });
  ok(await waitFor(() => oldMain.stepDown, 15000), "a main computer that never claimed steps down for one that did (" + ((Date.now() - t0) / 1000).toFixed(1) + " s)");
  const c = await getJson(3713);
  ok(oldMain.stepDown.byId === c.id && /:3713$/.test(oldMain.stepDown.address), "the step-down names the new main computer and its address");
  ok(fs.existsSync(path.join(oldMain.dir, "stepped-down.json")), "the old main computer keeps a note of it (Check shows it)");

  // ...and a claimed one steps down for a newer claim.
  t0 = Date.now();
  const newMain = website(3712, { claimAt: Date.now() });
  ok(await waitFor(() => claimedEarlier.stepDown, 15000), "an earlier \"only main computer\" steps down for a newer one (" + ((Date.now() - t0) / 1000).toFixed(1) + " s)");
  await sleep(4000);
  ok(!newMain.stepDown, "the new main computer stays (its claim is the newest)");
  const found = (await find.askNetwork({ waitMs: 1500, discoveryPort: parseInt(DISCOVERY, 10) })).filter((f) => [3711, 3712, 3713].includes(f.port));
  ok(found.length === 1 && found[0].port === 3712, "only the new main computer still answers the network question");

  procs.forEach((p) => p.kill());
  console.log(n + " checks passed");
  process.exit(0);
})().catch((e) => { console.error(e); procs.forEach((p) => { console.error(p.out.slice(-800)); p.kill(); }); process.exit(1); });
