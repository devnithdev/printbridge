// Print jobs: creating them, sending them to an agent, following their
// status, trying another printer when one fails, and cleaning up files.
//
// A job belongs to a "device" (a browser that has been here before) and
// carries a friendly label so people can find their own pages at the tray.

const fs = require("fs");
const path = require("path");
const { db, save } = require("./store");
const { newId, newToken, hashToken } = require("./ids");
const agents = require("./agents");

const UPLOAD_DIR = process.env.PRINT_UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const FILE_LINK_MINUTES = 30;
const JOB_HISTORY = 200; // how many finished jobs to keep

// Statuses a job can be in. "queued" means waiting for its agent to come
// online; the others come from the agent itself.
const FINISHED = new Set(["done", "failed", "cancelled"]);

// --- live updates to the browser (Server-Sent Events) -------------------

const listeners = new Set(); // { deviceId, res }

function addListener(deviceId, res) {
  const entry = { deviceId, res };
  listeners.add(entry);
  res.on("close", () => listeners.delete(entry));
  return entry;
}

// The queue is the same for everybody except for which row says "You", so
// each listener gets their own copy.
function broadcastQueue() {
  for (const entry of listeners) {
    try {
      entry.res.write(
        "event: queue\ndata: " + JSON.stringify(listActiveQueue(entry.deviceId)) + "\n\n"
      );
    } catch (err) {
      listeners.delete(entry);
    }
  }
}

// Used by the Help button. With no accounts there is no "the admin", so a
// call for help goes to everyone looking at the page - whoever is nearest
// can deal with it.
function broadcastToEveryone(eventName, payload) {
  const message = "event: " + eventName + "\ndata: " + JSON.stringify(payload) + "\n\n";
  for (const entry of listeners) {
    try {
      entry.res.write(message);
    } catch (err) {
      listeners.delete(entry);
    }
  }
}

// What the browser is allowed to see about one job. Never the file token.
function publicJob(job, viewerDeviceId) {
  const isMine = job.deviceId === viewerDeviceId;
  return {
    id: job.id,
    fileName: job.fileName,
    label: job.label,
    printerName: job.printerName,
    printerId: job.printerId,
    status: job.status,
    statusMessage: job.statusMessage,
    options: job.options,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    isMine,
  };
}

// --- options ------------------------------------------------------------

const SIDES = new Set(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]);
// "auto" turns each page to suit the paper; "fit" shrinks or enlarges each
// page to fill the paper, "actual" prints it at its real size.
const ORIENTATIONS = new Set(["auto", "portrait", "landscape"]);
const SCALINGS = new Set(["fit", "actual"]);

function cleanOptions(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const copies = Math.min(Math.max(parseInt(input.copies, 10) || 1, 1), 99);
  const pageRanges = String(input.pageRanges || "").trim();

  return {
    paper: String(input.paper || "").trim().slice(0, 40) || null,
    color: input.color === "color" ? "color" : "monochrome",
    sides: SIDES.has(input.sides) ? input.sides : "one-sided",
    copies,
    orientation: ORIENTATIONS.has(input.orientation) ? input.orientation : "auto",
    scaling: SCALINGS.has(input.scaling) ? input.scaling : "fit",
    // Only allow things like 1, 2-5, 1,3,7-9
    pageRanges: /^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/.test(pageRanges)
      ? pageRanges
      : "",
  };
}

// Trim the requested options down to what this printer can really do.
// A black-and-white printer should still print, just not in colour.
function clampOptions(options, printer) {
  const caps = printer.capabilities || {};
  const out = Object.assign({}, options);

  if (caps.color === false) out.color = "monochrome";
  if (caps.duplex === false) out.sides = "one-sided";

  if (out.paper && Array.isArray(caps.paperSizes) && caps.paperSizes.length) {
    const match = caps.paperSizes.find(
      (p) => String(p).toLowerCase() === out.paper.toLowerCase()
    );
    out.paper = match || caps.defaultPaper || null;
  }

  if (caps.maxCopies) out.copies = Math.min(out.copies, Number(caps.maxCopies));
  if (caps.pageRanges === false) out.pageRanges = "";

  return out;
}

// Does this printer support what was asked for? Used for failover.
function printerSupports(printer, options) {
  const caps = printer.capabilities;
  if (!caps) return true; // unknown capabilities: give it a try

  if (options.color === "color" && caps.color === false) return false;
  if (options.sides !== "one-sided" && caps.duplex === false) return false;

  if (options.paper && Array.isArray(caps.paperSizes) && caps.paperSizes.length) {
    const wanted = options.paper.toLowerCase();
    if (!caps.paperSizes.some((p) => String(p).toLowerCase() === wanted)) return false;
  }
  return true;
}

// --- creating and sending jobs -----------------------------------------

function issueFileToken(job) {
  const token = newToken();
  job.fileTokenHash = hashToken(token);
  job.fileTokenExpiresAt = Date.now() + FILE_LINK_MINUTES * 60 * 1000;
  return token;
}

function setStatus(job, status, message) {
  job.status = status;
  job.statusMessage = message || "";
  job.updatedAt = Date.now();
  save();
  broadcastQueue();
}

function createJob({ deviceId, label, file, printer, options, allowFailover, allowOtherKind }) {
  const job = {
    id: newId("job"),
    deviceId,
    label,
    fileName: file.originalName,
    storedFile: path.basename(file.storedPath),
    printerId: printer.id,
    printerName: agents.labelOf(printer),
    agentId: printer.agentId,
    options,
    allowFailover: !!allowFailover,
    allowOtherKind: !!allowFailover && !!allowOtherKind,
    status: "queued",
    statusMessage: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fileTokenHash: null,
    fileTokenExpiresAt: 0,
    attempts: [],
    triedPrinterIds: [],
  };
  db.jobs.push(job);
  trimHistory();
  save();
  broadcastQueue();
  return job;
}

function trimHistory() {
  const finished = db.jobs.filter((j) => FINISHED.has(j.status));
  if (finished.length <= JOB_HISTORY) return;
  finished.sort((a, b) => a.updatedAt - b.updatedAt);
  const remove = finished.slice(0, finished.length - JOB_HISTORY);
  for (const job of remove) {
    deleteJobFile(job);
    const index = db.jobs.indexOf(job);
    if (index !== -1) db.jobs.splice(index, 1);
  }
}

// Send the job to the agent that owns its current printer.
function dispatch(job) {
  const printer = agents.findPrinter(job.printerId);
  if (!printer) {
    finish(job, "failed", "That printer is no longer on its computer. Print it again on another printer.");
    return false;
  }

  if (!agents.isOnline(printer.agentId)) {
    setStatus(job, "queued", "Waiting for " + agents.labelOf(printer) + " to come online.");
    return false;
  }

  const token = issueFileToken(job);
  job.agentId = printer.agentId;
  job.printerName = agents.labelOf(printer); // what people read; the computer is sent the real name below
  if (!job.triedPrinterIds.includes(printer.id)) job.triedPrinterIds.push(printer.id);

  const sent = agents.sendToAgent(printer.agentId, {
    type: "job",
    jobId: job.id,
    printer: printer.name,
    fileName: job.fileName,
    fileUrl: "/api/files/" + job.id + "/" + token,
    options: clampOptions(job.options, printer),
  });

  if (!sent) {
    setStatus(job, "queued", "Waiting for " + agents.labelOf(printer) + " to come online.");
    return false;
  }

  // Remembered so a later Cancel can say honestly whether it may already
  // be at a printer.
  job.sentAt = Date.now();
  setStatus(job, "sent", "Sent to " + agents.labelOf(printer) + ".");
  return true;
}

// Pick another printer which is online, is the same kind as this one (a
// letter must never come out of a dot matrix printer), supports the same
// options, and which we have not tried yet. None when we can't tell its kind.
// orOtherOffice: an inkjet may also go to a laser and the other way round
// (same kind is still tried first). Dot matrix and receipt never mix.
const OFFICE_SWAP = { inkjet: "laser", laser: "inkjet" };
function otherPrinterLike(printer, options, triedIds, orOtherOffice) {
  const kind = agents.kindOf(printer);
  if (kind === "unknown") return null;
  const kinds = orOtherOffice && OFFICE_SWAP[kind] ? [kind, OFFICE_SWAP[kind]] : [kind];
  for (const k of kinds) {
    const found = db.printers.find(
      (p) =>
        p.id !== printer.id &&
        !triedIds.includes(p.id) &&
        !p.hidden &&
        !p.broken &&
        agents.isOnline(p.agentId) &&
        agents.kindOf(p) === k &&
        printerSupports(p, options)
    );
    if (found) return found;
  }
  return null;
}

function findFallbackPrinter(job) {
  const current = agents.findPrinter(job.printerId);
  return current ? otherPrinterLike(current, job.options, job.triedPrinterIds, job.allowOtherKind) : null;
}

function finish(job, status, message) {
  setStatus(job, status, message);
  if (FINISHED.has(status)) {
    // The uploaded file is not needed any more.
    deleteJobFile(job);
    job.fileTokenHash = null;
    job.fileTokenExpiresAt = 0;
    save();
  }
}

function deleteJobFile(job) {
  if (!job.storedFile) return;
  const full = path.join(UPLOAD_DIR, job.storedFile);
  fs.unlink(full, () => {});
  job.storedFile = null;
}

// --- messages coming back from agents -----------------------------------

function handleAgentStatus({ agentId, jobId, status, message, noFailover }) {
  const job = db.jobs.find((j) => j.id === jobId);
  if (!job) return;
  if (job.agentId !== agentId) return; // an agent may only touch its own jobs
  // A job that has already ended (printed, failed, or cancelled by the
  // person who sent it) stays ended. A late message - an agent repeating
  // itself after reconnecting, say - must not turn "done" into "failed",
  // bring a cancelled job back, or send it to yet another printer.
  if (FINISHED.has(job.status)) return;

  if (status === "failed") {
    job.attempts.push({
      printerId: job.printerId,
      printerName: job.printerName,
      agentId,
      at: Date.now(),
      result: "failed: " + (message || "unknown error"),
    });

    // Not when the agent says it may already have printed (it restarted
    // part-way through): another printer would then make a second copy.
    if (job.allowFailover && !noFailover) {
      const fallback = findFallbackPrinter(job);
      if (fallback) {
        job.printerId = fallback.id;
        job.printerName = agents.labelOf(fallback);
        setStatus(job, "retrying", "Printer failed, trying " + agents.labelOf(fallback) + " instead.");
        dispatch(job);
        return;
      }
    }

    finish(job, "failed", message || "Printing failed.");
    return;
  }

  if (status === "done") {
    job.attempts.push({
      printerId: job.printerId,
      printerName: job.printerName,
      agentId,
      at: Date.now(),
      result: "done",
    });
    finish(job, "done", message || "Printed on " + job.printerName + ".");
    return;
  }

  if (["downloading", "printing", "accepted"].includes(status)) {
    setStatus(job, status, message || "");
  }
}

// Jobs that were on their way to a printer when the website last stopped
// (the main computer restarted, say) would otherwise sit at "sent" or
// "printing" for ever: nothing sends them again, since only waiting jobs
// are sent when a computer connects, and they can't be cancelled either.
// They wait again instead. The computer that had one remembers it (see
// handleJob in agent.js), so a job it had already printed is not printed
// a second time - it just reports how it went.
function requeueUnfinished() {
  let changed = false;
  for (const job of db.jobs || []) {
    if (FINISHED.has(job.status) || job.status === "queued") continue;
    // It was on its way to a printer (jobs from before sentAt existed too).
    if (!job.sentAt) job.sentAt = job.updatedAt || Date.now();
    job.status = "queued";
    job.statusMessage = "Waiting for " + (job.printerName || "the printer") + "'s computer to reconnect.";
    job.updatedAt = Date.now();
    changed = true;
  }
  if (changed) save();
}
requeueUnfinished();

// When an agent comes online, send it anything that was waiting.
function dispatchQueuedFor(agentId) {
  for (const job of db.jobs) {
    if (job.status !== "queued") continue;
    const printer = agents.findPrinter(job.printerId);
    // A printer its computer no longer lists fails here instead of waiting forever.
    if (printer ? printer.agentId === agentId : job.agentId === agentId) dispatch(job);
  }
}

// A printer removed or renamed on a computer that is online: its waiting jobs fail.
function failOrphanedJobs() {
  for (const job of db.jobs) {
    if (job.status !== "queued" || agents.findPrinter(job.printerId)) continue;
    if (agents.isOnline(job.agentId)) dispatch(job);
  }
}

// If an agent disappears mid-job, don't leave the job hanging forever.
function handleAgentOffline(agentId) {
  for (const job of db.jobs) {
    if (job.agentId !== agentId) continue;
    if (FINISHED.has(job.status)) continue;
    if (job.status === "queued") continue;

    // It never moves to another printer from here: the computer may already
    // have the file, and would print it too once it's back - a copy on the
    // wrong printer. It waits for its own computer, which reports how it went.
    setStatus(job, "queued", "That computer went offline. Waiting for it to return.");
  }
}

// --- file links ---------------------------------------------------------

function fileForToken(jobId, token) {
  const job = db.jobs.find((j) => j.id === jobId);
  if (!job || !job.fileTokenHash || !job.storedFile) return null;
  if (job.fileTokenExpiresAt < Date.now()) return null;
  if (hashToken(token) !== job.fileTokenHash) return null;
  return { job, fullPath: path.join(UPLOAD_DIR, job.storedFile) };
}

// Delete stray uploads (for example from a crash) that nothing points to.
function sweepUploads(alsoKeep = []) {
  const keep = new Set(db.jobs.map((j) => j.storedFile).filter(Boolean).concat(alsoKeep));
  let files = [];
  try {
    files = fs.readdirSync(UPLOAD_DIR);
  } catch (err) {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of files) {
    if (keep.has(name)) continue;
    const full = path.join(UPLOAD_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch (err) {
      /* ignore */
    }
  }
}

// --- the shared queue ----------------------------------------------------
//
// Rough wait-time guess, not a promise: about a minute and a half per job
// ahead of yours on the same printer. A job already being handled by the
// agent is assumed to be nearly done.
const AVG_JOB_SECONDS = 90;
const IN_PROGRESS = new Set(["sent", "accepted", "downloading", "printing"]);

// Returns null when there is no honest estimate to give - a job waiting on
// a printer whose computer is switched off could sit there all weekend.
function estimateWaitSeconds(job, aheadOnSamePrinter, printerOnline) {
  if (!printerOnline) return null;
  if (IN_PROGRESS.has(job.status)) return 20;
  return Math.max(20, aheadOnSamePrinter * AVG_JOB_SECONDS + 20);
}

// Jobs on their way to a printer (not ones still waiting their turn).
function countInProgress() {
  return db.jobs.filter((j) => IN_PROGRESS.has(j.status)).length;
}

// Everyone sees every job that is still going, with whose it is, because
// that is how you find your own pages at the tray. File names show only to
// the person who sent them - what you print is nobody else's business.
function listActiveQueue(viewerDeviceId) {
  const active = db.jobs
    .filter((j) => !FINISHED.has(j.status))
    .sort((a, b) => a.createdAt - b.createdAt);

  const byPrinter = new Map();
  for (const job of active) {
    if (!byPrinter.has(job.printerId)) byPrinter.set(job.printerId, []);
    byPrinter.get(job.printerId).push(job);
  }

  return active.map((job, index) => {
    const samePrinter = byPrinter.get(job.printerId);
    const aheadOnSamePrinter = samePrinter.indexOf(job);
    const isMine = job.deviceId === viewerDeviceId;

    const printer = agents.findPrinter(job.printerId);
    const printerOnline = printer ? agents.isOnline(printer.agentId) : false;

    return {
      id: job.id,
      position: index + 1,
      label: job.label,
      printerName: printer ? agents.labelOf(printer) : job.printerName, // the name people see now
      printerId: job.printerId,
      printerOnline,
      printerProblem: printerOnline ? agents.problemOf(printer) : "",
      status: job.status,
      statusMessage: isMine ? job.statusMessage : "",
      etaSeconds: estimateWaitSeconds(job, aheadOnSamePrinter, printerOnline),
      isMine,
      fileName: isMine ? job.fileName : null,
    };
  });
}

// This device's own recent jobs, finished ones included.
function listJobsForDevice(deviceId, limit) {
  return db.jobs
    .filter((j) => j.deviceId === deviceId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit || 20)
    .map((j) => publicJob(j, deviceId));
}

// Wire up the agent events.
agents.events.on("status", handleAgentStatus);
agents.events.on("agent-online", dispatchQueuedFor);
agents.events.on("printers-changed", failOrphanedJobs);
agents.events.on("agent-offline", handleAgentOffline);

// A printer going on or offline changes what the queue should say (a wait
// time, or "waiting for the printer") even when no job itself changed.
agents.events.on("agent-online", broadcastQueue);
agents.events.on("agent-offline", broadcastQueue);
agents.events.on("health-changed", broadcastQueue);

// "Clear this printer's queue" (Printers & setup): nothing still waiting for
// that printer is printed, and its computer empties the printer's own queue.
// Returns how many of PrintBridge's own jobs were cancelled.
function clearPrinter(printer) {
  let n = 0;
  for (const job of db.jobs.filter((j) => j.printerId === printer.id && !FINISHED.has(j.status))) {
    finish(job, "cancelled", "Cleared from " + agents.labelOf(printer) + "'s queue at the office. Send it again if you still need it.");
    n++;
  }
  agents.sendToAgent(printer.agentId, { type: "clear-queue", printer: printer.name });
  return n;
}

// Nothing waits more than an hour, for any reason (a printer switched off,
// its computer gone...): it is taken off the queue and its file deleted.
const MAX_WAIT_MS = 60 * 60 * 1000;
function expireOld(now = Date.now()) {
  for (const job of db.jobs.filter((j) => !FINISHED.has(j.status) && j.createdAt < now - MAX_WAIT_MS)) {
    finish(job, "cancelled", job.sentAt
      ? "Stopped after waiting over an hour. It had already been sent to " + (job.printerName || "the printer") + ", so it may still come out."
      : "Not printed: it waited over an hour. Send it again if you still need it.");
  }
}

module.exports = {
  expireOld,
  clearPrinter,
  cleanOptions,
  clampOptions,
  printerSupports,
  createJob,
  dispatch,
  findFallbackPrinter,
  otherPrinterLike,
  fileForToken,
  listActiveQueue,
  countInProgress,
  listJobsForDevice,
  addListener,
  broadcastToEveryone,
  broadcastQueue,
  sweepUploads,
  publicJob,
  setStatus,
  finish,
  UPLOAD_DIR,
};
