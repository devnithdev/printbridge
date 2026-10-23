// Remembering this computer's power settings before Setup changes them (so
// it never sleeps), applying the choices made at install time, and putting
// the originals back if PrintBridge is ever removed. Only on the main
// computer, and only the settings Setup actually changes.
//
// This file only picks between the two real implementations:
//   power.win.js   Windows - powercfg.exe (Setup itself applies the new
//                  settings directly; this only saves/restores)
//   power.mac.js   macOS   - pmset (also applies the new settings, since
//                  there's no installer script to do it inline)

const P = require("./paths");

function impl() {
  if (P.IS_WINDOWS) return require("./power.win");
  if (P.IS_MAC) return require("./power.mac");
  return null;
}

async function save() {
  const platform = impl();
  if (platform) await platform.save();
}

async function restore() {
  const platform = impl();
  if (platform) await platform.restore();
}

// Windows only: see power.win.js.
async function restoreSleep() {
  const platform = impl();
  if (platform && platform.restoreSleep) await platform.restoreSleep();
}

// Only meaningful on macOS - see power.mac.js. On Windows, Setup applies
// the choices itself right after save-power, so there's nothing to do here.
async function apply(choices) {
  const platform = impl();
  if (platform && platform.apply) return platform.apply(choices);
  return { ok: true, message: "" };
}

module.exports = { save, restore, restoreSleep, apply };
