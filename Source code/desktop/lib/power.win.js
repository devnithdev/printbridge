// Windows half of remembering and restoring this computer's power settings
// - see power.js. Only the settings Setup changes are recorded, and only
// on the first install - a later Setup run must not record its own changes
// as "before". Setup itself (OfficePrinting.nsi) applies the new settings
// directly with powercfg.exe; this file only saves what came before and
// puts it back if PrintBridge is ever removed.

const fs = require("fs");
const path = require("path");
const P = require("./paths");
const { run } = require("./win");
const B = require("./brand");

const FILE = path.join(P.DATA_DIR, "power-before.json");
const SETTINGS = [
  ["SUB_SLEEP", "STANDBYIDLE"],
  ["SUB_SLEEP", "HIBERNATEIDLE"],
  ["SUB_VIDEO", "VIDEOIDLE"],
  ["SUB_BUTTONS", "LIDACTION"],
  ["SUB_BUTTONS", "PBUTTONACTION"],
  ["SUB_BATTERY", "BATACTIONCRIT"],
];
const POLICY_KEY = "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU";

async function save() {
  if (fs.existsSync(FILE)) {
    console.log("Power settings from before " + B.NAME + " were already noted.");
    return;
  }
  const scheme = (await run("powercfg.exe", ["/getactivescheme"])).stdout.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
  const before = { scheme: scheme ? scheme[0] : "SCHEME_CURRENT", values: [], hibernate: null, policy: false };
  for (const [group, setting] of SETTINGS) {
    const r = await run("powercfg.exe", ["/query", before.scheme, group, setting]);
    const hex = (r.stdout.match(/0x[0-9a-f]{8}/gi) || []).slice(-2);
    if (r.ok && hex.length === 2) before.values.push({ group, setting, ac: parseInt(hex[0], 16), dc: parseInt(hex[1], 16) });
  }
  const h = await run("reg.exe", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power", "/v", "HibernateEnabled"]);
  const hm = h.stdout.match(/HibernateEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  if (hm) before.hibernate = parseInt(hm[1], 16) !== 0;
  before.policy = (await run("reg.exe", ["query", POLICY_KEY, "/v", "NoAutoRebootWithLoggedOnUsers"])).ok;
  P.ensureDirs();
  fs.writeFileSync(FILE, JSON.stringify(before, null, 2));
  console.log("Noted this computer's power settings, to put back if " + B.NAME + " is ever removed.");
}

async function restore() {
  const before = P.readJson(FILE);
  if (!before) return; // Setup never changed them on this computer
  for (const v of before.values || []) {
    await run("powercfg.exe", ["/setacvalueindex", before.scheme, v.group, v.setting, String(v.ac)]);
    await run("powercfg.exe", ["/setdcvalueindex", before.scheme, v.group, v.setting, String(v.dc)]);
  }
  await run("powercfg.exe", ["/setactive", before.scheme]);
  if (before.hibernate === true) await run("powercfg.exe", ["/hibernate", "on"]);
  if (!before.policy) await run("reg.exe", ["delete", POLICY_KEY, "/v", "NoAutoRebootWithLoggedOnUsers", "/f"]);
  try { fs.rmSync(FILE, { force: true }); } catch (err) { /* harmless */ }
  console.log("Put this computer's power settings back the way they were.");
}

// Only the "never sleep" part put back, for a Setup run where "keep this
// computer awake" has been unticked after an earlier install ticked it.
// Without this, unticking it changed nothing: the computer went on never
// sleeping. The record is kept, so removing PrintBridge still puts back
// everything else.
async function restoreSleep() {
  const before = P.readJson(FILE);
  if (!before) return; // nothing was ever changed here
  for (const v of before.values || []) {
    if (v.group !== "SUB_SLEEP") continue;
    // On the power plan in use now (which Setup's other settings go to),
    // without switching plans - someone may have chosen another since.
    await run("powercfg.exe", ["/setacvalueindex", "SCHEME_CURRENT", v.group, v.setting, String(v.ac)]);
    await run("powercfg.exe", ["/setdcvalueindex", "SCHEME_CURRENT", v.group, v.setting, String(v.dc)]);
  }
  await run("powercfg.exe", ["/setactive", "SCHEME_CURRENT"]);
  if (before.hibernate === true) await run("powercfg.exe", ["/hibernate", "on"]);
  if (!before.policy) await run("reg.exe", ["delete", POLICY_KEY, "/v", "NoAutoRebootWithLoggedOnUsers", "/f"]);
  console.log("Put this computer's sleep timing back the way Windows had it.");
}

// Windows' choices are applied by Setup itself (OfficePrinting.nsi runs
// powercfg.exe directly, right after calling save-power) - there is no
// separate apply step to run from here.
module.exports = { save, restore, restoreSleep };
