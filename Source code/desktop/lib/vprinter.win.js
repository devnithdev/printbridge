// Windows half of the "PrintBridge" printer - see vprinter.js.
//
// It is an ordinary Windows printer that uses the driver built into
// Windows 10 and 11 for "Microsoft Print to PDF", so nothing extra is
// installed. Instead of asking where to save, it always writes the PDF to
// one file in the outbox folder (vprinter.portPath()). The background
// program picks that file up straight away (see outbox.js) and opens the
// print page with it, where the person checks the preview, picks a real
// printer and presses Print.
//
// Everything a program's own Print window offers works as usual: printing
// a selection, orientation, fit to one page, margins, the program's preview.

const P = require("./paths");
const B = require("./brand");
const { portPath, cleanJobName } = require("./printout");
const { powershell } = require("./win");

const DRIVER = "Microsoft Print To PDF";

// PowerShell single-quoted text: a quote is written twice.
const q = (text) => "'" + String(text).replace(/'/g, "''") + "'";

// If an earlier install here (an earlier brand name, or an update from an
// older version) added this printer under a different name, that copy is
// removed first - otherwise it would be left behind as a stale duplicate
// once the new name is added, since Windows tells printers apart by name.
async function removePreviouslyNamed(currentName) {
  const record = P.readRecord();
  const prevName = record.printer && record.printer.name;
  // Windows treats printer names as case-insensitive, so compare the same
  // way - otherwise a name that only differs in case would look like a
  // different printer and get removed right after Set-Printer reuses it.
  if (!prevName || prevName.toLowerCase() === String(currentName).toLowerCase()) return;
  const script = [
    "$name = " + q(prevName),
    "if (Get-Printer -Name $name -ErrorAction SilentlyContinue) {",
    "  Get-PrintJob -PrinterName $name -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue",
    "  Remove-Printer -Name $name -ErrorAction SilentlyContinue",
    "}",
  ].join("\n");
  try {
    await powershell(script, { timeout: 60000 });
  } catch (err) {
    /* best effort - add() below still gives this computer a working printer */
  }
}

async function add() {
  P.ensureDirs();
  const name = B.NAME;
  const port = portPath();
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$name = " + q(name) + "; $port = " + q(port) + "; $driver = " + q(DRIVER),
    // Some computers have "Microsoft Print to PDF" switched off.
    "if (-not (Get-PrinterDriver -Name $driver -ErrorAction SilentlyContinue)) {",
    "  try { Enable-WindowsOptionalFeature -Online -FeatureName 'Printing-PrintToPDFServices-Features' -All -NoRestart | Out-Null } catch {}",
    "}",
    "if (-not (Get-PrinterDriver -Name $driver -ErrorAction SilentlyContinue)) { Write-Output 'NODRIVER'; exit 3 }",
    "if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $port }",
    "if (Get-Printer -Name $name -ErrorAction SilentlyContinue) {",
    "  Set-Printer -Name $name -DriverName $driver -PortName $port",
    "} else {",
    "  Add-Printer -Name $name -DriverName $driver -PortName $port",
    "}",
    // Finished jobs are not kept (they would pile up in Windows' spool folder).
    "try { Set-Printer -Name $name -KeepPrintedJobs $false } catch {}",
    "Write-Output 'OK'",
  ].join("\n");
  const r = await powershell(script, { timeout: 5 * 60 * 1000 });
  const out = (r.stdout + " " + r.stderr).trim();
  if (/\bOK\b/.test(r.stdout)) {
    // Only once this computer definitely has a working printer under the
    // current name is the one from a previous name taken away. Done the
    // other way round, an update on a computer where "Microsoft Print to
    // PDF" has since been switched off would remove the printer people
    // were using and fail to add its replacement, leaving them with none
    // at all - and install-record.json still naming the deleted one.
    await removePreviouslyNamed(name);
    P.updateRecord({ printer: { name, port } });
    return { ok: true, message: 'Added the "' + name + '" printer, for printing from Excel, Word and other programs.' };
  }
  if (/NODRIVER/.test(out)) {
    return {
      ok: false,
      message: 'Couldn\'t add the "' + name + '" printer: Windows\' own "Microsoft Print to PDF" is switched off on this ' +
        'computer. Turn it on in "Turn Windows features on or off", then run Setup again.',
    };
  }
  const detail = out ? out.split(/\r?\n/).slice(-3).join(" ").slice(0, 300) : "Windows PowerShell didn't run - security software may have stopped it";
  return { ok: false, message: 'Couldn\'t add the "' + name + '" printer (' + detail + ")." };
}

async function remove() {
  const record = P.readRecord();
  if (!record.printer && !(await exists())) return { ok: true, message: "" }; // never added here
  const name = (record.printer && record.printer.name) || B.NAME;
  const port = (record.printer && record.printer.port) || portPath();
  const script = [
    "$name = " + q(name) + "; $port = " + q(port),
    "if (Get-Printer -Name $name -ErrorAction SilentlyContinue) {",
    "  Get-PrintJob -PrinterName $name -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue",
    "  Remove-Printer -Name $name -ErrorAction SilentlyContinue",
    "}",
    // The port can only go once Windows has let go of the printer.
    "for ($i = 0; $i -lt 5 -and (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue); $i++) {",
    "  Start-Sleep -Seconds 1; Remove-PrinterPort -Name $port -ErrorAction SilentlyContinue",
    "}",
    "if (Get-Printer -Name $name -ErrorAction SilentlyContinue) { Write-Output 'STILL' } else { Write-Output 'GONE' }",
  ].join("\n");
  const r = await powershell(script, { timeout: 120000 });
  return /GONE/.test(r.stdout)
    ? { ok: true, message: 'Removed the "' + name + '" printer.' }
    : { ok: false, message: 'Couldn\'t remove the "' + name + '" printer. Remove it in Settings, then Printers & scanners.' };
}

async function exists() {
  const record = P.readRecord();
  const name = (record.printer && record.printer.name) || B.NAME;
  const r = await powershell("if (Get-Printer -Name " + q(name) + " -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }", { timeout: 30000 });
  return /YES/.test(r.stdout);
}

// The name the program gave the printout ("Microsoft Excel - Budget.xlsx"
// becomes "Budget.xlsx"). Asked while Windows is still writing it, when the
// job is still in the printer's list; the oldest job is the one being written.
async function currentJobName() {
  const record = P.readRecord();
  const name = (record.printer && record.printer.name) || B.NAME;
  // The oldest job still in the list is the one being written - but a job
  // that has just finished can linger there for a moment, and printing two
  // things one after the other would then put the first one's name on the
  // second. Jobs Windows has already finished with are skipped for that
  // reason, falling back to the plain oldest if that leaves none, so this
  // never answers with nothing where it used to answer with a name.
  const script = [
    "$jobs = Get-PrintJob -PrinterName " + q(name) + " -ErrorAction SilentlyContinue | Sort-Object SubmittedTime",
    "$live = $jobs | Where-Object { $_.JobStatus -notlike '*Completed*' -and $_.JobStatus -notlike '*Printed*' }",
    "if ($live) { $live | Select-Object -First 1 -ExpandProperty DocumentName }",
    "else { $jobs | Select-Object -First 1 -ExpandProperty DocumentName }",
  ].join("\n");
  const r = await powershell(script, { timeout: 15000 });
  return cleanJobName(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || "");
}

module.exports = { add, remove, exists, currentJobName };
