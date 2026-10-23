// "Refresh address": the main computer's website lists its addresses afresh,
// restarts its answering, and can be recognised from another page's address.
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), http = require("http");
const R = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbt8-"));
const PORT = 3618, UDP = 39618;
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };

function req(method, p, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: headers || {} }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, body }); });
    });
    r.on("error", reject); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = spawn(process.execPath, [path.join(R, "server", "server.js")], {
    env: Object.assign({}, process.env, { PORT: String(PORT), OP_DATA_DIR: dir, OP_DISCOVERY_PORT: String(UDP) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
  try {
    for (let i = 0; i < 50; i++) { try { await req("GET", "/api/hello"); break; } catch (e) { await sleep(200); } }
    const first = await req("POST", "/api/refresh-address");
    ok(first.status === 200 && first.body.ok === true, "refresh answers ok");
    ok(Array.isArray(first.body.addresses) && "best" in first.body && "hostnameUrl" in first.body, "refresh lists the addresses");
    ok(first.body.id && first.body.id.length > 3, "refresh says which website this is (its permanent id)");
    ok(first.body.restarted === true, "first refresh restarts the answering");
    const again = await req("POST", "/api/refresh-address");
    ok(again.status === 200 && again.body.restarted === false, "pressing it again straight away is calmly ignored");
    await sleep(2200);
    const third = await req("POST", "/api/refresh-address");
    ok(third.body.restarted === true, "and works again a moment later");
    const about = await req("GET", "/api/office-printing", { Origin: "http://192.168.9.9:3000" });
    ok(about.headers["access-control-allow-origin"] === "*" && about.body.app === "office-printing", "an old address's page can check the website's identity");
    ok(about.body.id === first.body.id, "same id every time");
    ok(/Answering searches from other computers/.test(log), "answering for other computers is running");
  } finally {
    server.kill();
  }
  console.log(n + " checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
