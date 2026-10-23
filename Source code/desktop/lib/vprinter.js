// The "PrintBridge" printer that appears in every program's Print
// window (Excel, Word, PDF readers, browsers...).
//
// This file only picks between the two real implementations:
//   vprinter.win.js   Windows - a printer using the "Microsoft Print to
//                     PDF" driver Windows already has, writing to one file
//   vprinter.mac.js   macOS   - a CUPS printer whose "address" is this
//                     computer, which listens for each printout
// Both end up putting each printout in the same place (printout.js's
// portPath()), which the background program picks up straight away (see
// outbox.js) and opens the print page with, where the person checks the
// preview, picks a real printer and presses Print.

const P = require("./paths");
const { PORT_FILE_NAME, portPath, cleanJobName } = require("./printout");

// Loaded only when needed (not at the top of the file) so this can still
// be required on any other platform - for tooling, or for code that only
// wants portPath() - without pulling in a half that assumes the OS it is on.
function impl() {
  if (P.IS_WINDOWS) return require("./vprinter.win");
  if (P.IS_MAC) return require("./vprinter.mac");
  return null;
}

const UNSUPPORTED = { ok: false, message: "Not supported on this computer." };

async function add() {
  const platform = impl();
  return platform ? platform.add() : UNSUPPORTED;
}

async function remove() {
  const platform = impl();
  return platform ? platform.remove() : { ok: true, message: "" }; // nothing was ever added here
}

async function exists() {
  const platform = impl();
  return platform ? platform.exists() : false;
}

async function currentJobName() {
  const platform = impl();
  return platform ? platform.currentJobName() : "";
}

// Only macOS listens for printouts (Windows' printer writes the file
// itself); on Windows this does nothing and hands back the same
// "stop" function, so outbox.js needs no platform test of its own.
function startCapture(log) {
  const platform = impl();
  return platform && platform.startCapture ? platform.startCapture(log) : () => {};
}

module.exports = { add, remove, exists, currentJobName, startCapture, portPath, cleanJobName, PORT_FILE_NAME };
