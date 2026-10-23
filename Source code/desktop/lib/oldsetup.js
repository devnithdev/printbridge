// Finding an older Office Printing setup on this computer, and replacing it.
//
// Older versions were a folder of files (server\, PrintAgent.exe and some
// .bat files) started by an entry in a Startup folder, sometimes by a
// Task Scheduler task, or by hand. They could live anywhere - often the
// Desktop, Documents or Downloads.
//
// The one rule that keeps this safe: nothing is stopped, deleted or renamed
// unless it leads back to a folder CONFIRMED to hold the old Office Printing
// files - one with AutoStart-Printing.bat or "Start Print Platform.bat" in
// it, a PrintAgent.exe with an Office Printing config.json next to it, or
// the old website (server\package.json named "print-platform-server").
// Anything else that merely has a similar name is left alone, and nothing
// inside Windows or Program Files is ever touched.
//
// Candidates are found by:
//   1. what starts them: Startup folders (every user's, and the all-users
//      one), Task Scheduler, and the "Run" registry keys;
//   2. what is running now (PrintAgent.exe, the keep-running windows, the
//      old website on port 3000);
//   3. a look through the usual folders for copies holding saved data.
//
// Replacing keeps what matters - the list of printers and computers
// (server\data\db.json) and this computer's connection (config.json) -
// stops the old programs, removes whatever started them, and renames their
// start-up files so they can't be started again by accident. The old folder
// is left in place, with a note inside saying it can be deleted.

const fs = require("fs");
const path = require("path");
const P = require("./paths");
const { run, powershell, jsonList } = require("./win");

// The only file names that can point to an old setup.
const OUR_FILES = new Set(["autostart-printing.bat", "start print platform.bat", "printagent.exe", "server.js"]);
const LAUNCHERS = ["AutoStart-Printing.bat", "Start Print Platform.bat", "PrintAgent.exe"];
const NOTE_NAME = "OLD COPY - NOT USED ANY MORE.txt";

// Test hooks: on Linux the Windows folders can be pointed at a fake tree.
function roots() {
  const drive = process.env.SystemDrive || "C:";
  return {
    usersDir: process.env.OP_TEST_USERS_DIR || path.join(drive + "\\", "Users"),
    driveRoot: process.env.OP_TEST_DRIVE_ROOT || drive + "\\",
    programData: process.env.OP_TEST_PROGRAMDATA || process.env.ProgramData || "C:\\ProgramData",
  };
}

const exists = (p) => { try { fs.accessSync(p); return true; } catch (err) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (err) { return false; } };
const listDir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return []; } };
const key = (p) => (P.IS_WINDOWS ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => key(a) === key(b);
const inside = (p, base) => key(p) === key(base) || key(p).startsWith(key(base) + path.sep);

// Places that are never an old copy, whatever points at them.
function offLimits(p) {
  const bases = [
    P.INSTALL_DIR, P.DATA_DIR,
    process.env.SystemRoot, process.env.windir,
    process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432,
  ].filter(Boolean);
  return bases.some((b) => inside(p, b));
}

// A folder synced by OneDrive may be shared with other computers, where
// renaming files would break a setup that hasn't been replaced yet.
const inOneDrive = (p) => path.resolve(p).split(/[\\/]/).some((part) => /^onedrive/i.test(part));

function userProfiles() {
  const skip = /^(public|default|default user|all users|defaultapppool|wdagutilityaccount)$/i;
  return listDir(roots().usersDir)
    .filter((e) => e.isDirectory() && !skip.test(e.name))
    .map((e) => path.join(roots().usersDir, e.name));
}

// The Desktop itself etc.: may hold old files, but is never "the old copy".
function isSpecialFolder(dir) {
  const base = path.basename(path.resolve(dir));
  if (/^(desktop|documents|downloads|onedrive.*|users|startup)$/i.test(base)) return true;
  if (samePath(dir, roots().driveRoot)) return true;
  return userProfiles().some((profile) => samePath(profile, dir));
}

// Paths of old Office Printing files mentioned in some text: a .bat file,
// a shortcut, a task, a command line. Anything else mentioned (cmd.exe,
// node.exe, other programs) is ignored.
function pathsMentionedIn(textOrBuffer) {
  const buffer = Buffer.isBuffer(textOrBuffer) ? textOrBuffer : Buffer.from(String(textOrBuffer), "utf8");
  const text = buffer.toString("utf8") + "\n" + buffer.toString("latin1") + "\n" + buffer.toString("utf16le");
  const pattern = P.IS_WINDOWS || !process.env.OP_TEST_USERS_DIR
    ? /[A-Za-z]:\\[^"*?<>|\r\n\0]*?\.(?:bat|cmd|exe|js)\b/gi
    : /\/[^"*?<>|\r\n\0]*?\.(?:bat|cmd|exe|js)\b/gi;
  const found = new Set();
  for (const match of text.match(pattern) || []) {
    // "C:\Windows\system32\cmd.exe /c C:\old\AutoStart-Printing.bat" is
    // matched as one piece; split at each drive letter to get both paths.
    for (const piece of match.split(/(?=[A-Za-z]:\\)/)) {
      const clean = piece.trim();
      if (OUR_FILES.has(path.basename(clean).toLowerCase())) found.add(clean);
    }
  }
  return [...found];
}

// The folder an old file belongs to: ...\server\server.js belongs to ...,
// ...\dist\PrintAgent.exe to ...; anything else to its own folder.
function folderOf(file) {
  let dir = path.dirname(file);
  if (/^(server|dist)$/i.test(path.basename(dir))) dir = path.dirname(dir);
  return dir;
}

function isOldServerDir(dir) {
  if (!exists(path.join(dir, "server.js"))) return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "print-platform-server";
  } catch (err) {
    return false;
  }
}

function readAgentConfig(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    // Office Printing's own format: a token and a ws://.../agent address.
    if (!c.token || !/^wss?:\/\/.+\/agent$/i.test(String(c.serverUrl || ""))) return null;
    return { file, mtime: fs.statSync(file).mtimeMs, serverUrl: String(c.serverUrl), agentName: String(c.agentName || "") };
  } catch (err) {
    return null;
  }
}

function readDb(file) {
  try {
    const db = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(db.agents) || !Array.isArray(db.printers)) return null;
    return { file, mtime: fs.statSync(file).mtimeMs, computers: db.agents.length, printers: db.printers.length };
  } catch (err) {
    return null;
  }
}

// What old Office Printing things are at or below `dir`.
function inspect(dir, depth, found, budget) {
  if (budget.left-- <= 0 || offLimits(dir)) return;
  const entries = listDir(dir);
  const names = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name]));
  if (names.has(NOTE_NAME.toLowerCase())) return; // replaced by an earlier Setup

  if (names.has("autostart-printing.bat") || names.has("start print platform.bat")) found.launcherDirs.add(dir);
  if (names.has("printagent.exe")) {
    const config = readAgentConfig(path.join(dir, "config.json"));
    // A PrintAgent.exe counts only with Office Printing's config.json next
    // to it, or with the old start-up files beside it.
    if (config || names.has("autostart-printing.bat")) {
      found.agentDirs.add(dir);
      if (config) found.configs.push(config);
    }
  }
  if (names.has("server.js") && isOldServerDir(dir)) {
    found.serverDirs.add(dir);
    const db = readDb(path.join(dir, "data", "db.json"));
    if (db) found.dbs.push(Object.assign(db, { dir }));
  }

  if (depth <= 0) return;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (/^(node_modules|\.git|downloads|uploads|appdata|\$recycle\.bin|windows|program files.*)$/i.test(entry.name)) continue;
    inspect(path.join(dir, entry.name), depth - 1, found, budget);
  }
}

function emptyFound() {
  return { launcherDirs: new Set(), agentDirs: new Set(), serverDirs: new Set(), configs: [], dbs: [] };
}

// Is this folder an old Office Printing copy? Returns what's in it, or null.
function confirm(dir) {
  if (!isDir(dir) || offLimits(dir)) return null;
  const found = emptyFound();
  inspect(dir, isSpecialFolder(dir) ? 0 : 2, found, { left: 400 });
  const confirmed = found.launcherDirs.size || found.agentDirs.size || found.serverDirs.size;
  return confirmed ? found : null;
}

// --- what starts it ----------------------------------------------------------

function startupFolders() {
  const folders = [path.join(roots().programData, "Microsoft", "Windows", "Start Menu", "Programs", "StartUp")];
  for (const profile of userProfiles()) {
    folders.push(path.join(profile, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"));
  }
  return folders.filter(isDir);
}

function findStartupItems() {
  const items = [];
  for (const folder of startupFolders()) {
    for (const entry of listDir(folder)) {
      if (!entry.isFile() || !/\.(bat|cmd|lnk|vbs|ps1)$/i.test(entry.name)) continue;
      const file = path.join(folder, entry.name);
      let content;
      try {
        if (fs.statSync(file).size > 1024 * 1024) continue;
        content = fs.readFileSync(file);
      } catch (err) {
        continue;
      }
      const mentions = pathsMentionedIn(content);
      // An "Office Printing.bat" made by the old setup, even if the folder it
      // points to has since been deleted (it would just show an error), or
      // its path is in an older text encoding that can't be read back.
      const ours = /^office printing\.bat$/i.test(entry.name) && /AutoStart-Printing\.bat/i.test(content.toString("latin1"));
      if (mentions.length || ours) items.push({ file, mentions, ours });
    }
  }
  return items;
}

async function findScheduledTasks() {
  if (!P.IS_WINDOWS) return [];
  const script =
    "Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $t = $_; foreach ($a in $t.Actions) {" +
    " [pscustomobject]@{ name = ($t.TaskPath + $t.TaskName); exe = [string]$a.Execute;" +
    " args = [string]$a.Arguments; dir = [string]$a.WorkingDirectory } } } | ConvertTo-Json -Compress";
  const result = await powershell(script, { timeout: 90000 });
  const tasks = new Map();
  for (const t of jsonList(result.stdout)) {
    const text = [t.exe, t.args].join(" ");
    const mentions = pathsMentionedIn(text);
    // "node server.js" started in a working folder.
    if (/(^|[\s"'])server\.js\b/i.test(String(t.args || "")) && t.dir) mentions.push(path.join(String(t.dir).replace(/"/g, ""), "server.js"));
    if (/(^|[\s"'])PrintAgent\.exe\b/i.test(text) && t.dir && !mentions.length) mentions.push(path.join(String(t.dir).replace(/"/g, ""), "PrintAgent.exe"));
    if (mentions.length) tasks.set(t.name, { name: t.name, mentions });
  }
  return [...tasks.values()];
}

async function findRunEntries() {
  if (!P.IS_WINDOWS) return [];
  const script =
    "$out = @(); foreach ($k in 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'," +
    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run') {" +
    " $p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue; if (-not $p) { continue };" +
    " foreach ($n in $p.PSObject.Properties) { if ($n.Name -like 'PS*') { continue };" +
    " $out += [pscustomobject]@{ key = $k; name = $n.Name; value = [string]$n.Value } } };" +
    " $out | ConvertTo-Json -Compress";
  const result = await powershell(script);
  return jsonList(result.stdout)
    .filter((e) => e && e.name !== "Office Printing")
    .map((e) => ({ key: e.key, name: e.name, mentions: pathsMentionedIn(e.value) }))
    .filter((e) => e.mentions.length);
}

// --- what is running ---------------------------------------------------------

async function findProcesses() {
  if (!P.IS_WINDOWS) return [];
  const script =
    "$l = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |" +
    " Select-Object -ExpandProperty OwningProcess);" +
    " Get-CimInstance Win32_Process -Filter \"Name='PrintAgent.exe' OR Name='cmd.exe' OR Name='node.exe'\" |" +
    " ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name;" +
    " exe = [string]$_.ExecutablePath; cmd = [string]$_.CommandLine; listens = ($l -contains $_.ProcessId) } } |" +
    " ConvertTo-Json -Compress";
  const result = await powershell(script);
  const out = [];
  for (const p of jsonList(result.stdout)) {
    const name = String(p.name || "").toLowerCase();
    const cmd = String(p.cmd || "");
    if (name === "printagent.exe" && p.exe) {
      out.push({ pid: p.pid, kind: "agent", mentions: [p.exe] });
    } else if (name === "cmd.exe" && /AutoStart-Printing\.bat|Start Print Platform\.bat/i.test(cmd)) {
      out.push({ pid: p.pid, kind: "loop", mentions: pathsMentionedIn(cmd) });
    } else if (name === "node.exe" && p.listens && /server\.js/i.test(cmd)) {
      out.push({ pid: p.pid, kind: "website", mentions: pathsMentionedIn(cmd), unsure: !pathsMentionedIn(cmd).length });
    }
  }
  // PowerShell can be switched off or restricted by an office's IT
  // settings, and then quietly finds nothing. The basic tools find the
  // important ones regardless (without knowing where they were started
  // from - see how "unsure" ones are treated in detect()).
  for (const p of await findProcessesWithoutPowerShell()) {
    if (!out.some((o) => o.pid === p.pid)) out.push(p);
  }
  return out;
}

async function findProcessesWithoutPowerShell() {
  const out = [];
  const list = await run("tasklist.exe", ["/FO", "CSV", "/NH"]);
  const names = new Map();
  for (const line of list.stdout.split(/\r?\n/)) {
    const cells = (line.match(/"([^"]*)"/g) || []).map((c) => c.slice(1, -1));
    if (cells.length >= 2 && /^\d+$/.test(cells[1])) names.set(parseInt(cells[1], 10), cells[0].toLowerCase());
  }
  for (const [pid, name] of names) {
    if (name === "printagent.exe") out.push({ pid, kind: "agent", mentions: [], unsure: true });
  }
  const net = await run("netstat.exe", ["-ano", "-p", "TCP"]);
  for (const line of net.stdout.split(/\r?\n/)) {
    // e.g.  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    4242
    const m = /^\s*TCP\s+\S+[:.]3000\s+(0\.0\.0\.0:0|\[::\]:0|\*:\*)\s+\S*\s*(\d+)\s*$/i.exec(line);
    if (m && names.get(parseInt(m[2], 10)) === "node.exe") out.push({ pid: parseInt(m[2], 10), kind: "website", mentions: [], unsure: true });
  }
  return out;
}

// --- the whole picture -------------------------------------------------------

function usualPlaces() {
  const places = [];
  for (const profile of userProfiles()) {
    places.push(path.join(profile, "Desktop"), path.join(profile, "Documents"), path.join(profile, "Downloads"));
    for (const entry of listDir(profile)) {
      if (entry.isDirectory() && /^onedrive/i.test(entry.name)) {
        places.push(path.join(profile, entry.name, "Desktop"), path.join(profile, entry.name, "Documents"));
      }
    }
  }
  for (const entry of listDir(roots().driveRoot)) {
    if (entry.isDirectory() && /print|office/i.test(entry.name) && !/^program/i.test(entry.name)) {
      places.push(path.join(roots().driveRoot, entry.name));
    }
  }
  return places.filter(isDir);
}

async function detect() {
  const startup = findStartupItems();
  const [tasks, runEntries, processes] = await Promise.all([findScheduledTasks(), findRunEntries(), findProcesses()]);

  // Folders named by what starts or runs things - kept only if confirmed.
  const confirmed = new Map(); // key -> { dir, found }
  const check = (dir) => {
    const k = key(dir);
    if (!confirmed.has(k)) confirmed.set(k, { dir, found: confirm(dir) });
    return confirmed.get(k).found;
  };
  const leadsToOld = (source) => source.mentions.some((m) => check(folderOf(m)));

  const oldStartup = startup.filter((s) => leadsToOld(s) || s.ours);
  const oldTasks = tasks.filter(leadsToOld);
  const oldRun = runEntries.filter(leadsToOld);
  const activeDirs = [...confirmed.values()].filter((c) => c.found).map((c) => c.dir);

  // Copies in the usual places that hold saved data, even if not running.
  const scanned = emptyFound();
  const budget = { left: 4000 };
  for (const place of usualPlaces()) inspect(place, 3, scanned, budget);

  const all = emptyFound();
  for (const c of [...confirmed.values()].filter((c) => c.found).map((c) => c.found).concat([scanned])) {
    for (const k of ["launcherDirs", "agentDirs", "serverDirs"]) for (const d of c[k]) all[k].add(d);
    all.configs.push(...c.configs);
    all.dbs.push(...c.dbs);
  }
  const activeKeys = new Set(activeDirs.map(key));
  const isActive = (dir) => [...activeKeys].some((a) => key(dir) === a || key(dir).startsWith(a + path.sep));
  // A copy that was in use counts even if empty; one merely lying around
  // counts only if it actually has something saved in it.
  // If there are several, prefer the one this computer was actually using,
  // then one outside OneDrive (which may belong to another computer), then
  // the most recently changed.
  const rank = (dir) => (isActive(dir) ? 0 : 2) + (inOneDrive(dir) ? 1 : 0);
  const best = (a, b) => rank(a.dir) - rank(b.dir) || b.mtime - a.mtime;
  const seen = new Set();
  const once = (item) => (seen.has(key(item.file)) ? false : seen.add(key(item.file)));
  const dbs = all.dbs.filter((d) => isActive(d.dir) || d.computers > 0).filter(once).sort(best);
  const configs = all.configs.map((c) => Object.assign(c, { dir: path.dirname(c.file) })).filter(once).sort(best);

  // Running programs: stopped if they belong to a confirmed old folder. The
  // ones found without knowing their folder (no PowerShell) only if an old
  // copy of that part was confirmed on this computer.
  const oldProcesses = processes.filter((p) => {
    if (p.mentions.length) return p.mentions.some((m) => check(folderOf(m)));
    if (p.kind === "agent") return all.agentDirs.size > 0;
    if (p.kind === "website") return all.serverDirs.size > 0;
    return false;
  });

  // The folders a person would recognise, for messages and the note.
  const folders = new Map();
  const addFolder = (dir) => { if (!isSpecialFolder(dir) && !offLimits(dir)) folders.set(key(dir), dir); };
  for (const dir of activeDirs) addFolder(dir);
  for (const d of dbs) addFolder(topFolder(d.dir, activeDirs));
  for (const c of configs) addFolder(topFolder(path.dirname(c.file), activeDirs));

  // Start-up files to rename: in the confirmed folders and data folders.
  const launchers = new Map();
  const addLaunchers = (found) => {
    for (const d of found.launcherDirs) for (const n of LAUNCHERS) if (exists(path.join(d, n))) launchers.set(key(path.join(d, n)), path.join(d, n));
    for (const d of found.agentDirs) launchers.set(key(path.join(d, "PrintAgent.exe")), path.join(d, "PrintAgent.exe"));
    for (const d of found.serverDirs) launchers.set(key(path.join(d, "server.js")), path.join(d, "server.js"));
  };
  for (const c of confirmed.values()) if (c.found) addLaunchers(c.found);
  for (const dir of folders.values()) { const f = confirm(dir); if (f) addLaunchers(f); }

  return {
    found: folders.size > 0 || activeDirs.length > 0 || oldStartup.length > 0 || oldTasks.length > 0 ||
      oldRun.length > 0 || oldProcesses.length > 0 || dbs.length > 0 || configs.length > 0,
    folders: folders.size ? [...folders.values()] : activeDirs,
    website: dbs[0] || null,
    printer: configs[0] || null,
    startup: oldStartup,
    tasks: oldTasks,
    runEntries: oldRun,
    processes: oldProcesses,
    launchers: [...launchers.values()],
  };
}

// For C:\...\printerSystem\print-platform\server, the folder a person would
// recognise: the one the old setup was started from, if it's above.
function topFolder(dir, activeDirs) {
  for (const a of activeDirs) if (inside(dir, a)) return a;
  if (/^server$/i.test(path.basename(dir))) return path.dirname(dir);
  return dir;
}

function httpFromWs(wsUrl) {
  try {
    const url = new URL(wsUrl);
    return (url.protocol === "wss:" ? "https://" : "http://") + url.host;
  } catch (err) {
    return "";
  }
}

const pointsHere = (wsUrl) => /\/\/(localhost|127\.0\.0\.1)[:/]/i.test(wsUrl);

// --- replacing it --------------------------------------------------------------

const say = (text) => console.log(text);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopProcesses(processes) {
  if (!P.IS_WINDOWS || !processes.length) return;
  // The keep-running windows first, so they can't start things again; /T
  // takes whatever each one started with it.
  const order = { loop: 0, agent: 1, website: 2 };
  for (const p of [...processes].sort((a, b) => order[a.kind] - order[b.kind])) {
    const args = p.kind === "loop" ? ["/F", "/T", "/PID", String(p.pid)] : ["/F", "/PID", String(p.pid)];
    const r = await run("taskkill.exe", args);
    if (!r.ok && p.kind === "loop") await run("taskkill.exe", ["/F", "/PID", String(p.pid)]);
  }
  say("  Stopped the old version (" + processes.length + " program" + (processes.length === 1 ? "" : "s") + ").");
  await wait(2000);
}

function renameAside(file) {
  const target = file + ".old";
  try {
    if (exists(target)) fs.rmSync(target, { force: true });
    fs.renameSync(file, target);
    return true;
  } catch (err) {
    return false;
  }
}

async function migrate(role) {
  const old = await detect();
  if (!old.found) {
    say("  No older version found.");
    return old;
  }

  say("Replacing the older version of " + require("./brand").NAME + "...");
  for (const folder of old.folders) say("  Found it in: " + folder);

  await stopProcesses(old.processes);

  for (const item of old.startup) {
    try {
      fs.rmSync(item.file, { force: true });
      say("  Removed its Startup entry: " + path.basename(item.file));
    } catch (err) {
      say("  Could not remove the Startup entry " + item.file + " - please delete it by hand.");
    }
  }
  for (const task of old.tasks) {
    const r = await run("schtasks.exe", ["/Delete", "/TN", task.name, "/F"]);
    say(r.ok ? "  Removed its scheduled task: " + task.name : "  Could not remove the scheduled task " + task.name + " - please delete it in Task Scheduler.");
  }
  for (const entry of old.runEntries) {
    const regKey = entry.key.replace(/^HKLM:\\/, "HKLM\\").replace(/^HKCU:\\/, "HKCU\\");
    const r = await run("reg.exe", ["delete", regKey, "/v", entry.name, "/f"]);
    say(r.ok ? "  Removed its start-up setting: " + entry.name : "  Could not remove the start-up setting " + entry.name);
  }
  if (P.IS_WINDOWS) {
    await run("netsh.exe", ["advfirewall", "firewall", "delete", "rule", "name=Office Printing (Node.js)"]);
  }

  // Keep the list of printers and computers (main computer).
  P.ensureDirs();
  const newDb = path.join(P.WEBSITE_DIR, "db.json");
  let dataMoved = true;
  if (old.website) {
    if (role !== "main") {
      say("  This computer used to run the printing website. It is now set up to share");
      say("  its printers only, so the old list of printers was left where it was:");
      say("  " + old.website.file);
      // Nothing was moved, so the old folder is NOT marked as replaced: the
      // note would claim the list had moved, and uninstalling would then
      // delete that folder - the only copy of the office's printer list.
      dataMoved = false;
    } else if (exists(newDb)) {
      say("  Kept the current list of printers (it was already moved over earlier).");
    } else {
      try {
        fs.copyFileSync(old.website.file, newDb);
        say("  Kept the list of printers and computers (" + old.website.computers + " computer" +
          (old.website.computers === 1 ? "" : "s") + ", " + old.website.printers + " printer" +
          (old.website.printers === 1 ? "" : "s") + ").");
      } catch (err) {
        dataMoved = false;
        say("  Could not copy the list of printers (" + err.message + ").");
      }
    }
  }

  // Keep this computer's connection to the website, so it doesn't appear
  // twice in the list.
  const newConfig = path.join(P.PRINTER_DIR, "config.json");
  // Not for a computer that only prints (it never shares printers), and not
  // when Setup was given a different main computer's address: the copied
  // connection would win over what was typed, and this computer would
  // quietly rejoin the old main computer instead.
  const hostOf = (u) => {
    let t = String(u || "").trim();
    if (t && !/^[a-z]+:\/\//i.test(t)) t = "http://" + t;
    try { return new URL(t.replace(/^ws/i, "http")).hostname.toLowerCase(); } catch (err) { return ""; }
  };
  const typedHost = hostOf(P.readSettings().server);
  const typedElsewhere = role !== "main" && !!old.printer && !!typedHost && typedHost !== hostOf(old.printer.serverUrl);
  if (old.printer && role === "client") {
    say("  This computer now only prints, so its old printer connection was not kept.");
  } else if (old.printer && typedElsewhere) {
    say("  A different main computer was given, so the old printer connection was not kept.");
  }
  if (old.printer && role !== "client" && !typedElsewhere && !exists(newConfig)) {
    const usable = role === "main" ? true : !pointsHere(old.printer.serverUrl);
    if (usable) {
      try {
        fs.copyFileSync(old.printer.file, newConfig);
        say('  Kept this computer\'s printer connection ("' + (old.printer.agentName || "unnamed") + '").');
      } catch (err) {
        dataMoved = false;
        say("  Could not copy this computer's printer connection (" + err.message + ").");
      }
    }
  }

  // Switch the old copy off for good, without deleting anyone's files -
  // except in OneDrive, which may share the folder with other computers.
  let renamed = 0;
  let skippedOneDrive = false;
  for (const file of old.launchers) {
    if (!exists(file)) continue;
    if (inOneDrive(file)) { skippedOneDrive = true; continue; }
    let ok = renameAside(file);
    if (!ok) {
      await wait(3000);
      ok = renameAside(file);
    }
    if (ok) renamed++;
    else say("  Could not switch off " + file + " - please delete it by hand.");
  }
  if (renamed) say("  Switched off the old start-up files (renamed to .old).");
  if (skippedOneDrive) {
    say("  The old folder is in OneDrive, so its files were left exactly as they are");
    say("  (other computers may use them). It no longer starts by itself here.");
  }

  const note = [
    "This folder holds an OLD copy of the office printing setup that is no longer used.",
    "",
    "It is now installed as a normal program (Start menu > " + require("./brand").NAME + ")",
    "and starts by itself. Your list of printers was moved over to it.",
    "",
    "You can delete this whole folder. Nothing uses it any more.",
    "",
  ].join("\r\n");
  let noted = 0;
  if (dataMoved) {
    for (const folder of old.folders) {
      if (isSpecialFolder(folder) || offLimits(folder) || inOneDrive(folder)) continue;
      try {
        fs.writeFileSync(path.join(folder, NOTE_NAME), note);
        noted++;
        rememberReplaced(folder);
      } catch (err) {
        /* only a courtesy */
      }
    }
  }
  if (noted) say("  The old folder was left in place with a note inside - it can be deleted.");
  return old;
}

// --- removing the old copy when this program is uninstalled -------------------
//
// Only folders this program's Setup replaced (they have the note in them)
// are touched, and inside them only the things the older version put
// there. Anything else someone saved in the folder stays, and so does the
// folder itself unless it ends up empty.

function rememberReplaced(folder) {
  if (isDriveRoot(folder) || isSpecialFolder(folder)) return;
  const record = P.readRecord();
  const list = new Set(record.replacedFolders || []);
  list.add(path.resolve(folder));
  P.updateRecord({ replacedFolders: [...list] });
}

// Names only the older versions used - distinctive enough that nobody's own
// file would have them (compared ignoring case). A ".old" copy counts too.
// Common names (config.json, README.md...) are NOT in this list: those are
// only removed when their content proves they are the old version's.
const OLD_FILES = [
  "AutoStart-Printing.bat", "Start Print Platform.bat", "Setup-Printing.bat", "Reset-or-Remove-Printing.bat",
  "Check-Printing.bat", "Check-Printing.ps1", "Setup-Powercut-Proof.bat", "Keep-Laptop-Awake.ps1",
  "PrintAgent.exe", NOTE_NAME,
  "Start Print Platform (Mac only).command", "Start Print Platform.command",
  "Office-Printing-Guide.docx", "Office Printing - Setup Guide.docx", "Office Printing - Setup Guide.pdf",
].map((n) => n.toLowerCase());

const isOldName = (n) => OLD_FILES.includes(n) || OLD_FILES.includes(n.replace(/\.old$/, ""));

function isOldServerFolder(dir) {
  const pkg = P.readJson(path.join(dir, "package.json"));
  const hasServer = exists(path.join(dir, "server.js")) || exists(path.join(dir, "server.js.old"));
  return !!(pkg && pkg.name === "print-platform-server" && hasServer);
}

// The old printer program's download folder: only its own job files.
function isOldDownloadsFolder(dir) {
  return listDir(dir).every((e) => e.isFile() && /^job_[a-z0-9]+\.pdf$/i.test(e.name));
}

// A folder like "print-platform" that holds the old website in "server"
// and nothing else but the old version's own files.
function isOldProjectFolder(dir) {
  const entries = listDir(dir);
  if (!entries.some((e) => e.isDirectory() && e.name.toLowerCase() === "server" && isOldServerFolder(path.join(dir, e.name)))) return false;
  const projectFiles = ["readme.md", "how-to.md", "windows.md", "deploy.md", ".gitignore", "build-status.md"];
  return entries.every((e) => {
    const n = e.name.toLowerCase();
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (n === "server") return isOldServerFolder(full);
      if (n === "agent") return exists(path.join(full, "agent.js")) || exists(path.join(full, "agent.js.old"));
      if (n === "windows-scripts") return listDir(full).every((f) => f.isFile() && isOldName(f.name.toLowerCase()));
      return false;
    }
    return isOldName(n) || projectFiles.includes(n);
  });
}

// Never a whole drive (D:\), a user's profile, Desktop, Documents...
function isDriveRoot(dir) {
  const resolved = path.resolve(dir);
  return path.parse(resolved).root === resolved || /^[a-z]:\\?$/i.test(String(dir));
}

function removeReplacedCopies() {
  const record = P.readRecord();
  const folders = record.replacedFolders || [];
  const lines = [];
  for (const folder of folders) {
    if (!isDir(folder) || isDriveRoot(folder) || isSpecialFolder(folder) || offLimits(folder) || inOneDrive(folder)) continue;
    if (!exists(path.join(folder, NOTE_NAME))) continue; // not the folder Setup marked
    let removed = 0;
    for (const entry of listDir(folder)) {
      const n = entry.name.toLowerCase();
      const full = path.join(folder, entry.name);
      let ours = false;
      if (entry.isFile()) {
        // config.json only when it is the old printer program's own
        // (a token and a ws://.../agent address) - it was copied over.
        ours = isOldName(n) || (n === "config.json" && !!readAgentConfig(full));
      } else if (entry.isDirectory()) {
        ours = (n === "source code (not needed to set up)") ||
          (n === "downloads" && isOldDownloadsFolder(full)) ||
          (n === "server" && isOldServerFolder(full)) ||
          isOldProjectFolder(full);
      }
      if (!ours) continue;
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch (err) {
        /* in use or protected: leave it */
      }
    }
    let folderGone = false;
    try {
      if (!listDir(folder).length) { fs.rmdirSync(folder); folderGone = true; }
    } catch (err) {
      /* not empty or in use */
    }
    if (folderGone) lines.push("Removed the older version's folder: " + folder);
    else if (removed) lines.push("Removed the older version's files from " + folder + " (other things in that folder were left alone).");
  }
  return lines.join("\n");
}

// For the installer: a small summary it can read (see main.js).
function summary(old) {
  return {
    found: old.found ? "1" : "0",
    where: old.folders[0] || (old.startup[0] ? old.startup[0].file : old.tasks[0] ? old.tasks[0].name : ""),
    more: String(Math.max(0, old.folders.length - 1)),
    website: old.website ? "1" : "0",
    computers: old.website ? String(old.website.computers) : "0",
    printer: old.printer ? "1" : "0",
    name: old.printer ? old.printer.agentName : "",
    server: old.printer && !pointsHere(old.printer.serverUrl) ? httpFromWs(old.printer.serverUrl) : "",
  };
}

module.exports = { detect, migrate, summary, pathsMentionedIn, removeReplacedCopies };
