// Small helpers for talking to Windows: running PowerShell and other
// commands without any window appearing, opening a web page, and finding
// this computer's network addresses.

const os = require("os");
const { execFile, execFileSync, spawn } = require("child_process");
const P = require("./paths");

function run(command, args, options) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      Object.assign({ timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, options || {}),
      (error, stdout, stderr) => {
        // Some Windows tools answer in UTF-16 when their output is read by
        // another program; for the plain-English text used here, dropping
        // the zero bytes turns that back into ordinary text.
        const clean = (t) => String(t || "").replace(/^\ufeff/, "").replace(/\u0000/g, "");
        resolve({
          ok: !error,
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout: clean(stdout),
          stderr: clean(stderr),
          error,
        });
      }
    );
  });
}

function powershell(script, options) {
  // Without this, PowerShell answers in an older text encoding and names
  // with accents or other alphabets come back garbled.
  const utf8 = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ";
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", utf8 + script],
    options
  );
}

// PowerShell's ConvertTo-Json gives a bare object for one result and an
// array for several; always hand back an array.
function jsonList(text) {
  try {
    const parsed = JSON.parse(String(text || "").trim() || "[]");
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (err) {
    return [];
  }
}

// Who is signed in at the screen right now, and their user number.
// /dev/console belongs to whoever is signed in there; nobody signed in
// leaves it owned by root. macOS only.
function consoleUser() {
  if (!P.IS_MAC) return null;
  try {
    const name = execFileSync("stat", ["-f%Su", "/dev/console"], { timeout: 5000 }).toString().trim();
    if (!name || name === "root") return null;
    const uid = execFileSync("id", ["-u", name], { timeout: 5000 }).toString().trim();
    return /^\d+$/.test(uid) ? { name, uid } : null;
  } catch (err) {
    return null;
  }
}

function openInBrowser(target) {
  try {
    let child;
    if (P.IS_WINDOWS) {
      child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", target], { detached: true, stdio: "ignore" });
    } else if (P.IS_MAC) {
      // The background program runs as root, with no screen of its own, so
      // opening a page has to be done as the person signed in - otherwise
      // nothing appears at all. `launchctl asuser` puts it in their
      // session, which is what makes their browser come to the front.
      const person = process.getuid && process.getuid() === 0 ? consoleUser() : null;
      child = person
        ? spawn("launchctl", ["asuser", person.uid, "sudo", "-u", person.name, "open", target], { detached: true, stdio: "ignore" })
        : spawn("open", [target], { detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
    }
    child.on("error", () => {});
    child.unref();
  } catch (err) {
    /* nothing more to try */
  }
}

// The addresses other devices can use to reach this computer, best first:
// ordinary office ranges (192.168.x, 10.x, 172.16-31.x) before anything
// else, and virtual adapters (VirtualBox, Hyper-V, WSL, VPNs) last.
function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] || []) {
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (entry.internal || entry.address.startsWith("169.254.")) continue;
      const virtual = /virtual|vethernet|vmware|vbox|wsl|hyper-v|loopback|tailscale|zerotier|vpn|docker/i.test(name);
      const office = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address);
      out.push({ address: entry.address, rank: (virtual ? 2 : 0) + (office ? 0 : 1) });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((e) => e.address);
}

module.exports = { run, powershell, jsonList, openInBrowser, lanAddresses, consoleUser };
