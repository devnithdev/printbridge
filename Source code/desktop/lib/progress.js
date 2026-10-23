// What the setup wizard is doing right now, so its "Setting up" page can show
// a real progress bar instead of a browser tab that just keeps loading.
// setup-web.js starts a run with begin(); the steps that do the work (this
// file's callers, and libreoffice.js while it downloads) report into it; the
// page asks for snapshot() a few times a second.
//
// Also written to logs/setup.log, so if something goes wrong there is a plain
// record of how far it got.

let run = null;

function say(text) {
  try { require("./log").logger("setup").line(text); } catch (err) { /* logging only */ }
}

// steps: [{ id, label, weight }] - weight is how much of the bar the step is
// worth (a 300 MB download is worth far more than saving a settings file).
function begin(steps) {
  run = {
    steps: steps.map((s) => ({ id: s.id, label: s.label, weight: s.weight || 1, status: "waiting", sub: 0 })),
    message: "Starting...",
    done: false,
    error: null,
    lines: [],
  };
  say("Setup started: " + steps.map((s) => s.label).join(" > "));
}

function find(id) {
  return run && run.steps.find((s) => s.id === id);
}

function start(id) {
  const s = find(id);
  if (!s) return;
  s.status = "running";
  s.sub = 0;
  run.message = s.label + "...";
  say(s.label + "...");
}

// How far through the running step (0 to 1), and what to say about it.
function sub(id, fraction, message) {
  const s = find(id);
  if (!s) return;
  s.sub = Math.max(0, Math.min(1, fraction));
  if (message) run.message = message;
}

function finish(id, note) {
  const s = find(id);
  if (!s) return;
  s.status = "done";
  s.sub = 1;
  if (note) { run.lines.push(note); say(note); }
}

function skip(id, note) {
  const s = find(id);
  if (!s) return;
  s.status = "problem";
  s.sub = 1;
  if (note) { run.lines.push(note); say("PROBLEM: " + note); }
}

function log(text) { say(text); }

function complete() {
  if (!run) return;
  run.done = true;
  run.message = "All set.";
  say("Setup finished.");
}

function fail(message) {
  if (!run) return;
  run.error = message;
  run.done = true;
  say("Setup FAILED: " + message);
}

function snapshot() {
  if (!run) return { started: false };
  const total = run.steps.reduce((n, s) => n + s.weight, 0) || 1;
  const got = run.steps.reduce((n, s) => n + s.weight * (s.status === "done" || s.status === "problem" ? 1 : s.status === "running" ? s.sub : 0), 0);
  return {
    started: true,
    percent: run.done && !run.error ? 100 : Math.min(99, Math.round((got / total) * 100)),
    message: run.message,
    done: run.done,
    error: run.error,
    lines: run.lines,
    steps: run.steps.map((s) => ({ label: s.label, status: s.status })),
  };
}

module.exports = { begin, start, sub, finish, skip, log, complete, fail, snapshot };
