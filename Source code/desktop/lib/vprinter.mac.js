// macOS half of the "PrintBridge" printer - see vprinter.js.
//
// It is an ordinary printer in System Settings > Printers & Scanners, made
// with CUPS - the printing system every Mac already runs. Every Mac turns
// whatever a program prints into a PDF before handing the job to CUPS, so
// this printer's PPD tells CUPS to pass that PDF straight through with no
// conversion (`*cupsFilter2 ... 0 -`), and its "address" is this computer
// itself: socket://127.0.0.1:<port>, which is how any office network
// printer is normally reached (AppSocket/JetDirect). The background
// program listens there (startCapture below), so each printout arrives as
// a plain PDF, is written to the outbox, and is picked up by outbox.js,
// which opens the print page with it - exactly as on Windows.
//
// Why this way, and not a CUPS backend or filter of our own: since macOS
// Catalina the system volume is read-only and sealed, so nothing can be
// installed into /usr/libexec/cups, whatever permissions Setup runs with.
// Using the socket backend that macOS already ships means PrintBridge
// installs no files outside its own folder, and needs no changes to the
// printing system's configuration.
//
// Checked against a real, running CUPS (the same open-source CUPS macOS
// ships): the PPD passes `cupstestppd` cleanly, and a job submitted to
// such a queue arrives byte-for-byte over the socket, with its title
// readable from CUPS's own spool - see activeJobTitle().

const fs = require("fs");
const net = require("net");
const path = require("path");
const P = require("./paths");
const B = require("./brand");
const { portPath, titlePath, cleanJobName } = require("./printout");
const { run } = require("./win"); // a plain command runner, despite the file's name - see win.js

const PPD_FILE = path.join(P.DATA_DIR, "PrintBridge.ppd");
// CUPS keeps each job's details in a small file in its spool folder while
// the job exists. /var/spool/cups is the same place on macOS (where /var
// leads to /private/var).
const SPOOL_DIR = "/var/spool/cups";

// A CUPS queue name can't contain spaces, "/" or "#". The name people
// actually see in the Print window is the description (-D below), which
// keeps the brand name exactly as it is written.
function queueName() {
  return String(B.NAME).replace(/[\s/#]+/g, "-").replace(/-+/g, "-").slice(0, 60) || "PrintBridge";
}

function deviceUri() {
  return "socket://127.0.0.1:" + P.PRINT_PORT;
}

function ppdContent() {
  // A minimal, valid PPD (checked with `cupstestppd`) - only enough to
  // describe a PDF-accepting printer. `*cupsFilter2 ... 0 -` is the part
  // that matters: cost 0, no filter program ("-"), so CUPS hands the PDF
  // over unchanged.
  return [
    '*PPD-Adobe: "4.3"',
    "*%" + B.NAME + " - captures each printout as a PDF for the " + B.NAME + " print page.",
    '*FormatVersion: "4.3"',
    '*FileVersion: "1.0"',
    "*LanguageVersion: English",
    "*LanguageEncoding: ISOLatin1",
    '*PCFileName: "PRNTBRDG.PPD"',
    '*Manufacturer: "' + B.NAME + '"',
    '*Product: "(' + B.NAME + ')"',
    '*ModelName: "' + B.NAME + '"',
    '*ShortNickName: "' + B.NAME + '"',
    '*NickName: "' + B.NAME + '"',
    '*PSVersion: "(3010.000) 0"',
    '*LanguageLevel: "3"',
    "*ColorDevice: True",
    "*DefaultColorSpace: RGB",
    "*FileSystem: False",
    '*Throughput: "1"',
    "*LandscapeOrientation: Plus90",
    "*TTRasterizer: Type42",
    '*cupsFilter2: "application/pdf application/pdf 0 -"',
    "*OpenUI *PageSize/Page Size: PickOne",
    "*OrderDependency: 10 AnySetup *PageSize",
    "*DefaultPageSize: Letter",
    '*PageSize Letter/US Letter: "<</PageSize[612 792]>>setpagedevice"',
    '*PageSize A4/A4: "<</PageSize[595 842]>>setpagedevice"',
    "*CloseUI: *PageSize",
    "*OpenUI *PageRegion/Page Region: PickOne",
    "*OrderDependency: 10 AnySetup *PageRegion",
    "*DefaultPageRegion: Letter",
    '*PageRegion Letter/US Letter: "<</PageSize[612 792]>>setpagedevice"',
    '*PageRegion A4/A4: "<</PageSize[595 842]>>setpagedevice"',
    "*CloseUI: *PageRegion",
    "*DefaultImageableArea: Letter",
    '*ImageableArea Letter/US Letter: "0 0 612 792"',
    '*ImageableArea A4/A4: "0 0 595 842"',
    "*DefaultPaperDimension: Letter",
    '*PaperDimension Letter/US Letter: "612 792"',
    '*PaperDimension A4/A4: "595 842"',
    "",
  ].join("\n");
}

// If an earlier install here (an earlier brand name, or a future rename)
// added this printer under a different name, that copy is removed first -
// otherwise it would be left behind as a stale duplicate queue.
async function removePreviouslyNamed(currentName) {
  const record = P.readRecord();
  const prevName = record.printer && record.printer.name;
  if (!prevName || prevName.toLowerCase() === String(currentName).toLowerCase()) return;
  try {
    await run("lpadmin", ["-x", prevName]);
  } catch (err) {
    /* best effort - add() below still gives this computer a working printer */
  }
}

async function add() {
  P.ensureDirs();
  const name = queueName();

  try {
    fs.writeFileSync(PPD_FILE, ppdContent());
  } catch (err) {
    return { ok: false, message: 'Couldn\'t add the "' + B.NAME + '" printer: ' + err.message + " (Setup needs to run as an administrator)." };
  }

  await removePreviouslyNamed(name);

  const r = await run("lpadmin", [
    "-p", name,
    "-E",
    "-v", deviceUri(),
    "-P", PPD_FILE,
    "-D", B.NAME,
    "-L", "This computer",
    "-o", "printer-is-shared=false",
  ]);
  if (!r.ok) {
    const detail = (r.stderr || r.stdout || "lpadmin didn't run").trim().slice(0, 300);
    return { ok: false, message: 'Couldn\'t add the "' + B.NAME + '" printer (' + detail + ")." };
  }
  P.updateRecord({ printer: { name, uri: deviceUri() } });
  return { ok: true, message: 'Added the "' + B.NAME + '" printer, for printing from Word, Excel and any other program.' };
}

async function remove() {
  const record = P.readRecord();
  if (!record.printer && !(await exists())) return { ok: true, message: "" }; // never added here
  const name = (record.printer && record.printer.name) || queueName();
  await run("lpadmin", ["-x", name]);
  try { fs.rmSync(PPD_FILE, { force: true }); } catch (err) { /* fine */ }
  return (await exists())
    ? { ok: false, message: 'Couldn\'t remove the "' + B.NAME + '" printer. Remove it in System Settings, then Printers & Scanners.' }
    : { ok: true, message: 'Removed the "' + B.NAME + '" printer.' };
}

async function exists() {
  const record = P.readRecord();
  const name = (record.printer && record.printer.name) || queueName();
  const r = await run("lpstat", ["-p", name]);
  return r.ok;
}

// --- taking each printout as it arrives ---------------------------------------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The name CUPS was given for the job it is sending right now. CUPS writes
// each job's details into a small file in its spool folder, as IPP: the
// attribute name, then two bytes of length, then the text. Read straight
// from there because none of lpstat's own output includes the title.
// Best effort throughout - a printout without a name still prints, it is
// just called "Printout at 10.45" instead (see outbox.js).
function titleFromSpool(id) {
  const file = path.join(SPOOL_DIR, "c" + String(id).padStart(5, "0"));
  try {
    const data = fs.readFileSync(file);
    const at = data.indexOf("job-name");
    if (at < 0) return "";
    const lengthAt = at + "job-name".length;
    const length = data.readUInt16BE(lengthAt);
    if (!(length > 0 && length < 1000)) return "";
    return cleanJobName(data.slice(lengthAt + 2, lengthAt + 2 + length).toString("utf8"));
  } catch (err) {
    return ""; // not there any more, or not readable
  }
}

async function activeJobTitle() {
  const record = P.readRecord();
  const name = (record.printer && record.printer.name) || queueName();
  const r = await run("lpstat", ["-W", "not-completed", "-o", name], { timeout: 10000 });
  // Lines look like "PrintBridge-7  someone  1024  Sat 26 Sep ..."; the
  // job number is on the end of the first word. The oldest is the one
  // being sent now, which is the order lpstat already answers in.
  for (const line of r.stdout.split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0] || "";
    const id = first.split("-").pop();
    if (!/^\d+$/.test(id)) continue;
    const title = titleFromSpool(id);
    if (title) return title;
  }
  return "";
}

// Listens for printouts. CUPS's own socket backend opens a connection per
// job and sends the PDF, so a connection is a printout: it is written under
// a temporary name and only put in place (as the one file outbox.js
// watches) once it has arrived in full.
function startCapture(log) {
  const say = (line) => { try { (log ? log.line(line) : console.log(line)); } catch (err) { /* logging only */ } };
  let server = null;

  const listen = (attempt) => {
    server = net.createServer((socket) => {
      const temp = portPath() + ".part-" + process.pid + "-" + Date.now();
      const out = fs.createWriteStream(temp);
      // Asked for now, while the job is still CUPS's: by the time the PDF
      // is in place it may already be gone from the spool.
      const title = activeJobTitle().catch(() => "");
      // A connection that breaks part-way leaves nothing behind.
      const dropTemp = () => { try { fs.rmSync(temp, { force: true }); } catch (err) { /* nothing more to do */ } };
      socket.on("error", () => { try { out.destroy(); } catch (err) { /* going anyway */ } dropTemp(); });
      out.on("error", (err) => { say("Couldn't save a printout: " + err.message); dropTemp(); });
      socket.pipe(out);
      out.on("finish", async () => {
        try {
          const name = await title;
          // If the last printout hasn't been picked up yet, wait a moment
          // rather than writing over it.
          for (let i = 0; i < 40 && fs.existsSync(portPath()); i++) await wait(250);
          // The name is written only now, once the previous printout has been
          // taken (with its own name): written before the wait, two printouts
          // in quick succession could each be filed under the other's name.
          if (name) { try { fs.writeFileSync(titlePath(), name); } catch (err) { /* a name is only a nicety */ } }
          fs.renameSync(temp, portPath());
        } catch (err) {
          say("Couldn't put a printout where it is picked up: " + err.message);
          try { fs.rmSync(temp, { force: true }); } catch (err2) { /* nothing more to do */ }
        }
      });
    });

    server.on("error", async (err) => {
      if (err.code === "EADDRINUSE" && attempt < 10) {
        // Usually the copy that was just restarted, still letting go.
        await wait(2000);
        return listen(attempt + 1);
      }
      say('Couldn\'t listen for printouts on port ' + P.PRINT_PORT + " (" + err.code + "). " +
        'Printing from programs to "' + B.NAME + '" won\'t work until this is sorted out.');
    });

    // Only this computer can reach it - never the network.
    server.listen(P.PRINT_PORT, "127.0.0.1", () => {
      say('Ready for printouts sent to the "' + B.NAME + '" printer.');
    });
  };

  listen(0);
  return () => { try { server && server.close(); } catch (err) { /* going anyway */ } };
}

// The name of the printout that has just arrived, written beside it a
// moment earlier by startCapture().
async function currentJobName() {
  try {
    const raw = fs.readFileSync(titlePath(), "utf8");
    fs.rmSync(titlePath(), { force: true });
    return cleanJobName(raw);
  } catch (err) {
    return "";
  }
}

module.exports = { add, remove, exists, currentJobName, startCapture, ppdContent, queueName, deviceUri };
