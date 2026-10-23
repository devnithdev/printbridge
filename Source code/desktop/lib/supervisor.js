// The background program.
//
// It runs, as separate processes with no window:
//   - "website"  - the printing website, on the main computer only,
//   - "printer"  - the part that shares this computer's printers (not on a
//                  computer that only prints), and
//   - "outbox"   - the part that takes printouts from the "PrintBridge"
//                  printer to the print page.
// If one stops for any reason, it is started again a few seconds later.
//
// How it is started (see main.js):
//
//   Windows, "service" - by a task Windows runs when it STARTS, before
//       anyone signs in (see service.js). Runs the website and printer
//       sharing. So after a power cut, printing comes back as soon as the
//       computers are switched on, with nobody needing to sign in.
//   Windows, "start" - when someone signs in. Runs the printouts part
//       (it opens the print page in that person's browser). If the website
//       and printer sharing aren't running - the startup task is missing,
//       as on a computer updated from an older version until Setup adds it,
//       or it has failed - it runs those too, exactly as older versions did.
//   macOS, and anywhere else - everything together, as before (on a Mac,
//       launchd already starts it at boot, before anyone signs in).
//
// Only one copy of each group runs per computer: the running copy holds a
// small "lock" (a listening port on 127.0.0.1, unreachable from outside).
// A second copy notices and waits quietly, taking over if the first stops.
// The lock also answers one request - "restart-parts" - so "Restart
// PrintBridge" can restart parts running as Windows' own system account,
// which an ordinary person can't stop directly.

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { fork } = require("child_process");
const P = require("./paths");
const { logger } = require("./log");
const { VERSION } = require("./version");

const log = logger("office-printing");

// Takes the lock on `port`. Resolves { lock, code }: lock is the server
// holding it, or null with the error code if it couldn't be taken.
// Connections to the lock are handed to onRequest (set once the parts are
// running).
function takeLock(port, onRequest) {
  return new Promise((resolve) => {
    const lock = net.createServer((socket) => {
      socket.setTimeout(2000, () => socket.destroy());
      socket.on("error", () => {});
      let text = "";
      socket.on("data", (d) => {
        text += d.toString("utf8");
        if (text.length > 100) return socket.destroy();
        if (!text.includes("\n")) return;
        const request = text.trim();
        let answer = "?";
        try { answer = (lock.onRequest && lock.onRequest(request)) || "?"; } catch (err) { /* answered "?" */ }
        socket.end(answer + "\n");
      });
      // A plain knock (isRunning) sends nothing and just hangs up.
    });
    lock.onRequest = onRequest || null;
    lock.once("error", (err) => resolve({ lock: null, code: err.code }));
    lock.listen(port, "127.0.0.1", () => resolve({ lock, code: "" }));
  });
}

// Is that group running (for anyone signed in, or as the startup task)?
// Checked by knocking on the lock, never by taking it - taking it, even for
// a moment, could stop a copy that is starting at that very moment.
function isRunning(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: port || P.LOCK_PORT });
    const done = (answer) => { socket.destroy(); resolve(answer); };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// Sends a one-line request to whichever copy holds that lock. Resolves its
// one-line answer, or "" if nothing is running there.
function ask(port, request) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let text = "";
    const done = () => { socket.destroy(); resolve(text.trim()); };
    socket.setTimeout(3000, done);
    socket.once("connect", () => socket.write(request + "\n"));
    socket.on("data", (d) => { text += d.toString("utf8"); });
    socket.once("end", done);
    socket.once("error", () => resolve(""));
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits until this copy holds the lock on `port`, exactly as before: a copy
// that is closing gets a few seconds; another copy running (for someone else
// signed in, or as the startup task) is waited for, and taken over from if
// it stops.
async function holdLock(port, label) {
  let tries = 0;
  for (;;) {
    const { lock, code } = await takeLock(port);
    if (lock) return lock;
    if (code !== "EADDRINUSE") {
      // Not another copy holding the lock - something about this computer
      // won't let the lock be set up at all (its port can be inside a
      // range Hyper-V, WSL or Docker has reserved, or security software
      // can refuse it). Running anyway is still better than not running,
      // but "no lock" is not the same as "nobody else is running": with
      // two people signed in, both copies would arrive here and both would
      // start, fighting over the website's port and sharing this
      // computer's printers twice. So ask the other way first.
      // Bounded: whatever is answering on that port may not be this
      // program at all, and never starting would be worse than starting
      // twice. After about a minute, start regardless.
      if (tries < 12 && (await isRunning(port))) {
        tries++;
        if (tries === 6) log.line("Couldn't set up the one-copy lock for " + label + " (" + code + "), and something is already answering on it - waiting in case it stops.");
        await wait(tries <= 5 ? 1000 : 5000);
        continue;
      }
      log.line("Couldn't set up the one-copy lock for " + label + " (" + code + "); starting anyway.");
      return null;
    }
    // Another copy is running. Wait quietly, and take over if it stops
    // (for example when that person signs out).
    // (The first few seconds of retries cover a copy that is just closing.)
    tries++;
    if (tries === 6) log.line("The " + label + " already runs elsewhere on this computer - waiting in case it stops.");
    // Checked every five seconds rather than every minute: this is how
    // long printing is left unattended after the first person signs out.
    await wait(tries <= 5 ? 1000 : 5000);
  }
}

function kindsFor(role, group) {
  const core = role === "main" ? ["website", "printer"] : role === "client" ? [] : ["printer"];
  if (group === "core") return core;
  if (group === "signin") return ["outbox"];
  return core.concat(["outbox"]);
}

// Runs the given parts and keeps them running. Returns the request handler
// for the lock (restart-parts). onMessage(kind, message) hears what a part
// tells the background program (the website saying another main computer
// has taken over - see server.js).
function runParts(kinds, settings, statusFile, label, onMessage) {
  const children = {};
  let stopped = false; // set by stopChildren: nothing is started again after it
  const roleName = { main: "main computer", printer: "printer computer", client: "computer that only prints" }[settings.role];

  log.line("Starting " + label + " (" + roleName +
    ', named "' + settings.name + '"). Version ' + VERSION + '.' +
    (kinds.length ? " Parts: " + kinds.join(", ") + "." : " Nothing to run here."));

  function envFor(kind) {
    const env = Object.assign({}, process.env);
    if (kind === "website") {
      env.PRINT_DATA_DIR = P.WEBSITE_DIR;
      env.PRINT_UPLOAD_DIR = P.UPLOAD_DIR;
      env.PORT = String(P.PORT);
    } else if (kind === "printer") {
      env.OFFICE_PRINTING_MANAGED = "1";
      env.OP_OWN_PRINTER = require("./brand").NAME; // never shared on the website
      env.PRINT_AGENT_DIR = P.PRINTER_DIR;
      env.OP_ROLE = settings.role;
      env.OP_NAME = settings.name;
      env.OP_SERVER = settings.server;
    }
    return env;
  }

  function launch(kind) {
    if (stopped) return;
    const state = children[kind] || (children[kind] = { restarts: 0, delay: 5000 });
    const out = logger(kind);
    let child;
    try {
      child = fork(P.ENTRY, [kind], {
        env: envFor(kind),
        silent: true, // its output goes to the log file, not a window
        windowsHide: true,
      });
    } catch (err) {
      // Refused outright (rare: out of resources). Try again in a minute
      // rather than leaving this part stopped until the next sign-in.
      log.line(kind + " could not start: " + err.message + ". Trying again in 60 seconds.");
      setTimeout(() => launch(kind), 60000);
      return;
    }
    state.child = child;
    state.pid = child.pid;
    state.startedAt = Date.now();
    // Missing when Windows refused to start it (out of resources): the
    // "error" below then deals with it.
    if (child.stdout) child.stdout.on("data", (d) => out.chunk(d));
    if (child.stderr) child.stderr.on("data", (d) => out.chunk(d));
    let ended = false;
    const onEnd = (code, signal) => {
      if (ended) return;
      ended = true;
      state.child = null;
      state.pid = 0;
      state.lastExitAt = Date.now();
      state.lastExit = signal ? "signal " + signal : code == null ? "couldn't start" : "code " + code;
      state.restarts++;
      // Something that keeps stopping straight away is given longer and
      // longer (up to a minute) before the next try, so it can't spin.
      // A restart that was asked for is quick.
      const lived = state.lastExitAt - state.startedAt;
      if (lived > 5 * 60 * 1000) state.delay = 5000;
      const waitMs = state.restartAsked ? 1000 : state.delay;
      if (!state.restartAsked) state.delay = Math.min(state.delay * 2, 60000);
      state.restartAsked = false;
      log.line(kind + " stopped (" + state.lastExit + "). Starting it again in " +
        Math.round(waitMs / 1000) + " seconds.");
      writeStatus();
      setTimeout(() => launch(kind), waitMs);
    };
    child.on("exit", onEnd);
    child.on("message", (message) => {
      try { if (onMessage) onMessage(kind, message); } catch (err) { log.line("Problem handling a message from " + kind + ": " + err.message); }
    });
    // A part that couldn't be started at all (security software, or the
    // computer out of resources) reports only an error, never "exit" - it
    // is treated as stopped, so it is tried again rather than left dead
    // while the status file still calls it running.
    child.on("error", (err) => {
      log.line(kind + " could not start: " + err.message);
      if (!child.pid) onEnd(null, null);
    });
    log.line(kind + " started (process " + child.pid + ").");
    writeStatus();
  }

  const startedAt = Date.now();
  function writeStatus() {
    const status = {
      pid: process.pid,
      // Automatic updates wait for the new version to report in here (see
      // waitHealthy in updater.js).
      version: VERSION,
      role: settings.role,
      name: settings.name,
      startedAs: label,
      startedAt,
      updatedAt: Date.now(),
      parts: {},
    };
    for (const kind of kinds) {
      const s = children[kind] || {};
      status.parts[kind] = {
        running: !!s.child,
        pid: s.pid || 0,
        restarts: Math.max(0, (s.restarts || 0)),
        lastExit: s.lastExit || "",
        lastExitAt: s.lastExitAt || 0,
      };
    }
    try {
      fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
    } catch (err) {
      /* informational only */
    }
  }

  for (const kind of kinds) launch(kind);
  // Written at once even with nothing to run (a computer that only prints,
  // in the startup task): automatic updates look for it.
  writeStatus();
  const statusTimer = setInterval(writeStatus, 15000);

  const stopChildren = () => {
    stopped = true;
    clearInterval(statusTimer);
    for (const kind of kinds) {
      const s = children[kind];
      if (s && s.child) {
        s.child.removeAllListeners("exit");
        s.child.removeAllListeners("error");
        s.child.on("error", () => { /* stopping anyway */ });
        s.child.kill();
      }
    }
  };

  return {
    stopChildren,
    onRequest(request) {
      if (request === "restart-parts") {
        log.line("Restarting " + (kinds.join(", ") || "nothing") + " (asked for).");
        for (const kind of kinds) {
          const s = children[kind];
          if (s && s.child) {
            s.restartAsked = true;
            try { s.child.kill(); } catch (err) { /* already stopping */ }
          }
        }
        return "ok";
      }
      if (request === "who") return label;
      return "?";
    },
  };
}

// The website said another main computer has taken over ("make this the
// only main computer" in Setup - see server.js): from now on this computer
// shares its printers through that one, like any printer computer, and
// keeps its name. Nothing is deleted; running Setup again and choosing the
// main computer makes it one again.
function applyStepDown(message) {
  const settings = P.readSettings();
  if (settings.role !== "main") return false; // already done (or never was)
  let server = "";
  try { server = new URL(String(message.address || "")).host; } catch (err) { /* found by itself instead */ }
  P.writeSettings({ role: "printer", name: settings.name, server });
  P.updateRecord({
    steppedDown: { at: message.at || Date.now(), byId: message.byId || "", byName: message.byName || "", address: message.address || "" },
  });
  // The address the printouts part remembers was this computer's own.
  try { P.removeJson(path.join(P.OUTBOX_DIR, "server.json")); } catch (err) { /* only a shortcut */ }
  log.line("Another main computer took over (" + (message.byName || message.byId || "?") + " at " + (message.address || "?") +
    "). This computer no longer runs the printing page; it now shares its printers through that one.");
  return true;
}

// Runs one group of parts, and starts it again with the new settings if the
// website steps down. Returns an object whose .group is always the current one.
// updates (optional): answers "update-check" ("Update PrintBridge now").
function runGroup(group, statusFile, label, lock, groups, updates) {
  const holder = {};
  const start = () => {
    const settings = P.readSettings();
    const g = runParts(kindsFor(settings.role, group), settings, statusFile, label, (kind, message) => {
      if (kind !== "website" || !message || message.type !== "step-down") return;
      if (!applyStepDown(message)) return;
      g.stopChildren();
      const at = groups.indexOf(g);
      // Fresh settings, fresh parts: the printer part now finds the new main computer.
      start();
      if (at !== -1) groups.splice(at, 1);
    });
    holder.group = g;
    groups.push(g);
    if (lock) {
      lock.onRequest = (request) => (request === "update-check" && updates ? updates.checkNow() : holder.group.onRequest(request));
    }
  };
  start();
  return holder;
}

function stopOnSignals(groups) {
  const stopAll = () => {
    for (const g of groups) g.stopChildren();
    log.line("Stopped.");
    process.exit(0);
  };
  process.on("SIGTERM", stopAll);
  process.on("SIGINT", stopAll);
  process.on("uncaughtException", (err) => {
    log.line("Unexpected problem: " + (err && err.stack ? err.stack : err));
  });
}

// mode: "all" (default; macOS and older behaviour), "service" (Windows,
// started by the startup task) or "signin" (Windows, at sign-in).
async function start(mode) {
  P.ensureDirs();
  mode = mode || (P.IS_WINDOWS ? "signin" : "all");
  const groups = [];
  stopOnSignals(groups);

  if (mode === "all" || mode === "service") {
    const lock = await holdLock(P.LOCK_PORT, "background program");
    // Whatever the printer part said last time is out of date now.
    try { fs.rmSync(path.join(P.PRINTER_DIR, "status.json"), { force: true }); } catch (err) { /* fine */ }
    runGroup(mode === "all" ? "all" : "core", P.STATUS_FILE,
      mode === "all" ? "the background program" : "the background program (startup task)", lock, groups,
      startUpdates(mode));
    return;
  }

  // "signin": the printouts part at once, and the background parts only if
  // nothing else runs them.
  (async () => {
    const lock = await holdLock(P.OUTBOX_LOCK_PORT, "printouts part");
    const settings = P.readSettings();
    const g = runParts(kindsFor(settings.role, "signin"), settings, P.SIGNIN_STATUS_FILE, "the printouts part (signed in)");
    groups.push(g);
    if (lock) lock.onRequest = g.onRequest;
  })();

  // Just after Windows starts, the startup task may not have started yet;
  // give it a minute before running its parts here instead, so it - not
  // this sign-in - normally runs them.
  const record = P.readRecord();
  if (record.startupTask && os.uptime() < 5 * 60) {
    for (let i = 0; i < 12 && !(await isRunning(P.LOCK_PORT)); i++) await wait(5000);
  }
  const lock = await holdLock(P.LOCK_PORT, "background program");
  if (record.startupTask) log.line("The startup task isn't running the background parts, so this sign-in runs them.");
  try { fs.rmSync(path.join(P.PRINTER_DIR, "status.json"), { force: true }); } catch (err) { /* fine */ }
  // Automatic updates need administrator rights, which a sign-in doesn't
  // have; this copy only says so when asked (see updater.js).
  runGroup("core", P.STATUS_FILE, "the background program (signed in)", lock, groups, startUpdates("signin"));
}

// Automatic updates (see updater.js). A problem there must never stop printing.
function startUpdates(mode) {
  try {
    return require("./updater").start({ mode });
  } catch (err) {
    log.line("Automatic updates couldn't start: " + (err && err.message ? err.message : err));
    return { checkNow: () => "off:problem" };
  }
}

module.exports = { start, isRunning, ask };
