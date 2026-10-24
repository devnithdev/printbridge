// The web server.
//
// The whole idea: anyone on the office network opens the page and prints.
// No app to install, no account, no password - the same deal as walking up
// to a printer with a USB stick, minus the USB stick.
//
// It does four things:
//   1. serves the print page, the manage page and the QR poster,
//   2. accepts dropped files (and printouts from the "PrintBridge"
//      printer), shows them for checking, and turns them into print jobs,
//   3. talks to agents over WebSocket and follows each job's status,
//   4. keeps every browser's queue up to date live.

const express = require("express");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const { db, save } = require("./lib/store");
const { newId, newToken, hashToken } = require("./lib/ids");
const device = require("./lib/device");
const agents = require("./lib/agents");
const jobs = require("./lib/jobs");
const convert = require("./lib/convert");
const help = require("./lib/help");
const held = require("./lib/held");

const PORT = parseInt(process.env.PORT, 10) || 3000;
const VERSION = "4.2.0";
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB, 10) || 50;
const UPLOAD_DIR = jobs.UPLOAD_DIR;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

// When the server sits behind nginx/Caddy, this lets it know whether the
// visitor arrived over https.
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));
app.use(device.attachDevice);

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase().slice(0, 10);
    cb(null, newId("f") + (/^\.[a-z0-9]+$/.test(ext) ? ext : ""));
  },
});
const upload = multer({
  storage,
  // Browsers send file names as UTF-8; multer's default (latin1) turned
  // "Café.docx" into "CafÃ©.docx" on the preview and in the queue.
  defParamCharset: "utf8",
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, "public")));

// An async route that throws would otherwise leave the browser waiting
// forever, because Express 4 doesn't catch rejected promises.
function handleAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- what the page needs to know on arrival ------------------------------

app.get("/api/hello", (req, res) => {
  res.json({
    printers: agents.listPrinters(),
    openHelp: help.listOpen(),
    maxUploadMb: MAX_UPLOAD_MB,
  });
});

// Lets a printer computer recognise this website when it searches the
// network for it (see the agent's find.js).
app.get("/api/office-printing", (req, res) => {
  // Readable from a page opened at an older address of this website, so that
  // page can check whether a remembered address still reaches it (see the
  // "Refresh address" button in app.js). It only says who this website is.
  res.set("Access-Control-Allow-Origin", "*");
  res.json({ app: "office-printing", id: db.serverId, name: os.hostname(), version: VERSION, claimAt: claimAt() });
});

// How many print jobs are on their way to a printer right now. Automatic
// updates on this computer wait for this to reach 0 before restarting the
// website (see busyReason in desktop/lib/updater.js). Only a number.
app.get("/api/busy", (req, res) => {
  res.json({ printing: jobs.countInProgress() });
});

// --- "make this the only main computer" -------------------------------------
//
// Setup can make a new main computer the only one on the network (see
// desktop/lib/configure.js). It writes claim.json here with the moment it
// was asked; this website then answers every "where are you?" with that
// moment (claimAt, 0 when never asked).
//
// Every main computer looks at the network once a minute. If another main
// computer answers with a LATER claim than its own, this one steps down: it
// stops running the printing page and, through the background program,
// becomes a computer that shares its printers through the new one (see
// supervisor.js). Nothing is deleted - running Setup again can make it the
// main computer again. A main computer that is switched off when the new
// one is set up does the same the next time it is switched on.
//
// Nobody can order a computer to step down. It only steps down for a
// working printing website it has checked for itself (its own answer, over
// the network, with the same id and claim), so it takes a real PrintBridge
// main computer to replace another - the same as installing one by hand.

const CLAIM_FILE = path.join(path.dirname(require("./lib/store").DATA_FILE), "claim.json");
const STEPPED_DOWN_FILE = path.join(path.dirname(require("./lib/store").DATA_FILE), "stepped-down.json");
const durable = require("../agent/lib/durable");
const CLAIM_SLACK_MS = 24 * 60 * 60 * 1000; // a clock set a day ahead can't win for ever

function claimAt() {
  const claim = durable.readJson(CLAIM_FILE);
  const at = claim && Number(claim.at);
  return at > 0 && isFinite(at) ? at : 0;
}

let steppedDown = false;

function stepDown(winner) {
  steppedDown = true;
  const record = {
    at: Date.now(),
    byId: winner.id,
    byName: winner.name || "",
    address: winner.httpBase,
    // The id this website had, so its printer part can still recognise
    // anything that pointed here.
    ownId: db.serverId,
  };
  try { durable.writeJson(STEPPED_DOWN_FILE, record); } catch (err) { /* the message below still goes */ }
  console.log("");
  console.log("  Another main computer has taken over: " + (winner.name || winner.id) + " at " + winner.httpBase + ".");
  console.log("  This computer stops running the printing page and shares its printers through that one.");
  console.log("");
  if (stopResponder) { try { stopResponder(); } catch (err) { /* already stopped */ } stopResponder = null; }
  if (typeof process.send === "function") {
    process.send(Object.assign({ type: "step-down" }, record));
  } else {
    // Run by hand from source: nobody to switch this computer over.
    console.log("  (Running on its own, so it keeps running until it is stopped.)");
  }
}

function watchForTakeover() {
  if (process.env.NO_DISCOVERY === "1") return;
  const find = require("../agent/lib/find");
  const every = parseInt(process.env.OP_TAKEOVER_CHECK_MS, 10) || 60 * 1000;
  let busy = false;
  const check = async () => {
    if (busy || steppedDown) return;
    busy = true;
    try {
      const mine = claimAt();
      const latest = Date.now() + CLAIM_SLACK_MS;
      const rivals = (await find.askNetwork({ waitMs: 2000 }))
        .filter((f) => f.id && f.id !== db.serverId && f.claimAt > mine && f.claimAt <= latest)
        .sort((a, b) => b.claimAt - a.claimAt);
      for (const rival of rivals) {
        // Checked over the network, not just believed: the same website, with
        // the same claim, answering at the address it answered from.
        const about = await find.identify(rival.host, rival.port);
        if (about && about.id === rival.id && about.claimAt === rival.claimAt) {
          stepDown(rival);
          return;
        }
      }
    } catch (err) {
      /* next time */
    } finally {
      busy = false;
    }
  };
  setTimeout(check, Math.min(15000, every));
  setInterval(check, every);
}

app.get("/api/printers", (req, res) => {
  res.json(agents.listPrinters());
});

// --- printing -------------------------------------------------------------

// Turns an uploaded file into a PDF ready to print. Returns the PDF's path;
// throws an Error whose message can be shown to the person.
async function readyToPrint(file) {
  if (convert.isPdf(file.originalname)) return file.path;
  if (!convert.needsConversion(file.originalname)) {
    fs.unlink(file.path, () => {});
    throw new Error("That kind of file can't be printed.");
  }
  try {
    const pdfPath = await convert.convertToPdf(file.path);
    fs.unlink(file.path, () => {});
    return pdfPath;
  } catch (err) {
    fs.unlink(file.path, () => {});
    throw err;
  }
}

function publicUpload(entry) {
  return {
    id: entry.id,
    fileName: entry.originalName,
    size: entry.size,
    source: entry.source,
    fileUrl: "/api/uploads/" + entry.id + "/file",
  };
}

// Step 1 of printing from the page: send the file, get back a preview.
// Word, Excel and other files are turned into a PDF here, so the preview
// shows exactly what will print.
app.post("/api/uploads", upload.single("file"), handleAsync(async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file arrived. Try dropping it again." });
    return;
  }
  let storedPath;
  try {
    storedPath = await readyToPrint(req.file);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  let size = req.file.size;
  try { size = fs.statSync(storedPath).size; } catch (err) { /* keep the upload size */ }
  const entry = held.create({ storedPath, originalName: req.file.originalname, size, source: "page" });
  res.json({ ok: true, upload: publicUpload(entry) });
}));

// A printout from the "PrintBridge" printer on a Windows computer. The
// program there sends the PDF straight in, then opens the print page on it.
app.post(
  "/api/uploads/printout",
  express.raw({ type: () => true, limit: MAX_UPLOAD_MB * 1024 * 1024 }),
  (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length < 8 || body.slice(0, 5).toString("latin1") !== "%PDF-") {
      res.status(400).json({ error: "That printout didn't arrive as a PDF." });
      return;
    }
    // The name the program gave the printout, e.g. "Budget 2026.xlsx".
    const name = String(req.query.name || "").replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 150) || "Printout";
    const storedPath = path.join(UPLOAD_DIR, newId("f") + ".pdf");
    fs.writeFileSync(storedPath, body);
    const entry = held.create({ storedPath, originalName: name, size: body.length, source: "printer" });
    res.json({ ok: true, upload: publicUpload(entry), openUrl: "/?upload=" + entry.id });
  }
);

app.get("/api/uploads/:id", (req, res) => {
  const entry = held.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "That printout has expired. Print it again." });
    return;
  }
  res.json(publicUpload(entry));
});

app.get("/api/uploads/:id/file", (req, res) => {
  const entry = held.get(req.params.id);
  if (!entry) {
    res.status(404).send("Not found.");
    return;
  }
  res.type("application/pdf");
  res.sendFile(entry.storedPath);
});

// The person closed the "Print this?" screen without printing.
app.delete("/api/uploads/:id", (req, res) => {
  held.discard(req.params.id);
  res.json({ ok: true });
});

// Step 2: print. Takes either a held upload (uploadId) or, as before, the
// file itself in one go.
app.post("/api/print", upload.single("file"), handleAsync(async (req, res) => {
  let fromHeld = null;
  if (!req.file) {
    fromHeld = req.body && req.body.uploadId ? held.get(req.body.uploadId) : null;
    if (!fromHeld) {
      res.status(400).json({
        error: req.body && req.body.uploadId
          ? "That file has expired. Choose it again."
          : "No file arrived. Try dropping it again.",
      });
      return;
    }
  }

  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  const label = device.cleanLabel(req.body.label);

  const printer = agents.findPrinter(String(req.body.printerId || ""));
  if (!printer || !agents.canPrintTo(printer)) {
    cleanup();
    res.status(404).json({ error: "That printer is not available." });
    return;
  }

  let options;
  try {
    const raw = req.body.options;
    options = jobs.cleanOptions(typeof raw === "string" ? JSON.parse(raw) : raw || {});
  } catch (err) {
    cleanup();
    res.status(400).json({ error: "Print options were not understood." });
    return;
  }

  const allowFailover = String(req.body.allowFailover || "") === "true";

  // Anything that is not already a PDF is converted here on the server.
  let storedPath;
  let originalName;
  if (fromHeld) {
    held.take(fromHeld.id);
    storedPath = fromHeld.storedPath;
    originalName = fromHeld.originalName;
  } else {
    try {
      storedPath = await readyToPrint(req.file);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    originalName = req.file.originalname;
  }

  // If the chosen printer is offline and failover was allowed, pick a
  // different printer right away instead of waiting.
  let target = printer;
  if (!agents.isOnline(printer.agentId) && allowFailover) {
    const alternative = db.printers.find(
      (p) =>
        p.id !== printer.id &&
        !p.hidden &&
        agents.isOnline(p.agentId) &&
        jobs.printerSupports(p, options)
    );
    if (alternative) target = alternative;
  }

  const job = jobs.createJob({
    deviceId: req.deviceId,
    label,
    file: { originalName, storedPath },
    printer: target,
    options,
    allowFailover,
  });

  if (target.id !== printer.id) {
    job.attempts.push({
      printerId: printer.id,
      printerName: printer.name,
      at: Date.now(),
      result: "skipped: offline",
    });
    job.triedPrinterIds.push(printer.id);
  }

  jobs.dispatch(job);

  res.json({ ok: true, job: jobs.publicJob(job, req.deviceId) });
}));

// The agent downloads the file through this link. The link only works with
// the right one-time token AND the agent's own token, and it stops working
// once the job is finished or after 30 minutes.
app.get("/api/files/:jobId/:token", (req, res) => {
  const found = jobs.fileForToken(req.params.jobId, req.params.token);
  if (!found) {
    res.status(404).send("This link is no longer valid.");
    return;
  }

  const header = String(req.headers.authorization || "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const agent = agents.findAgentByToken(bearer);
  if (!agent || agent.id !== found.job.agentId) {
    res.status(403).send("Not allowed.");
    return;
  }

  res.sendFile(found.fullPath);
});

// --- the queue and live updates -------------------------------------------

app.get("/api/queue", (req, res) => {
  res.json(jobs.listActiveQueue(req.deviceId));
});

app.get("/api/my-jobs", (req, res) => {
  res.json(jobs.listJobsForDevice(req.deviceId, 20));
});

// You can cancel what you sent, and only what you sent.
app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job || job.deviceId !== req.deviceId) {
    res.status(404).json({ error: "That isn't one of your print jobs." });
    return;
  }
  if (job.status !== "queued") {
    res.status(400).json({ error: "That one has already started printing." });
    return;
  }
  // A job waiting again after its computer dropped off (or after this
  // website restarted) may already be at that computer's printer, which
  // can't be called back from here - so don't promise it won't come out.
  // (job.agentId is set as soon as the job is made, so it can't tell; sentAt
  // is set only once the job has actually gone to a computer - see jobs.js.)
  jobs.finish(job, "cancelled", job.sentAt
    ? "Cancelled. It had already been sent to " + (job.printerName || "the printer") + ", so it may still come out."
    : "Cancelled.");
  res.json({ ok: true });
});

// A long-lived connection the browser keeps open, so the queue updates
// without refreshing the page.
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  jobs.addListener(req.deviceId, res);

  // Send the current queue immediately, so a reconnecting page is correct
  // straight away rather than at the next change.
  res.write("event: queue\ndata: " + JSON.stringify(jobs.listActiveQueue(req.deviceId)) + "\n\n");

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch (err) {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on("close", () => clearInterval(keepAlive));
});

// --- help button ----------------------------------------------------------

const HELP_COOLDOWN_MS = 60 * 1000;
const lastHelpAt = new Map(); // deviceId -> when

app.post("/api/help", (req, res) => {
  const previous = lastHelpAt.get(req.deviceId) || 0;
  const waitMs = HELP_COOLDOWN_MS - (Date.now() - previous);
  if (waitMs > 0) {
    res.status(429).json({
      error:
        "You've just asked for help. You can ask again in " +
        Math.ceil(waitMs / 1000) + " seconds.",
    });
    return;
  }

  lastHelpAt.set(req.deviceId, Date.now());
  const alert = help.create(device.cleanLabel(req.body.label), req.body.message);
  res.json({ ok: true, alert: help.publicAlert(alert) });
});

app.get("/api/help", (req, res) => {
  res.json(help.listOpen());
});

app.post("/api/help/:id/resolve", (req, res) => {
  const alert = help.resolve(req.params.id);
  if (!alert) {
    res.status(404).json({ error: "That was already dealt with." });
    return;
  }
  res.json({ ok: true });
});

// --- managing printers (open to anyone on the network) --------------------
//
// There is no password here by choice: this only listens on the office
// network, and the things it can do are the same things someone could do
// by walking over and unplugging the printer.

app.get("/api/manage/printers", (req, res) => {
  res.json(agents.listPrintersForManaging());
});

app.post("/api/manage/printers/:id/hidden", (req, res) => {
  const printer = agents.findPrinter(req.params.id);
  if (!printer) {
    res.status(404).json({ error: "No such printer." });
    return;
  }
  printer.hidden = !!req.body.hidden;
  save();
  jobs.broadcastQueue();
  res.json({ ok: true });
});

app.get("/api/manage/computers", (req, res) => {
  res.json(
    db.agents.map((a) => ({
      id: a.id,
      name: a.name,
      platform: a.platform || "unknown",
      version: a.version || "",
      online: agents.isOnline(a.id),
      lastSeenAt: a.lastSeenAt || 0,
      createdAt: a.createdAt,
    }))
  );
});

// Adding a printer computer hands back a token exactly once. The agent
// normally calls this itself during its own setup, so nobody has to copy
// and paste anything.
app.post("/api/manage/computers", (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 60) || "printer-computer";
  const token = newToken();
  const agent = {
    id: newId("agt"),
    name,
    tokenHash: hashToken(token),
    createdAt: Date.now(),
    lastSeenAt: 0,
  };
  db.agents.push(agent);
  save();
  res.json({ ok: true, computer: { id: agent.id, name: agent.name }, token });
});

// A printer computer whose program is being removed says goodbye, so its
// printers leave the list instead of showing as switched off.
app.post("/api/agent/leave", (req, res) => {
  const header = String(req.headers.authorization || "");
  const agent = agents.findAgentByToken(header.startsWith("Bearer ") ? header.slice(7) : "");
  if (!agent) {
    res.status(404).json({ error: "Not known here." });
    return;
  }
  removeComputer(agent.id);
  res.json({ ok: true });
});

function removeComputer(id) {
  const index = db.agents.findIndex((a) => a.id === id);
  if (index === -1) return false;
  const [agent] = db.agents.splice(index, 1);
  const gone = new Set();
  for (let i = db.printers.length - 1; i >= 0; i--) {
    if (db.printers[i].agentId === agent.id) {
      gone.add(db.printers[i].id);
      db.printers.splice(i, 1);
    }
  }
  // Jobs still waiting for that computer's printers would otherwise wait
  // for ever (and keep their files): they end here, saying why.
  for (const job of db.jobs) {
    if (["done", "failed", "cancelled"].includes(job.status)) continue;
    if (gone.has(job.printerId) || job.agentId === agent.id) {
      jobs.finish(job, "failed", "That printer's computer was removed from the printing page. Print it again on another printer.");
    }
  }
  save();
  jobs.broadcastQueue();
  return true;
}

app.delete("/api/manage/computers/:id", (req, res) => {
  if (!removeComputer(req.params.id)) {
    res.status(404).json({ error: "No such computer." });
    return;
  }
  res.json({ ok: true });
});

// --- where am I? ----------------------------------------------------------
//
// Feeds the poster and the manage page: the addresses other devices should
// use to reach this website.

function localAddresses() {
  const out = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const entry of interfaces[name] || []) {
        if (entry.family !== "IPv4" && entry.family !== 4) continue;
        if (entry.internal) continue;
        out.push(entry.address);
      }
    }
  } catch (err) {
    // some locked-down setups refuse to list network cards; the caller can
    // still add the address a browser used to reach us
  }
  // Ordinary office addresses first; self-assigned 169.254.x.x ones last.
  const rank = (a) => (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) ? 0 : a.startsWith("169.254.") ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

// The number address the visitor's own browser used to reach us, if it was a
// number (e.g. http://192.168.1.20:3000). It is proof that address works, so
// it is a safe fallback when the computer won't list its network cards.
function addressFromRequest(req) {
  const candidates = [];
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  candidates.push(host);
  if (req.socket && req.socket.localAddress) {
    candidates.push(String(req.socket.localAddress).replace(/^::ffff:/, ""));
  }
  for (const c of candidates) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(c) && !c.startsWith("127.") && c !== "0.0.0.0") return c;
  }
  return null;
}

function hostnameAddress() {
  // macOS already publishes <name>.local over Bonjour, and iPhones, Macs
  // and recent Windows and Android can all find it - a friendlier address
  // than four numbers, when it works.
  let name = os.hostname();
  if (!name) return null;
  name = name.replace(/\.$/, "");
  if (!name.includes(".")) name = name + ".local";
  if (!name.endsWith(".local")) return null;
  return name;
}

function whereInfo(req) {
  // The network cards are listed afresh on every call, so a new address
  // (after a power cut or a router restart) shows up straight away.
  const addresses = localAddresses();
  const seen = addressFromRequest(req);
  if (seen && !addresses.includes(seen)) addresses.unshift(seen);
  const hostname = hostnameAddress();
  return {
    port: PORT,
    addresses: addresses.map((a) => "http://" + a + ":" + PORT),
    hostnameUrl: hostname ? "http://" + hostname + ":" + PORT : null,
    best: addresses.length ? "http://" + addresses[0] + ":" + PORT : null,
  };
}

app.get("/api/where", (req, res) => {
  res.json(whereInfo(req));
});

// The "Refresh address" button on the print page. Looks at the network cards
// again and restarts the part that answers "where is the printing website?"
// from other computers (it can be paused after a network change), so they find
// this computer at its current address. Answers with the current addresses.
let lastRefreshAt = 0;
app.post("/api/refresh-address", (req, res) => {
  const now = Date.now();
  let restarted = false;
  if (now - lastRefreshAt > 2000) {
    lastRefreshAt = now;
    restarted = beginResponder();
  }
  res.json(Object.assign({ ok: true, id: db.serverId, name: os.hostname(), restarted }, whereInfo(req)));
});

// --- errors ---------------------------------------------------------------

// --- remote printing ("the fax") --------------------------------------------
//
// A few chosen people print from anywhere with a personal code, through
// PrintBridge's online drop page (see lib/remote.js and relay/). Connecting
// the page and managing the people only works on this computer itself;
// approving a waiting printout works from anywhere in the office.

const remote = require("./lib/remote");

function fromThisComputer(req) {
  const a = String(req.socket.remoteAddress || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
// Problems are shown on the page as they are (they are written for people).
function remoteAsync(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message || "That didn't work." });
  });
}
function onlyHere(req, res, next) {
  if (fromThisComputer(req)) return next();
  res.status(403).json({ error: "Open this page on the main computer itself to change remote printing." });
}

app.get("/api/remote", (req, res) => {
  const s = remote.status();
  if (!fromThisComputer(req)) {
    res.json({ local: false, connected: s.connected, pending: s.pending, printers: s.printers });
    return;
  }
  res.json(Object.assign({ local: true }, s));
});
app.post("/api/remote/connect", onlyHere, remoteAsync(async (req, res) => {
  await remote.connect(req.body.relayUrl, req.body.claim);
  res.json({ ok: true });
}));
app.post("/api/remote/disconnect", onlyHere, (req, res) => {
  remote.disconnect();
  res.json({ ok: true });
});
app.post("/api/remote/people", onlyHere, remoteAsync(async (req, res) => {
  res.json(await remote.addPerson(req.body || {}));
}));
app.post("/api/remote/people/:id", onlyHere, remoteAsync(async (req, res) => {
  res.json({ person: await remote.updatePerson(req.params.id, req.body || {}) });
}));
app.post("/api/remote/people/:id/new-code", onlyHere, remoteAsync(async (req, res) => {
  res.json(await remote.newCodeFor(req.params.id));
}));
app.delete("/api/remote/people/:id", onlyHere, remoteAsync(async (req, res) => {
  await remote.removePerson(req.params.id);
  res.json({ ok: true });
}));
app.post("/api/remote/pending/:id/approve", remoteAsync(async (req, res) => {
  await remote.approve(req.params.id, req.body && req.body.printer);
  res.json({ ok: true });
}));
app.post("/api/remote/pending/:id/reject", (req, res) => {
  remote.reject(req.params.id);
  res.json({ ok: true });
});

remote.start({
  file: path.join(path.dirname(require("./lib/store").DATA_FILE), "remote.json"),
  db, jobs, agents, readyToPrint,
  uploadDir: UPLOAD_DIR,
  log: (line) => console.log("  " + line),
});

app.use((err, req, res, next) => {
  if (req.file && req.file.path) fs.unlink(req.file.path, () => {});

  if (err && (err.code === "LIMIT_FILE_SIZE" || err.type === "entity.too.large")) {
    res.status(400).json({ error: "That file is bigger than " + MAX_UPLOAD_MB + " MB." });
    return;
  }
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong on the server." });
});

// --- start ----------------------------------------------------------------

// Answer "where is the printing website?" from other computers, so they
// find this one by themselves whatever address it has today (see
// agent/lib/find.js). Not when run as a plain website for development
// with NO_DISCOVERY=1. Calling it again restarts the answering (used by the
// "Refresh address" button). Returns true if it was started.
let stopResponder = null;
function beginResponder() {
  if (process.env.NO_DISCOVERY === "1") return false;
  if (steppedDown) return false; // another main computer has taken over
  if (stopResponder) {
    try { stopResponder(); } catch (err) { /* already stopped */ }
    stopResponder = null;
  }
  stopResponder = require("../agent/lib/find").startResponder(
    () => ({ id: db.serverId, name: os.hostname(), port: PORT, version: VERSION, claimAt: claimAt() }),
    { log: (line) => console.log("  " + line) }
  );
  return true;
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });

wss.on("connection", (socket) => agents.handleConnection(socket));
agents.startHeartbeat(wss);

setInterval(() => {
  jobs.sweepUploads();
}, 60 * 60 * 1000);
setInterval(() => held.sweep(), 10 * 60 * 1000);

server.listen(PORT, () => {
  const addresses = localAddresses();
  const hostname = hostnameAddress();

  console.log("");
  console.log("  Printing is ready.");
  console.log("");
  console.log("  On this computer:   http://localhost:" + PORT);
  for (const address of addresses) {
    console.log("  On the network:     http://" + address + ":" + PORT);
  }
  if (hostname) {
    console.log("  Or try:             http://" + hostname + ":" + PORT);
  }
  console.log("");
  console.log("  Print the sign for the wall: http://localhost:" + PORT + "/poster.html");
  console.log("");

  beginResponder();
  if (claimAt()) console.log("  This is the only main computer: any other on this network switches over to it.");
  watchForTakeover();
});
