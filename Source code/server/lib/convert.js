// Turn Word documents and images into PDF, so users can print more than
// just PDFs. The conversion happens here on the server using LibreOffice,
// which is free and open source. If LibreOffice is not installed we simply
// tell the user, instead of failing in a confusing way.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONVERTIBLE = new Set([
  ".doc", ".docx", ".odt", ".rtf", ".txt",
  ".xls", ".xlsx", ".ods",
  ".ppt", ".pptx", ".odp",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp",
]);

// Where LibreOffice might be, depending on the computer.
const CANDIDATES = [
  process.env.SOFFICE_PATH,
  "soffice",
  "libreoffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
].filter(Boolean);

function needsConversion(fileName) {
  return CONVERTIBLE.has(path.extname(fileName).toLowerCase());
}

function isPdf(fileName) {
  return path.extname(fileName).toLowerCase() === ".pdf";
}

function tryRun(command, args) {
  return new Promise((resolve) => {
    // windowsHide: no black window flashes up while a file is converted.
    execFile(command, args, { timeout: 120000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// LibreOffice's own settings folder for these conversions, separate from
// anyone's everyday LibreOffice. Sharing the everyday one meant that with
// LibreOffice open on this computer (or two files converting at once), the
// conversion was handed to the copy already running and came back with
// "ran but produced no PDF". A conversion that hangs can leave its copy
// holding the folder, so after a timeout the next one uses a fresh folder.
let profileNumber = 0;
function profileUrl() {
  const dir = path.join(os.tmpdir(), "office-printing-libreoffice-" + profileNumber);
  return "-env:UserInstallation=" + require("url").pathToFileURL(dir).href;
}

// One conversion at a time: LibreOffice can't run two on one settings folder.
let queue = Promise.resolve();
function convertToPdf(inputPath) {
  const run = queue.then(() => convertNow(inputPath));
  queue = run.catch(() => { /* the next one runs regardless */ });
  return run;
}

// Converts `inputPath` to a PDF next to it and returns the new path.
async function convertNow(inputPath) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "print-convert-"));
  try {
    let lastError = "LibreOffice was not found.";

    for (const command of CANDIDATES) {
      const result = await tryRun(command, [
        profileUrl(),
        "--headless",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        inputPath,
      ]);

      if (!result.error) {
        const produced = fs
          .readdirSync(outDir)
          .filter((f) => f.toLowerCase().endsWith(".pdf"));
        if (produced.length > 0) {
          const from = path.join(outDir, produced[0]);
          const to = inputPath.replace(/\.[^.]+$/, "") + ".pdf";
          fs.copyFileSync(from, to);
          return to;
        }
        lastError = "LibreOffice ran but produced no PDF.";
      } else if (result.error.code !== "ENOENT") {
        if (result.error.killed) {
          profileNumber++;
          lastError = "LibreOffice took too long (over 2 minutes).";
          break; // another copy of LibreOffice would only take as long again
        } else {
          lastError = result.stderr || result.error.message;
        }
      }
    }

    throw new Error(
      "Could not convert this file to PDF. " +
        lastError +
        " Install LibreOffice on the main computer, or print a PDF instead."
    );
  } finally {
    // Removed whatever happened - a failed copy used to leave it behind.
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (err) { /* temp folder */ }
  }
}

module.exports = { needsConversion, isPdf, convertToPdf, CONVERTIBLE };
