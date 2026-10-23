// The one file every printout passes through, and the tidying of the name
// that came with it.
//
// Kept here, on its own, because three files need exactly the same answer:
// vprinter.js (which sets the printer up), vprinter.win.js / vprinter.mac.js
// (which point the printer at it) and outbox.js (which watches for it). When
// this lived in two places, kept in step only by a comment, changing one
// would have left the printer writing somewhere nothing was watching.

const path = require("path");
const P = require("./paths");

const PORT_FILE_NAME = "printout.pdf";
// Written beside it, a moment earlier, with the name the program gave the
// printout ("Budget.xlsx"). Only used on macOS - Windows asks the printer
// itself; see currentJobName() in each half.
const TITLE_FILE_NAME = "printout.title";

function portPath() {
  return path.join(P.OUTBOX_DIR, PORT_FILE_NAME);
}

function titlePath() {
  return path.join(P.OUTBOX_DIR, TITLE_FILE_NAME);
}

// "Microsoft Excel - Budget.xlsx" becomes "Budget.xlsx"; anything a file
// name can't contain is taken out, since this becomes one.
function cleanJobName(raw) {
  let name = String(raw || "").trim();
  name = name.replace(/^Microsoft (Word|Excel|PowerPoint|Office \w+) - /i, "");
  name = name.replace(/ - (Microsoft Edge|Google Chrome|Mozilla Firefox|Safari|Preview|Notepad|TextEdit|Adobe Acrobat Reader.*)$/i, "");
  return name.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 150);
}

module.exports = { PORT_FILE_NAME, TITLE_FILE_NAME, portPath, titlePath, cleanJobName };
