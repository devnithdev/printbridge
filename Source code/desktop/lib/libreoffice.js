// LibreOffice: the free office suite the website uses to turn Word, Excel
// and PowerPoint files into PDFs before printing. Only the main computer
// needs it. The installer offers to fetch it; this does the fetching.
//
// It downloads the newest release straight from The Document Foundation
// (the makers of LibreOffice) and installs it quietly. It is told not to
// take over opening Word/Excel/PowerPoint files, so double-clicking a .docx
// still opens whatever it opened before. If the download can't be done,
// Windows' own "winget" installer is tried instead (macOS has no equally
// universal silent-install fallback, so there the website download is the
// only path - see installFromWebsite below).

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { run, powershell, jsonList } = require("./win");
const P = require("./paths");
const progress = require("./progress");

const SITE = process.env.OP_TEST_LO_SITE || "https://download.documentfoundation.org/libreoffice/stable/";
const KNOWN_GOOD_VERSION = "26.8.0"; // used if the list of versions can't be read
const MAC_APP = "/Applications/LibreOffice.app";

function findSoffice() {
  if (process.env.OP_TEST_SOFFICE && fs.existsSync(process.env.OP_TEST_SOFFICE)) return process.env.OP_TEST_SOFFICE;
  if (P.IS_MAC) {
    const candidate = path.join(MAC_APP, "Contents", "MacOS", "soffice");
    return fs.existsSync(candidate) ? candidate : null;
  }
  const places = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter(Boolean);
  for (const base of places) {
    const candidate = path.join(base, "LibreOffice", "program", "soffice.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function get(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, { headers: { "User-Agent": "OfficePrinting-Setup" } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error("Too many redirects."));
        const next = new URL(response.headers.location, url).toString();
        return resolve(get(next, redirectsLeft - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error("The download site answered " + response.statusCode + "."));
      }
      resolve(response);
    });
    request.setTimeout(60000, () => request.destroy(new Error("The download stopped responding.")));
    request.on("error", reject);
  });
}

async function newestVersion() {
  const response = await get(SITE, 5);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const html = Buffer.concat(chunks).toString("utf8");
  const versions = [...html.matchAll(/href="(\d+\.\d+\.\d+)\/"/g)].map((m) => m[1]);
  if (!versions.length) throw new Error("No versions listed.");
  const key = (v) => v.split(".").map((n) => n.padStart(4, "0")).join(".");
  return versions.sort((a, b) => (key(a) < key(b) ? 1 : -1))[0];
}

async function download(url, target) {
  const response = await get(url, 10);
  const total = parseInt(response.headers["content-length"], 10) || 0;
  const mb = (n) => Math.round(n / 1024 / 1024);
  let received = 0;
  let lastShown = -1;
  const out = fs.createWriteStream(target);
  try {
  await new Promise((resolve, reject) => {
    // A download that stops arriving (the connection silently dropped)
    // would otherwise leave Setup waiting for ever.
    if (response.socket) {
      response.socket.setTimeout(90000, () => response.destroy(new Error("The download stopped arriving.")));
    }
    response.on("data", (chunk) => {
      received += chunk.length;
      // The first 85% of the "Installing LibreOffice" step on the wizard's
      // progress bar is this download.
      progress.sub("libreoffice", (total ? received / total : Math.min(received / (320 * 1024 * 1024), 0.99)) * 0.85,
        total ? "Downloading LibreOffice: " + mb(received) + " of " + mb(total) + " MB" : "Downloading LibreOffice: " + mb(received) + " MB");
      const step = total ? Math.floor((received / total) * 10) : Math.floor(received / (50 * 1024 * 1024));
      if (step !== lastShown) {
        lastShown = step;
        progress.log(total ? "Downloaded " + mb(received) + " of " + mb(total) + " MB" : "Downloaded " + mb(received) + " MB");
        console.log(total
          ? "  Downloaded " + mb(received) + " of " + mb(total) + " MB..."
          : "  Downloaded " + mb(received) + " MB...");
      }
    });
    response.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    response.on("aborted", () => reject(new Error("The download was cut short.")));
    response.pipe(out);
  });
  if (total && received < total) throw new Error("The download was cut short.");
  } catch (err) {
    // A part-downloaded installer (up to about 350 MB) isn't left in the
    // temp folder.
    try { response.destroy(); } catch (e) { /* already */ }
    try { out.destroy(); } catch (e) { /* already */ }
    try { fs.rmSync(target, { force: true }); } catch (e) { /* in use: the temp folder gets tidied anyway */ }
    throw err;
  }
}

async function installFromWebsite() {
  let version = KNOWN_GOOD_VERSION;
  progress.sub("libreoffice", 0.01, "Looking for the newest LibreOffice...");
  try {
    version = await newestVersion();
  } catch (err) {
    console.log("  Couldn't read the list of versions (" + err.message + "); trying " + version + ".");
  }
  if (P.IS_MAC) return installFromWebsiteMac(version);

  const url = SITE + version + "/win/x86_64/LibreOffice_" + version + "_Win_x86-64.msi";
  const target = path.join(os.tmpdir(), "LibreOffice_" + version + "_Win_x86-64.msi");

  console.log("  Downloading LibreOffice " + version + " (about 350 MB)...");
  await download(url, target);

  console.log("  Installing LibreOffice. This takes a few minutes...");
  const result = await run(
    "msiexec.exe",
    ["/i", target, "/qn", "/norestart", "ALLUSERS=1", "REGISTER_NO_MSO_TYPES=1",
      "ISCHECKFORPRODUCTUPDATES=0", "QUICKSTART=0", "CREATEDESKTOPLINK=0"],
    { timeout: 45 * 60 * 1000 }
  );
  try {
    fs.rmSync(target, { force: true });
  } catch (err) {
    /* it's in the temp folder anyway */
  }
  // 3010 means "installed, restart needed later" - fine for this.
  if (!result.ok && result.code !== 3010) throw new Error("The LibreOffice installer stopped with code " + result.code + ".");
}

// macOS ships LibreOffice as a disk image containing the app itself, not
// an installer - Finder's normal "drag LibreOffice.app to Applications".
// Done here without Finder: mount the disk image, copy the app to
// /Applications, unmount it again. os.arch() reflects whichever slice of
// this universal program the Mac is actually running - arm64 on Apple
// Silicon, x64 on Intel - and macOS runs the matching build of LibreOffice.
async function installFromWebsiteMac(version) {
  const arch = os.arch() === "arm64" ? "aarch64" : "x86_64";
  const fileArch = os.arch() === "arm64" ? "aarch64" : "x86-64";
  const url = SITE + version + "/mac/" + arch + "/LibreOffice_" + version + "_MacOS_" + fileArch + ".dmg";
  const target = path.join(os.tmpdir(), "LibreOffice_" + version + "_MacOS_" + fileArch + ".dmg");

  console.log("  Downloading LibreOffice " + version + " (about 300 MB)...");
  await download(url, target);

  console.log("  Installing LibreOffice...");
  progress.sub("libreoffice", 0.88, "Opening the LibreOffice download...");
  const attach = await run("hdiutil", ["attach", "-nobrowse", "-noautoopen", "-readonly", target], { timeout: 5 * 60 * 1000 });
  try {
    if (!attach.ok) throw new Error("Couldn't open the LibreOffice disk image (" + (attach.stderr || "hdiutil didn't run").trim().slice(0, 200) + ").");
    const lines = attach.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const mountLine = lines.pop() || "";
    const mount = (mountLine.match(/(\/Volumes\/.+)$/) || [])[1];
    // The device node (e.g. "/dev/disk4") is the first column of every
    // line hdiutil prints for a successful attach, mount point or not -
    // it's what's actually used below to detach again, so a disk image
    // that DID mount but whose /Volumes line this couldn't parse still
    // gets unmounted instead of being left attached indefinitely (the
    // previous version threw before ever reaching detach in that case).
    const device = (mountLine.match(/^(\/dev\/disk\d+)/) || (lines[0] || "").match(/^(\/dev\/disk\d+)/) || [])[1];
    try {
      if (!mount) throw new Error("Couldn't find where the LibreOffice disk image was mounted.");
      const source = path.join(mount, "LibreOffice.app");
      if (!fs.existsSync(source)) throw new Error("The disk image didn't contain LibreOffice.app.");
      try { fs.rmSync(MAC_APP, { recursive: true, force: true }); } catch (err) { /* nothing to remove */ }
      progress.sub("libreoffice", 0.92, "Copying LibreOffice into Applications (about a minute)...");
      const copy = await run("cp", ["-R", source, MAC_APP], { timeout: 5 * 60 * 1000 });
      if (!copy.ok) throw new Error("Couldn't copy LibreOffice to Applications (" + (copy.stderr || "cp didn't run").trim().slice(0, 200) + ").");
      // Not needed for a program this only opens from the command line (no
      // Finder/Gatekeeper "opened from the internet" prompt applies there),
      // but harmless to clear in case a future step opens it another way.
      try { await run("xattr", ["-dr", "com.apple.quarantine", MAC_APP]); } catch (err) { /* best effort */ }
    } finally {
      if (mount) await run("hdiutil", ["detach", mount, "-quiet"], { timeout: 60000 });
      else if (device) await run("hdiutil", ["detach", device, "-quiet", "-force"], { timeout: 60000 });
    }
  } finally {
    try { fs.rmSync(target, { force: true }); } catch (err) { /* it's in the temp folder anyway */ }
  }
}

async function installWithWinget() {
  console.log("  Trying Windows' own installer (winget) instead...");
  const result = await run(
    "winget.exe",
    ["install", "--id", "TheDocumentFoundation.LibreOffice", "-e", "--silent",
      "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
    { timeout: 45 * 60 * 1000 }
  );
  if (!result.ok) throw new Error("winget could not install it (code " + result.code + ").");
}

// Is some LibreOffice installed anywhere, even outside the standard
// location? Then Setup leaves it alone (and never removes it).
async function installedElsewhere() {
  if (P.IS_MAC) {
    // Spotlight's own search tool - the closest macOS equivalent of asking
    // Windows' uninstall registry "is LibreOffice installed anywhere?".
    // Skipped quietly if Spotlight is switched off for the disk (mdfind
    // then answers nothing rather than erroring in a way worth surfacing).
    // Passed as its own argv entry (not through a shell), so the query
    // itself must use double quotes - mdfind's query parser treats a
    // single-quoted string as literal text to search for, not a value to
    // compare against, and so never matches anything this way.
    const r = await run("mdfind", ['kMDItemCFBundleIdentifier == "org.libreoffice.script"'], { timeout: 30000 });
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length > 0;
  }
  if (!P.IS_WINDOWS) return false;
  const script = [
    "Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue |",
    "Get-ItemProperty | Where-Object { $_.DisplayName -match '^LibreOffice [0-9]' } | Measure-Object | Select-Object -ExpandProperty Count",
  ].join(" ");
  const r = await powershell(script, { timeout: 60000 });
  return parseInt(r.stdout.trim(), 10) > 0;
}

async function install() {
  if (findSoffice() || (await installedElsewhere())) {
    console.log("LibreOffice is already installed.");
    return true;
  }
  console.log("Installing LibreOffice (for printing Word, Excel and PowerPoint files)...");
  try {
    await installFromWebsite();
  } catch (err) {
    console.log("  " + err.message);
    if (P.IS_WINDOWS) {
      try {
        await installWithWinget();
      } catch (err2) {
        console.log("  " + err2.message);
      }
    }
  }
  if (findSoffice()) {
    // Remembered, so uninstalling removes it again - but only because it
    // was Setup that put it there.
    P.updateRecord({ libreofficeBySetup: true });
    console.log("LibreOffice is installed.");
    return true;
  }
  console.log("LibreOffice could NOT be installed now (is the internet working?).");
  console.log("PDFs will still print. To add it later, run this setup again,");
  console.log("or install it from https://www.libreoffice.org/download/");
  return false;
}

// Uninstalling: removes LibreOffice only if this program's Setup installed
// it. If it was on the computer before, it is left alone.
async function removeIfInstalledBySetup() {
  if (!P.readRecord().libreofficeBySetup) return "";
  if (!findSoffice()) return "";
  if (P.IS_MAC) {
    console.log("Removing LibreOffice (Setup installed it for printing Word and Excel files)...");
    try {
      fs.rmSync(MAC_APP, { recursive: true, force: true });
    } catch (err) {
      return "LibreOffice couldn't be removed (" + err.message + "). Remove it from the Applications folder if it is no longer wanted.";
    }
    return findSoffice() ? "LibreOffice is still there; remove it from the Applications folder if it is no longer wanted." : "Removed LibreOffice.";
  }
  if (!P.IS_WINDOWS) return "";
  console.log("Removing LibreOffice (Setup installed it for printing Word and Excel files). This takes a minute or two...");
  // The main LibreOffice entry only, e.g. "LibreOffice 26.8.0.2" - not a
  // help or language pack someone may have added.
  const script =
    "Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', " +
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | " +
    "Get-ItemProperty | Where-Object { $_.DisplayName -match '^LibreOffice [0-9]' -and $_.DisplayName -notmatch 'Help Pack|Language Pack' -and $_.PSChildName -match '^\\{.+\\}$' } | " +
    "ForEach-Object { $_.PSChildName } | ConvertTo-Json -Compress";
  const codes = jsonList((await powershell(script, { timeout: 60000 })).stdout);
  if (!codes.length) return "LibreOffice's uninstall entry wasn't found; remove it from Settings > Apps if it is no longer wanted.";
  for (const code of codes) {
    const r = await run("msiexec.exe", ["/x", String(code), "/qn", "/norestart"], { timeout: 30 * 60 * 1000 });
    if (!r.ok && r.code !== 3010 && r.code !== 1605) {
      return "LibreOffice couldn't be removed (code " + r.code + "). Remove it from Settings > Apps if it is no longer wanted.";
    }
  }
  return findSoffice() ? "LibreOffice is still there; remove it from Settings > Apps if it is no longer wanted." : "Removed LibreOffice.";
}

module.exports = { install, findSoffice, newestVersion, removeIfInstalledBySetup };
