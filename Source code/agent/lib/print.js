// Sending a PDF to a real printer.
//
// macOS and Linux : the `lp` command, which is part of the system.
// Windows         : SumatraPDF (free, open source) if it is installed,
//                   otherwise Ghostscript. Both are given the PDF and the
//                   printer name on the command line.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, IS_WINDOWS } = require("./printers");

// --- macOS and Linux ----------------------------------------------------

function lpArguments(printerName, filePath, options) {
  const args = ["-d", printerName];

  if (options.copies && options.copies > 1) args.push("-n", String(options.copies));
  if (options.paper) args.push("-o", "media=" + options.paper);

  args.push(
    "-o",
    "print-color-mode=" + (options.color === "color" ? "color" : "monochrome")
  );
  args.push("-o", "sides=" + (options.sides || "one-sided"));

  if (options.pageRanges) args.push("-o", "page-ranges=" + options.pageRanges);

  // 3 = portrait, 4 = landscape; left out, CUPS turns each page to fit.
  if (options.orientation === "portrait") args.push("-o", "orientation-requested=3");
  if (options.orientation === "landscape") args.push("-o", "orientation-requested=4");
  args.push("-o", "print-scaling=" + (options.scaling === "actual" ? "none" : "fit"));

  args.push(filePath);
  return args;
}

async function printWithLp(printerName, filePath, options) {
  const result = await run("lp", lpArguments(printerName, filePath, options), {
    timeout: 120000,
  });

  if (!result.ok) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail || "The lp command failed.");
  }

  // lp answers with: request id is TestPrinter-7 (1 file(s))
  const match = result.stdout.match(/request id is (\S+)/);
  return { nativeJobId: match ? match[1] : "", detail: result.stdout.trim() };
}

// --- Windows: SumatraPDF ------------------------------------------------

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) {
      /* ignore */
    }
  }
  return null;
}

function findSumatra(config) {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  // config.baseDir is the real folder this program runs from - the exe's
  // own folder when packaged, or the agent folder when run with `node`.
  // __dirname is NOT used here because inside a packaged .exe it points
  // into the read-only bundle, not next to the real file on disk.
  const baseDir = config.baseDir || path.join(__dirname, "..");

  return firstExisting([
    config.sumatraPath,
    // Right next to PrintAgent.exe itself - the simplest, most obvious
    // place to drop it, so this is checked first.
    path.join(baseDir, "SumatraPDF.exe"),
    path.join(baseDir, "tools", "SumatraPDF.exe"),
    path.join(programFiles, "SumatraPDF", "SumatraPDF.exe"),
    path.join(programFilesX86, "SumatraPDF", "SumatraPDF.exe"),
    localAppData && path.join(localAppData, "SumatraPDF", "SumatraPDF.exe"),
  ]);
}

function findGhostscript(config) {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidates = [config.ghostscriptPath];

  // Ghostscript installs into a version-numbered folder, so look inside.
  try {
    const base = path.join(programFiles, "gs");
    for (const version of fs.readdirSync(base)) {
      candidates.push(path.join(base, version, "bin", "gswin64c.exe"));
      candidates.push(path.join(base, version, "bin", "gswin32c.exe"));
    }
  } catch (err) {
    /* Ghostscript is not installed there */
  }

  return firstExisting(candidates);
}

// SumatraPDF takes one comma-separated settings string.
function sumatraSettings(options) {
  const parts = [];

  if (options.pageRanges) parts.push(options.pageRanges);
  if (options.copies && options.copies > 1) parts.push(options.copies + "x");

  if (options.sides === "two-sided-long-edge") parts.push("duplexlong");
  else if (options.sides === "two-sided-short-edge") parts.push("duplexshort");
  else parts.push("simplex");

  parts.push(options.color === "color" ? "color" : "monochrome");

  // A comma would split the paper name into two settings.
  if (options.paper) parts.push("paper=" + String(options.paper).replace(/,/g, " ").trim());
  // Without portrait/landscape, SumatraPDF turns each page to suit the paper.
  if (options.orientation === "portrait") parts.push("portrait");
  if (options.orientation === "landscape") parts.push("landscape");
  parts.push(options.scaling === "actual" ? "noscale" : "fit");

  return parts.join(",");
}

async function printWithSumatra(exe, printerName, filePath, options) {
  const result = await run(
    exe,
    [
      "-print-to",
      printerName,
      "-print-settings",
      sumatraSettings(options),
      "-silent",
      "-exit-when-done",
      filePath,
    ],
    // Long enough for a big job (many pages or copies) to finish handing
    // itself to Windows. At 3 minutes such a job was stopped part-way,
    // reported as failed, and - with "try another printer" ticked - then
    // printed again in full on a second printer.
    { timeout: 15 * 60 * 1000 }
  );

  if (!result.ok) {
    if (result.error && result.error.killed) {
      throw new Error("SumatraPDF took more than 15 minutes, so it was stopped. Part of it may have printed - check the printer before printing it again.");
    }
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail || "SumatraPDF could not print the file.");
  }
  return { nativeJobId: "", detail: "Printed with SumatraPDF." };
}

async function printWithGhostscript(exe, printerName, filePath, options) {
  const args = [
    "-dPrinted",
    "-dBATCH",
    "-dNOPAUSE",
    "-dNOSAFER",
    "-q",
    "-dNumCopies=" + (options.copies || 1),
    "-sDEVICE=mswinpr2",
    '-sOutputFile=%printer%' + printerName,
  ];

  // Ghostscript only understands a single first/last page range.
  const simpleRange = /^(\d+)(?:-(\d+))?$/.exec(options.pageRanges || "");
  if (simpleRange) {
    args.push("-dFirstPage=" + simpleRange[1]);
    args.push("-dLastPage=" + (simpleRange[2] || simpleRange[1]));
  }

  args.push(filePath);

  const result = await run(exe, args, { timeout: 180000 });
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail || "Ghostscript could not print the file.");
  }
  return { nativeJobId: "", detail: "Printed with Ghostscript." };
}

async function printOnWindows(printerName, filePath, options, config) {
  const sumatra = findSumatra(config);
  if (sumatra) return printWithSumatra(sumatra, printerName, filePath, options);

  const ghostscript = findGhostscript(config);
  if (ghostscript) return printWithGhostscript(ghostscript, printerName, filePath, options);

  throw new Error(
    "No PDF printing program found. Install SumatraPDF (recommended) or " +
      "Ghostscript on this computer, or set sumatraPath in config.json."
  );
}

// --- the one function the agent calls -----------------------------------

async function printFile(printerName, filePath, options, config) {
  if (config.dryRun) {
    const preview = IS_WINDOWS
      ? "SumatraPDF -print-to " + printerName + " -print-settings " + sumatraSettings(options)
      : "lp " + lpArguments(printerName, filePath, options).join(" ");
    return { nativeJobId: "dry-run", detail: "Dry run, nothing printed: " + preview };
  }

  if (IS_WINDOWS) return printOnWindows(printerName, filePath, options, config);
  return printWithLp(printerName, filePath, options);
}

module.exports = { printFile, sumatraSettings, lpArguments };
