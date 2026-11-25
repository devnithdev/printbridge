// Printers & setup: both sides set by hand, printer problems shown on the print page, clearing a printer's queue.
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), http = require("http"), { fork } = require("child_process");
const ROOT = path.join(__dirname, "..");
const NODE_PATH = [path.join(ROOT, "agent", "node_modules"), path.join(ROOT, "server", "node_modules"), process.env.NODE_PATH || ""].join(path.delimiter);
const WebSocket = require(path.join(ROOT, "server", "node_modules", "ws"));
const PORT = 3720;
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits for something that happens in another program, instead of guessing how long it takes.
const until = async (fn, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (await fn()) return true; await sleep(50); } return false; };

function request(method, p, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: { "content-type": "application/json" } }, (r) => {
      let d = ""; r.on("data", (c) => d += c); r.on("end", () => resolve({ status: r.statusCode, body: d }));
    });
    req.on("error", () => resolve(null));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const managed = async () => JSON.parse((await request("GET", "/api/manage/printers")).body).find((p) => p.name === "Office");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbt-"));
  const web = fork(path.join(ROOT, "server", "server.js"), [], {
    silent: true,
    env: Object.assign({}, process.env, { NODE_PATH, PORT: String(PORT), PRINT_DATA_DIR: dir, PRINT_UPLOAD_DIR: path.join(dir, "up"), NO_DISCOVERY: "1" }),
  });
  let ws, sseReq;
  try {
    for (let i = 0; i < 50 && !(await request("GET", "/api/office-printing")); i++) await sleep(200);
    const added = JSON.parse((await request("POST", "/api/manage/computers", { name: "Test" })).body);
    ws = new WebSocket("ws://127.0.0.1:" + PORT + "/agent");
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", token: added.token, printers: [{ name: "Office", capabilities: { color: false, duplex: false } }] }));
    await until(managed);

    let p = await managed();
    ok(p && p.duplexMode === "auto" && p.reportedDuplex === false && p.capabilities.duplex === false, "starts as what the computer says (no)");
    ok((await request("POST", "/api/manage/printers/" + encodeURIComponent(p.id) + "/duplex", { mode: "yes" })).status === 200, "can be set to yes");
    p = await managed();
    ok(p.capabilities.duplex === true && p.capabilities.color === false, "yes overrules the computer, colour is left alone");
    ws.send(JSON.stringify({ type: "printers", printers: [{ name: "Office", capabilities: { color: false, duplex: false } }] }));
    await sleep(300);
    ok((await managed()).capabilities.duplex === true, "still yes after the computer reports its printers again");
    await request("POST", "/api/manage/printers/" + encodeURIComponent(p.id) + "/duplex", { mode: "no" });
    ok((await managed()).capabilities.duplex === false, "can be set to no");
    await request("POST", "/api/manage/printers/" + encodeURIComponent(p.id) + "/duplex", { mode: "hand" });
    const hand = (await managed()).capabilities;
    ok(hand.duplex === false && hand.duplexByHand === true, "can be set to by hand (no automatic both sides, so the page offers turning it over)");
    await request("POST", "/api/manage/printers/" + encodeURIComponent(p.id) + "/duplex", { mode: "no" });
    ok((await request("POST", "/api/manage/printers/" + encodeURIComponent(p.id) + "/duplex", { mode: "maybe" })).status === 400, "anything else is refused");

    // Removing a computer and clearing a queue are for the main computer itself;
    // adding one (how a printer computer joins) stays open to the network.
    const asOther = (method, p2, body) => new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p2, headers: { "content-type": "application/json", host: "192.168.1.50:" + PORT } }, (r) => {
        let d = ""; r.on("data", (c) => d += c); r.on("end", () => resolve({ status: r.statusCode, body: d }));
      });
      req.on("error", () => resolve(null));
      req.end(body ? JSON.stringify(body) : undefined);
    });
    ok((await asOther("POST", "/api/manage/printers/" + encodeURIComponent(p.id) + "/clear-queue")).status === 403, "clearing a queue from another computer is refused");
    ok((await asOther("DELETE", "/api/manage/computers/" + added.computer.id)).status === 403, "removing a computer from another computer is refused");
    ok((await asOther("POST", "/api/manage/computers", { name: "Newcomer" })).status === 200, "a new printer computer can still join from the network");

    // A printer that drops out of its computer's list and comes back keeps what was set on Printers & setup.
    await request("POST", "/api/manage/printers/" + encodeURIComponent(p.id) + "/broken", { broken: true });
    ws.send(JSON.stringify({ type: "printers", printers: [] }));
    await until(async () => !(await managed()));
    ok(!(await managed()), "a printer missing from its computer's list is forgotten");
    ws.send(JSON.stringify({ type: "printers", printers: [{ name: "Office", capabilities: { color: false, duplex: false } }] }));
    await until(managed);
    ok((await managed()).broken === true, "...and when it comes back it is still marked out of order");
    await request("POST", "/api/manage/printers/" + encodeURIComponent((await managed()).id) + "/broken", { broken: false });

    // Out of order: still listed for everyone, but nothing can be sent to it.
    const brokenUrl = "/api/manage/printers/" + encodeURIComponent(p.id) + "/broken";
    ok((await request("POST", brokenUrl, { broken: "yes" })).status === 400, "out of order: only true or false is taken");
    ok((await request("POST", brokenUrl, { broken: true })).status === 200 && (await managed()).broken === true, "a shown printer can be marked out of order");
    const onPage = JSON.parse((await request("GET", "/api/printers")).body).find((x) => x.name === "Office");
    ok(onPage && onPage.broken === true, "...and the print page still lists it, marked out of order");
    const pdfBody = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    const up = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/api/uploads/printout?name=t", headers: { "content-type": "application/pdf" } }, (r) => {
        let d = ""; r.on("data", (c) => d += c); r.on("end", () => resolve(JSON.parse(d)));
      });
      req.end(pdfBody);
    });
    const refused = await request("POST", "/api/print", { uploadId: up.upload.id, printerId: p.id, options: {}, label: "t" });
    ok(refused.status === 404, "printing to it is refused");
    await request("POST", brokenUrl, { broken: false });
    ok((await managed()).broken === false, "marked working again");

    // Renaming: people are shown the new name; its computer is still sent the real one.
    const renameUrl = "/api/manage/printers/" + encodeURIComponent(p.id) + "/rename";
    ok((await request("POST", renameUrl, { name: 5 })).status === 400, "rename: only text is taken");
    ok((await request("POST", renameUrl, { name: "  Front   desk\nlaser  " })).status === 200, "a printer can be renamed (spaces and line breaks tidied)");
    let renamed = await managed();
    ok(renamed.label === "Front desk laser" && renamed.name === "Office" && renamed.displayName === "Front desk laser", "...people see the new name, the computer's own name is kept");
    const onPage2 = JSON.parse((await request("GET", "/api/printers")).body).find((x) => x.id === p.id);
    ok(onPage2.label === "Front desk laser" && onPage2.name === "Office", "...the print page gets both");
    ws.send(JSON.stringify({ type: "printers", printers: [{ name: "Office", capabilities: { color: false, duplex: false } }, { name: "Spare", capabilities: { color: false, duplex: false } }] }));
    await until(async () => JSON.parse((await request("GET", "/api/manage/printers")).body).length === 2);
    const spare = JSON.parse((await request("GET", "/api/manage/printers")).body).find((x) => x.name === "Spare");
    const dup = await request("POST", "/api/manage/printers/" + encodeURIComponent(spare.id) + "/rename", { name: "FRONT desk LASER" });
    ok(dup.status === 400 && /already called/.test(dup.body), "another printer can't be given the same name (even in other letters)");
    ok((await request("POST", "/api/manage/printers/" + encodeURIComponent(spare.id) + "/rename", { name: "Office" })).status === 400, "...nor another printer's own name");
    ws.send(JSON.stringify({ type: "printers", printers: [{ name: "Office", capabilities: { color: false, duplex: false } }] }));
    await until(async () => JSON.parse((await request("GET", "/api/manage/printers")).body).length === 1);
    await request("POST", renameUrl, { name: "x".repeat(80) });
    ok((await managed()).label.length === 60, "a name is cut at 60 characters");
    await request("POST", renameUrl, { name: "" });
    renamed = await managed();
    ok(renamed.label === "Office" && !renamed.displayName, "empty goes back to the original name");
    await request("POST", renameUrl, { name: "Front desk laser" });
    ws.send(JSON.stringify({ type: "printers", printers: [] }));
    await until(async () => !(await managed()));
    ws.send(JSON.stringify({ type: "printers", printers: [{ name: "Office", capabilities: { color: false, duplex: false } }] }));
    await until(managed);
    ok((await managed()).label === "Front desk laser", "the new name is still there after the printer drops out of its computer's list and comes back");

    // A printer's computer says it is jammed: everyone sees it, then it clears.
    const got = [];
    ws.on("message", (m) => got.push(JSON.parse(m)));
    const sseQueues = [];
    let sseBuf = "";
    sseReq = http.get("http://127.0.0.1:" + PORT + "/api/stream", (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        sseBuf += chunk;
        let idx;
        while ((idx = sseBuf.indexOf("\n\n")) !== -1) {
          const frame = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (frame.includes("event: queue\n") && dataLine) sseQueues.push(JSON.parse(dataLine.slice(6)));
        }
      });
    });
    sseReq.on("error", () => {});
    const waitFor = async (fn) => {
      for (let i = 0; i < 40; i++) { if (fn()) return true; await sleep(50); }
      return false;
    };
    await waitFor(() => sseQueues.length >= 1);

    const form = new FormData();
    form.append("printerId", p.id);
    form.append("file", new Blob(["%PDF-1.4\n%%EOF\n"], { type: "application/pdf" }), "a.pdf");
    const sent = await fetch("http://127.0.0.1:" + PORT + "/api/print", { method: "POST", body: form });
    ok(sent.ok, "a job waits on the printer");
    await waitFor(() => sseQueues.some((q) => q.length === 1));
    ok(got.some((m) => m.type === "job" && m.printer === "Office"), "the printer's computer is sent its own name, not the new one");
    ok(sseQueues.some((q) => q.some((j) => j.printerName === "Front desk laser")), "the queue shows the new name");

    const beforeJam = sseQueues.length;
    ws.send(JSON.stringify({ type: "health", printers: [{ name: "Office", problem: "Paper jam", waiting: 2 }, { name: "Not mine", problem: "x" }, null] }));
    const listed = () => request("GET", "/api/printers").then((r) => JSON.parse(r.body).find((x) => x.name === "Office"));
    await until(async () => (await listed()).problem === "Paper jam");
    ok((await listed()).problem === "Paper jam", "a jam reported by the printer's computer shows on the print page");
    ok(await waitFor(() => sseQueues.slice(beforeJam).some((q) => q.some((j) => j.printerProblem === "Paper jam"))), "live queue update shows the jam right away");
    const beforeClear = sseQueues.length;
    ws.send(JSON.stringify({ type: "health", printers: [{ name: "Office", problem: "", waiting: 0 }] }));
    await until(async () => (await listed()).problem === "");
    ok((await listed()).problem === "", "and goes away once it is fixed");
    ok(await waitFor(() => sseQueues.slice(beforeClear).some((q) => q.length && q.every((j) => j.printerProblem === ""))), "clearing the jam broadcasts to the live queue too");

    // Clearing the queue cancels what waits for it and tells its computer.
    const cleared = JSON.parse((await request("POST", "/api/manage/printers/" + encodeURIComponent(p.id) + "/clear-queue")).body);
    await until(() => got.some((m) => m.type === "clear-queue"));
    ok(cleared.ok && cleared.cancelled === 1 && cleared.computerOnline === true, "clearing a queue answers ok");
    ok(got.some((m) => m.type === "clear-queue" && m.printer === "Office"), "the printer's computer is told to empty its own queue");

    // Removing a computer from Manage closes its live connection right away.
    const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
    const removed = await request("DELETE", "/api/manage/computers/" + encodeURIComponent(added.computer.id));
    const closeCode = await Promise.race([closed, sleep(1500).then(() => null)]);
    ok(removed.status === 200 && closeCode === 4003, "removing a computer disconnects its agent immediately");
  } finally {
    if (sseReq) sseReq.destroy();
    if (ws) ws.terminate();
    web.kill();
    // The website may still be saving as it stops; a leftover temp folder is not a failed check.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (err) { /* left in the temp folder */ }
  }
  console.log(n + " checks passed");
})().catch((err) => { console.error(err); process.exit(1); });
