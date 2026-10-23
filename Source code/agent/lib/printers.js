// Finding the printers attached to this computer, and asking each one
// what it can do (paper sizes, colour, double-sided).
//
// macOS and Linux use CUPS (`lpstat`, `lpoptions`).
// Windows uses PowerShell to read the printer list from the system.

const os = require("os");
const { execFile } = require("child_process");

const IS_WINDOWS = os.platform() === "win32";

function run(command, args, options) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      // windowsHide: the installed version has no window of its own, so
      // without this every PowerShell call would flash a black window.
      Object.assign({ timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, options || {}),
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      }
    );
  });
}

// --- macOS and Linux ----------------------------------------------------

async function listCupsPrinters() {
  const result = await run("lpstat", ["-e"]);
  if (!result.ok) return [];
  const names = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // The "PrintBridge" printer this program adds on a Mac (see
  // desktop/lib/vprinter.mac.js) is an ordinary CUPS queue too, so it shows
  // up in this list - and must not be offered on the website as a real
  // printer: printing to it would send the file straight back to the
  // website. Recognised by its name (OP_OWN_PRINTER, with spaces as CUPS
  // writes them) and by where it sends jobs: this computer's own
  // socket://127.0.0.1:<print port>.
  const own = OWN_PRINTER_NAME.replace(/[\s/#]+/g, "-");
  const printPort = String(parseInt(process.env.OP_PRINT_PORT, 10) || 39274);
  const hidden = new Set();
  const uris = await run("lpstat", ["-v"]);
  if (uris.ok) {
    for (const line of uris.stdout.split("\n")) {
      // "device for PrintBridge: socket://127.0.0.1:39274"
      const m = line.match(/^device for (.+?):\s*(\S+)\s*$/);
      if (m && m[2].toLowerCase().replace(/\/+$/, "") === "socket://127.0.0.1:" + printPort) hidden.add(m[1]);
    }
  }
  return names.filter((name) => !hidden.has(name) && !(own && name.toLowerCase() === own));
}

// `lpoptions -p NAME -l` prints lines like:
//   PageSize/Media Size: *Letter A4 Legal
//   ColorModel/Output Mode: *RGB Gray
//   Duplex/2-Sided Printing: *None DuplexNoTumble DuplexTumble
function parseLpOptions(text) {
  const table = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([^/:]+)(?:\/[^:]*)?:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const values = match[2]
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => ({
        value: value.replace(/^\*/, ""),
        isDefault: value.startsWith("*"),
      }));
    table[key] = values;
  }
  return table;
}

async function cupsCapabilities(printerName) {
  const result = await run("lpoptions", ["-p", printerName, "-l"]);
  if (!result.ok) {
    return { paperSizes: [], color: null, duplex: null, maxCopies: 99, pageRanges: true };
  }

  const table = parseLpOptions(result.stdout);

  const pageSizes = table.PageSize || table.media || [];
  const paperSizes = pageSizes.map((entry) => entry.value);
  const defaultPaper = (pageSizes.find((entry) => entry.isDefault) || {}).value || null;

  let color = null;
  const colorKey = table.ColorModel || table["print-color-mode"] || table.OutputMode;
  if (colorKey) {
    color = colorKey.some((entry) =>
      /rgb|cmyk|color|colour/i.test(entry.value)
    );
  }

  let duplex = null;
  const duplexKey = table.Duplex || table.sides;
  if (duplexKey) {
    duplex = duplexKey.some((entry) => /duplex|two-sided|tumble/i.test(entry.value));
  } else {
    duplex = false;
  }

  return {
    paperSizes,
    defaultPaper,
    color,
    duplex,
    maxCopies: 99,
    pageRanges: true,
  };
}

// --- Windows ------------------------------------------------------------

const POWERSHELLS = ["powershell.exe", "pwsh.exe", "powershell", "pwsh"];

async function runPowerShell(script) {
  // Without this, PowerShell answers in an older text encoding and printer
  // names with accents or other alphabets ("Bürodrucker") come back garbled,
  // so jobs sent to them would fail.
  script = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; " + script;
  for (const shell of POWERSHELLS) {
    const result = await run(shell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ]);
    if (result.ok || (result.error && result.error.code !== "ENOENT")) return result;
  }
  return { ok: false, stdout: "", stderr: "PowerShell was not found." };
}

// Windows comes with several "printers" that aren't printers: they save a
// file or open an app instead, which would pop up a dialog on this computer
// that nobody is there to answer - so the job would just hang. Leave them out.
const PRETEND_PRINTER_NAMES = /^(microsoft print to pdf|microsoft xps document writer|fax|onenote\b.*|send to onenote\b.*)$/i;
const PRETEND_PRINTER_PORTS = /^(portprompt:|shrfax:|nul:?)$/i;

// The "PrintBridge" printer this program adds (for Excel, Word and
// other programs) sends printouts TO the website, so it must never be
// offered on the website as a printer itself. Recognised by its name and
// by its port, a file in this program's outbox folder.
const OWN_PRINTER_NAME = String(process.env.OP_OWN_PRINTER || "").trim().toLowerCase();
const OWN_PRINTER_PORT = /[\\/]outbox[\\/]printout\.pdf$/i;

function isPretendPrinter(item) {
  const name = String(item.Name || "").trim();
  const port = String(item.PortName || "").trim();
  return (
    PRETEND_PRINTER_NAMES.test(name) ||
    PRETEND_PRINTER_PORTS.test(port) ||
    OWN_PRINTER_PORT.test(port) ||
    (!!OWN_PRINTER_NAME && name.toLowerCase() === OWN_PRINTER_NAME)
  );
}

// Win32_Printer.Capabilities uses numbers: 2 = colour, 3 = duplex, 4 = copies.
// Answers null (not an empty list) when Windows couldn't be asked at all -
// "no printers" and "couldn't tell" must not look the same, or one slow
// moment of the print spooler takes every printer off the website.
async function listWindowsPrinters() {
  const script =
    "Get-CimInstance Win32_Printer | " +
    "Select-Object Name,PortName,Default,PrinterPaperNames,Capabilities | " +
    "ConvertTo-Json -Depth 4 -Compress";

  const result = await runPowerShell(script);
  if (!result.ok) return null;
  if (!result.stdout.trim()) return [];

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return null;
  }
  if (!Array.isArray(parsed)) parsed = [parsed];

  return parsed
    .filter((item) => item && item.Name && !isPretendPrinter(item))
    .map((item) => {
      const capabilityNumbers = Array.isArray(item.Capabilities) ? item.Capabilities : [];
      const papers = Array.isArray(item.PrinterPaperNames)
        ? item.PrinterPaperNames.filter(Boolean)
        : [];
      return {
        name: String(item.Name),
        capabilities: {
          paperSizes: papers,
          defaultPaper: papers.includes("A4") ? "A4" : papers[0] || null,
          color: capabilityNumbers.includes(2), // Win32_Printer: 2 = colour, 3 = duplex, 4 = copies
          duplex: capabilityNumbers.includes(3),
          maxCopies: 99,
          pageRanges: true,
        },
      };
    });
}

// --- the one function the agent calls -----------------------------------

// For testing without a real printer: set AGENT_FAKE_PRINTERS="Name A,Name B"
function fakePrinters() {
  const raw = String(process.env.AGENT_FAKE_PRINTERS || "").trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      capabilities: {
        paperSizes: ["A4", "Letter", "Legal"],
        defaultPaper: "A4",
        color: !/mono|bw|black/i.test(name),
        duplex: !/simplex|single/i.test(name),
        maxCopies: 99,
        pageRanges: true,
      },
    }));
}

async function listPrintersWithCapabilities() {
  const fake = fakePrinters();
  if (fake) return fake;

  if (IS_WINDOWS) return listWindowsPrinters();

  const names = await listCupsPrinters();
  const out = [];
  for (const name of names) {
    out.push({ name, capabilities: await cupsCapabilities(name) });
  }
  return out;
}

module.exports = { listPrintersWithCapabilities, isPretendPrinter, IS_WINDOWS, run };
