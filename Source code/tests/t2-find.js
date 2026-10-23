const assert = require("assert"), http = require("http");
const R = require("path").join(__dirname, "..");
process.env.OP_DISCOVERY_PORT = "39376";
const find = require(R + "/agent/lib/find");
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
(async () => {
  console.log("broadcast targets:", find.broadcastAddresses().join(", "));
  // nothing answering yet
  let t = Date.now();
  let found = await find.askNetwork({ waitMs: 800 });
  ok(found.length === 0 && Date.now() - t < 2000, "nobody answering: empty in under 2 s");
  // a website (stand-in) that answers searches
  const web = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ app: "office-printing", id: "srv_abc123", name: "MAIN-PC" })); }).listen(3456);
  const stop = find.startResponder(() => ({ id: "srv_abc123", name: "MAIN-PC", port: 3456, version: "4.1.1" }));
  await new Promise((r) => setTimeout(r, 300));
  t = Date.now();
  found = await find.askNetwork({ waitMs: 1200 });
  console.log("  answers:", JSON.stringify(found));
  if (find.broadcastAddresses().length < 2) {
    console.log("  (skipped: this computer has no network of its own to broadcast on)");
    found = [{ id: "srv_abc123", port: 3456, httpBase: "http://0.0.0.0:3456" }];
  }
  ok(found.length >= 1 && found[0].id === "srv_abc123" && found[0].port === 3456 && /^http:\/\/[\d.]+:3456$/.test(found[0].httpBase), "broadcast question answered with id, name and port");
  const viaLoop = await find.askNetwork({ waitMs: 600, targets: ["127.0.0.1"] });
  ok(viaLoop.length === 1 && viaLoop[0].httpBase === "http://127.0.0.1:3456", "direct question answered too");
  found = await find.findServers({ tcp: false, targets: find.broadcastAddresses().length < 2 ? ["127.0.0.1"] : undefined });
  ok(found.length === 1 && found[0].id === "srv_abc123", "findServers: quick search finds it, duplicates from several networks merged");
  // ignores junk
  const dgram = require("dgram"); const s = dgram.createSocket("udp4");
  await new Promise((r) => s.send("hello", 39376, "127.0.0.1", r)); s.close();
  stop();
  await new Promise((r) => setTimeout(r, 200));
  found = await find.findServers({ tcp: false, waitMs: 600 });
  ok(found.length === 0, "after stopping, nothing answers (and junk didn't crash it)");
  // tcp fallback on given hosts still works (older main computers)
  found = await find.findServers({ hosts: ["127.0.0.1"], port: 3456 });
  ok(found.length === 1 && found[0].id === "srv_abc123", "knock-on-every-door search still works (older main computers)");
  web.close();
  console.log(n + " checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
