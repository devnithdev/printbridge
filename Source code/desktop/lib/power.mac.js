// macOS half of remembering, applying and restoring this computer's power
// settings - see power.js. Uses pmset, the command-line tool behind the
// "Battery" pane in System Settings (Apple's own, not a third-party add-on).
//
// Only offered on the main computer, same as Windows, and only for the
// settings a Mac can actually promise:
//   - keep awake: turn off macOS's own idle-sleep timers, so this computer
//     stays reachable on the network instead of going to sleep by itself.
//   - the lid: either "keep working" (ignore lid-close sleep too) or leave
//     macOS's own sleep-on-lid-close behaviour alone. Unlike Windows, macOS
//     has no scriptable "shut down when the lid closes" - that choice is
//     genuinely not offered here, rather than faked.
//   - Low Power Mode on battery: turned on automatically whenever this
//     computer is running on battery, to stretch the time it stays
//     reachable (macOS 12 Monterey or later; on an older macOS this is
//     skipped quietly, since the setting doesn't exist to turn on).
// There is no macOS equivalent of Windows' "critical battery action" choice
// - low, critical-battery handling is built into macOS itself and isn't
// something a program can redirect.

const fs = require("fs");
const path = require("path");
const P = require("./paths");
const { run } = require("./win"); // a plain command runner, despite the file's name - see win.js
const B = require("./brand");

const FILE = path.join(P.DATA_DIR, "power-before.json");
// The handful of pmset settings this program ever changes - everything
// else on the computer's power source is left exactly as found.
const TRACKED = ["sleep", "disksleep", "displaysleep", "disablesleep", "lowpowermode"];

// `pmset -g custom` prints one block per power source, each a list of
// indented "key value" lines, e.g.:
//   AC Power:
//    sleep 10
//    disksleep 10
//   Battery Power:
//    sleep 5
function parseCustom(text) {
  const blocks = { c: {}, b: {} };
  let current = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const header = line.match(/^(AC Power|Battery Power):/);
    if (header) {
      current = header[1] === "AC Power" ? "c" : "b";
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^\s+(\S+)\s+(\S+)\s*$/);
    if (kv && TRACKED.includes(kv[1])) blocks[current][kv[1]] = kv[2];
  }
  return blocks;
}

// disablesleep applies to the whole computer, not one power source, so
// `pmset -g custom` (parsed above) never lists it - only a plain `pmset -g`
// does, mixed in with settings this program doesn't touch. Fetched on its
// own here so restore() below has something to put back; a stock Mac that
// nothing has ever run `pmset ... disablesleep` on has no line for it at
// all, and its real default is 0 (not disabled).
async function currentDisablesleep() {
  const r = await run("pmset", ["-g"]);
  const m = String(r.stdout || "").match(/^\s*disablesleep\s+(\d+)/m);
  return m ? m[1] : "0";
}

async function save() {
  if (fs.existsSync(FILE)) {
    console.log("Power settings from before " + B.NAME + " were already noted.");
    return;
  }
  const r = await run("pmset", ["-g", "custom"]);
  const before = parseCustom(r.stdout);
  before.disablesleep = await currentDisablesleep();
  P.ensureDirs();
  fs.writeFileSync(FILE, JSON.stringify(before, null, 2));
  console.log("Noted this computer's power settings, to put back if " + B.NAME + " is ever removed.");
}

// choices: { keepAwake: boolean, lidAction: "stay-awake" | "sleep" }
// (the recommended defaults, matching the Windows installer's: keepAwake
// on, lidAction "stay-awake".)
async function apply(choices) {
  const keepAwake = !!(choices && choices.keepAwake);
  const stayAwakeAtLid = !choices || choices.lidAction !== "sleep";
  const messages = [];

  // The display can always be left to sleep on its own - nothing this
  // program does needs the screen to stay lit, and a LaunchDaemon keeps
  // running whether or not anyone is signed in to see a screen at all.
  await run("pmset", ["-a", "displaysleep", "10"]);

  if (keepAwake) {
    const r = await run("pmset", ["-a", "sleep", "0", "disksleep", "0"]);
    if (!r.ok) messages.push("Couldn't turn off this computer's own sleep timer (" + (r.stderr || r.stdout || "pmset didn't run").trim().slice(0, 200) + ").");
  }

  // disablesleep is the one pmset setting that also blocks sleep-on-lid-
  // close - there's no separate "ignore the lid" switch.
  const r2 = await run("pmset", ["-a", "disablesleep", stayAwakeAtLid ? "1" : "0"]);
  if (!r2.ok) messages.push("Couldn't set what happens when the lid closes (" + (r2.stderr || r2.stdout || "pmset didn't run").trim().slice(0, 200) + ").");

  // Best effort, and only where macOS offers it (Monterey or later) - an
  // older macOS simply rejects the setting, which is fine to ignore.
  await run("pmset", ["-b", "lowpowermode", "1"]);

  return messages.length
    ? { ok: false, message: messages.join(" ") }
    : { ok: true, message: "Applied this computer's power settings." };
}

async function restore() {
  const before = P.readJson(FILE);
  if (!before) return; // Setup never changed them on this computer
  for (const [flag, block] of [["-c", before.c], ["-b", before.b]]) {
    if (!block) continue;
    for (const key of TRACKED) {
      if (key === "disablesleep") continue; // not per-source - see below
      if (Object.prototype.hasOwnProperty.call(block, key)) await run("pmset", [flag, key, String(block[key])]);
    }
  }
  // disablesleep applies to the whole computer, not one power source, and
  // is saved on its own (see currentDisablesleep() above) rather than
  // inside before.c/before.b, which `pmset -g custom` never lists it
  // under. before.c/before.b are kept as a fallback only for a
  // power-before.json written by an older version of this file.
  const disablesleep = before.disablesleep != null ? before.disablesleep : (before.c && before.c.disablesleep) || (before.b && before.b.disablesleep);
  if (disablesleep != null) await run("pmset", ["-a", "disablesleep", String(disablesleep)]);
  try { fs.rmSync(FILE, { force: true }); } catch (err) { /* harmless */ }
  console.log("Put this computer's power settings back the way they were.");
}

module.exports = { save, restore, apply };
