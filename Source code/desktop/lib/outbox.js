// Printouts sent to the "PrintBridge" printer (see vprinter.js).
//
// Each one ends up in the same one file in the outbox folder: on Windows
// the printer writes it there itself, on a Mac it arrives over a socket
// and is put there by vprinter.mac.js. This part of the background program
// notices it, moves it out of the way (so the next printout can't
// overwrite it), sends it to the printing website, and opens the print
// page on it in the web browser. There the person sees a preview, picks a
// real printer and presses Print - just like a dropped file.
//
// It runs on every computer with the printer: the main computer, printer
// computers and computers that only print ("client").

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const P = require("./paths");
const B = require("./brand");
const T = require("../../agent/lib/theme");
const vprinter = require("./vprinter");
const { openInBrowser } = require("./win");

const CHECK_EVERY_MS = 250; // as well as reacting the moment the folder changes
const SERVER_CACHE = () => path.join(P.OUTBOX_DIR, "server.json");
const UNSENT_DIR = () => path.join(P.OUTBOX_DIR, "not sent");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- finding the printing website ------------------------------------------

function request(method, url, body, timeoutMs, headers) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch (err) { return resolve(null); }
    const req = http.request({
      method,
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      timeout: timeoutMs || 3000,
      headers: Object.assign(body ? { "Content-Length": body.length } : {}, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (err) { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    if (body) req.write(body);
    req.end();
  });
}

// What the printing website at `base` says about itself, or null if it
// isn't one (or doesn't answer).
async function aboutWebsite(base, timeoutMs) {
  const r = await request("GET", base + "/api/office-printing", null, timeoutMs || 2500);
  return r && r.status === 200 && r.json && r.json.app === "office-printing" ? r.json : null;
}

async function isWebsite(base) {
  return !!(await aboutWebsite(base));
}

function normalise(address) {
  let a = String(address || "").trim().replace(/\/+$/, "");
  if (!a) return "";
  if (/^wss?:\/\//i.test(a)) a = a.replace(/^ws/i, "http").replace(/\/agent$/i, "");
  if (!/^[a-z]+:\/\//i.test(a)) a = "http://" + a;
  try {
    const u = new URL(a);
    return u.protocol + "//" + u.hostname + ":" + (u.port || P.PORT);
  } catch (err) {
    return "";
  }
}

// A computer name that is safe to try as an address ("FRONT-DESK").
function nameAddress(name) {
  const n = String(name || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(n) ? normalise(n) : "";
}

// The address of the printing website, checked to be answering. Looks in
// what this computer already knows first; searches the network only when
// `search` is true. options.tcp === false keeps the search to the quick
// "ask the network" kind (see agent/lib/find.js).
async function findWebsite(search, options) {
  const opts = options || {};
  const settings = P.readSettings();
  const cached = P.readJson(SERVER_CACHE()) || {};
  const candidates = [];
  if (settings.role === "main") candidates.push("http://localhost:" + P.PORT);
  // The last address that worked comes first: it is right almost always, and
  // each address that doesn't answer costs a second or two.
  if (cached.url) candidates.push(normalise(cached.url));
  const status = P.readJson(path.join(P.PRINTER_DIR, "status.json"));
  if (status && status.website) candidates.push(normalise(status.website));
  const config = P.readJson(path.join(P.PRINTER_DIR, "config.json"));
  if (config && config.serverUrl) candidates.push(normalise(config.serverUrl));
  // The address someone typed into Setup comes before the computer name
  // remembered from last time.
  if (settings.server) candidates.push(normalise(settings.server));
  // The main computer's name ("FRONT-DESK") still reaches it after its
  // address has changed, on most office networks.
  const knownName = cached.name || (config && config.serverName) || "";
  if (nameAddress(knownName)) candidates.push(nameAddress(knownName));

  const wantedId = cached.id || (config && config.serverId) || "";
  for (const base of [...new Set(candidates.filter(Boolean))]) {
    const about = await aboutWebsite(base, 1500);
    if (about) {
      remember(base, about);
      return base;
    }
  }
  if (!search) return null;

  const { findServers } = require("../../agent/lib/find");
  const found = await findServers({ tcp: opts.tcp !== false });
  if (!found.length) return null;
  const pick = (wantedId && found.find((f) => f.id === wantedId)) || found[0];
  remember(pick.httpBase, pick);
  return pick.httpBase;
}

function remember(base, about) {
  try {
    P.ensureDirs();
    const previous = P.readJson(SERVER_CACHE()) || {};
    const next = {
      url: base,
      id: (about && about.id) || (previous.url === base ? previous.id : "") || "",
      name: (about && about.name) || (previous.url === base ? previous.name : "") || "",
    };
    if (previous.url === next.url && previous.id === next.id && previous.name === next.name) return;
    P.writeJson(SERVER_CACHE(), Object.assign(next, { at: Date.now() }));
  } catch (err) {
    /* only a shortcut for next time */
  }
}

// Every minute, on a computer that isn't the main one, check that the
// printing website still answers where it was last seen, and if not, ask
// the network where it is now (quietly - nobody is waiting). So after a
// power cut or a router restart, this computer already knows the main
// computer's new address before anyone prints. A full knock-on-every-door
// search only every 10 minutes at most, and only while it can't be found.
function keepWebsiteFound(log) {
  let lastFull = 0;
  let lastFound = null;
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      if (P.readSettings().role === "main") return;
      // Where start() already found it (and logged it), so that isn't said twice.
      if (lastFound === null) lastFound = (P.readJson(SERVER_CACHE()) || {}).url || "";
      let base = await findWebsite(false);
      if (!base) {
        const full = Date.now() - lastFull > 10 * 60 * 1000;
        if (full) lastFull = Date.now();
        base = await findWebsite(true, { tcp: full });
      }
      if (base && base !== lastFound) log.line("The printing website is at " + base + ".");
      if (!base && lastFound) log.line("The printing website can't be found right now; still looking.");
      lastFound = base || "";
    } catch (err) {
      /* next time */
    } finally {
      busy = false;
    }
  };
  return setInterval(check, 60 * 1000);
}

// --- taking printouts ---------------------------------------------------------

// Windows keeps the file open while it writes it, and a file that is open
// can't be renamed - so a successful rename means it is finished. (On a
// Mac the file is only put there once it has arrived in full, and a
// printout that somehow is still short is caught by looksComplete below.)
function grab() {
  const from = vprinter.portPath();
  if (!fs.existsSync(from)) return null;
  const to = path.join(P.OUTBOX_DIR, "taken-" + Date.now() + ".pdf");
  try {
    fs.renameSync(from, to);
    return to;
  } catch (err) {
    return null; // still being written
  }
}

function looksComplete(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size < 64) return false;
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(5);
    const tail = Buffer.alloc(Math.min(1024, size));
    fs.readSync(fd, head, 0, 5, 0);
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return head.toString("latin1") === "%PDF-" && tail.toString("latin1").includes("%%EOF");
  } catch (err) {
    return false;
  } finally {
    // Closed even when reading threw - this is asked up to 51 times for
    // every printout, and something else holding the file open (the
    // spooler, or security software scanning it) is exactly the case that
    // throws. Without this, each such printout left a handful of files
    // open for good, and after enough of them nothing in here could open
    // a file at all.
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (err) { /* already gone */ }
    }
  }
}

function timeLabel() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return two(d.getHours()) + "." + two(d.getMinutes());
}

async function send(item, log) {
  const file = item.file;
  for (let i = 0; i < 50 && !looksComplete(file); i++) await wait(400);
  if (!looksComplete(file)) {
    log.line("A printout arrived that isn't a complete PDF; ignored it.");
    discard(file);
    return;
  }

  let name = "";
  try { name = await item.name; } catch (err) { /* a name is only a nicety */ }
  if (!name) name = "Printout at " + timeLabel();

  const body = fs.readFileSync(file);
  let answer = null; // the last answer from a website that did answer
  for (let attempt = 1; attempt <= 3; attempt++) {
    const base = await findWebsite(attempt > 1);
    if (base) {
      const r = await request("POST", base + "/api/uploads/printout?name=" + encodeURIComponent(name), body, 60000,
        { "Content-Type": "application/pdf" });
      if (r && r.status === 200 && r.json && r.json.openUrl) {
        log.line('Sent "' + name + '" to the print page (' + base + ").");
        openInBrowser(base + r.json.openUrl);
        discard(file);
        return;
      }
      log.line("The printing website didn't take \"" + name + "\" (" + (r ? "answer " + r.status : "no answer") + ").");
      if (r) answer = r;
      // The website looked at it and said no (too big, or not a PDF): no
      // point trying again, and nothing worth keeping - say why.
      if (r && (r.status === 400 || r.status === 413)) {
        discard(file);
        showProblem(name, "", (r.json && r.json.error) || "The printing website didn't accept it.", true);
        return;
      }
      // Any other refusal (an older main computer that doesn't take
      // printouts yet, for example) won't change by trying again either.
      if (r && r.status >= 400 && r.status < 500) break;
    }
    await wait(3000);
  }

  // Not sent: keep the printout and say so, plainly.
  let kept = "";
  try {
    fs.mkdirSync(UNSENT_DIR(), { recursive: true });
    // Only the extension a program adds ("Budget.xlsx") is dropped - not
    // just any dot, which turned "Printout at 12.30" into "Printout at 12".
    kept = path.join(UNSENT_DIR(), safeFileName(name.replace(/\.(pdf|docx?|xlsx?|xlsm|pptx?|txt|rtf|odt|ods|odp|csv|html?|png|jpe?g)$/i, "")) + " " + Date.now() + ".pdf");
    fs.renameSync(file, kept);
  } catch (err) {
    kept = "";
  }
  if (answer) {
    log.line('The printing website answered but couldn\'t take "' + name + '" (answer ' + answer.status + "), so it was not sent.");
    showProblem(name, kept, answer.status >= 500
      ? "The main computer had a problem taking it in (" + ((answer.json && answer.json.error) || "answer " + answer.status) + ")."
      : "The main computer wouldn't take it (answer " + answer.status + "). If the main computer has an older version of " + B.NAME + ", run the latest Setup on it.");
  } else {
    log.line('Couldn\'t reach the printing website, so "' + name + '" was not sent.');
    showProblem(name, kept);
  }
}

// Windows file names can't hold \ / : * ? " < > | (a job name can).
function safeFileName(text) {
  return String(text).replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/[. ]+$/, "").trim().slice(0, 120) || "Printout";
}

// A printout that has been dealt with. If it can't be deleted (security
// software still scanning it), it is at least renamed so it isn't taken for
// a leftover and sent a second time when this part next starts.
function discard(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    try { fs.renameSync(file, file.replace(/taken-(\d+)\.pdf$/, "sent-$1.pdf")); } catch (e) { /* tidy() gets it later */ }
  }
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Where "Check PrintBridge" is on this computer (the same words check.js uses).
const WHERE_SHORTCUTS = P.IS_MAC ? "the &quot;" + esc(B.NAME) + "&quot; folder in Applications" : "the Start menu";

function showProblem(name, kept, reason, refused) {
  // One file per printout. When the main computer is off and several
  // things are printed in a row, each page used to be written over the
  // same name, so the pages already open in the browser silently changed
  // to a later document's - telling someone their spreadsheet failed when
  // the page in front of them was about a different file entirely.
  const file = path.join(os.tmpdir(), "office-printing-not-sent-" + Date.now() + ".html");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not printed</title>
${T.head()}
<style>${T.CSS}
body{font:16px/1.55 "Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--ink);padding:40px 16px;margin:0}
main{max-width:620px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:26px 28px}
h1{font-size:22px;margin:0 0 10px;color:var(--brand-text)} .bar{height:5px;background:linear-gradient(90deg,${B.PRIMARY} 0 80%,${B.ACCENT} 80%);border-radius:3px;margin:0 0 18px}
li{margin:6px 0} code{background:var(--code);padding:1px 5px;border-radius:4px} .credit{margin:22px 0 0;color:var(--soft);font-size:13px}</style></head><body>${T.button()}<main>
<div class="bar"></div><h1>"${esc(name)}" wasn't printed</h1>
${reason ? `<p>${esc(reason)}</p>${refused ? "<p>Try printing fewer pages at a time, or save it as a PDF and drop it on the print page.</p>" : "<p>Try printing it again in a minute. If this keeps happening, open <b>Check " + esc(B.NAME) + "</b> from " + WHERE_SHORTCUTS + ".</p>"}` : `<p>It couldn't be sent to the printing page, because the main computer didn't answer.</p>
<ul><li>Check that the main computer is switched on (nobody needs to be signed in to it).</li>
<li>Check that this computer is on the office Wi-Fi or network.</li>
<li>Then print it again. If this keeps happening, open <b>Check ${esc(B.NAME)}</b> from ${WHERE_SHORTCUTS}.</li></ul>`}
${kept ? `<p>A copy was kept here for a week, in case you need it:<br><code>${esc(kept)}</code></p>` : ""}
<p class="credit">${esc(B.NAME)} &middot; ${B.CREDIT_HTML}</p>
</main></body></html>`;
  try {
    fs.writeFileSync(file, html);
    openInBrowser(file);
  } catch (err) {
    /* nothing more to do */
  }
}

// --- running -------------------------------------------------------------------

function tidy() {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [dir, cutoff] of [[P.OUTBOX_DIR, dayAgo], [UNSENT_DIR(), weekAgo]]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (err) { continue; }
    for (const n of names) {
      if (dir === P.OUTBOX_DIR && !/^(taken|sent)-\d+\.pdf$/.test(n)) continue;
      const full = path.join(dir, n);
      try { if (fs.statSync(full).isFile() && fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true }); } catch (err) { /* ignore */ }
    }
  }
  // The "wasn't printed" pages now get a name each (see showProblem), so
  // yesterday's are cleared out here rather than being left to pile up.
  try {
    for (const n of fs.readdirSync(os.tmpdir())) {
      if (!/^office-printing-not-sent-\d+\.html$/.test(n)) continue;
      const full = path.join(os.tmpdir(), n);
      try { if (fs.statSync(full).mtimeMs < dayAgo) fs.rmSync(full, { force: true }); } catch (err) { /* ignore */ }
    }
  } catch (err) {
    /* the temp folder is Windows' to tidy anyway */
  }
}

function start() {
  const { logger } = require("./log");
  const log = logger("printouts");
  P.ensureDirs();
  tidy();
  // And every few hours - a computer that is never switched off would
  // otherwise keep every "wasn't printed" page and copy for good.
  setInterval(() => { try { tidy(); } catch (err) { /* next time */ } }, 6 * 60 * 60 * 1000);
  log.line("Watching for printouts sent to the \"" + B.NAME + "\" printer.");
  keepWebsiteFound(log);
  // On a Mac the printer sends each printout here rather than writing the
  // file itself, so this listens for them; on Windows it does nothing.
  vprinter.startCapture(log);

  // Printouts left from before a restart are handled first.
  let busy = false;
  const leftovers = fs.readdirSync(P.OUTBOX_DIR).filter((n) => /^taken-\d+\.pdf$/.test(n)).map((n) => path.join(P.OUTBOX_DIR, n));
  const queue = leftovers.map((file) => ({ file, name: Promise.resolve("") }));
  let naming = null; // the name of the printout being written right now

  const tick = async () => {
    if (fs.existsSync(vprinter.portPath())) {
      // Ask for its name while it is still in the printer's list.
      if (!naming) naming = vprinter.currentJobName().catch(() => "");
      const taken = grab();
      if (taken) {
        queue.push({ file: taken, name: naming });
        naming = null;
      }
    } else if (naming) {
      // The printout went away before it could be taken - the job was
      // cancelled in the Windows print queue, or something else removed
      // it. Its name is forgotten here, because otherwise the next
      // printout would be sent and filed under the cancelled one's name.
      naming = null;
    }
    if (busy || !queue.length) return;
    busy = true;
    const next = queue.shift();
    try {
      await send(next, log);
    } catch (err) {
      log.line("Problem with a printout: " + (err && err.message ? err.message : err));
    } finally {
      busy = false;
    }
  };
  // Every one of these catches: an error escaping a timer would end this
  // program, and with it the watching of printouts, until the supervisor
  // noticed and started it again.
  const safeTick = () => { Promise.resolve().then(tick).catch((err) => log.line("Problem while checking for printouts: " + (err && err.message ? err.message : err))); };
  setInterval(safeTick, CHECK_EVERY_MS);
  // React straight away when a printout appears, so the next one can't
  // overwrite it before it is moved aside.
  try {
    fs.watch(P.OUTBOX_DIR, (event, name) => {
      if (!name || String(name).toLowerCase() === vprinter.PORT_FILE_NAME) safeTick();
    });
  } catch (err) {
    /* polling alone still works */
  }

  // Know where the website is before the first printout, and keep that fresh.
  findWebsite(true)
    .then((base) => log.line(base ? "The printing website is at " + base + "." : "The printing website wasn't found yet."))
    .catch(() => log.line("The printing website wasn't found yet."));
  // ...and keep that fresh: see keepWebsiteFound() above.
}

module.exports = { start, findWebsite, isWebsite, normalise, request };
