// Starting and stopping the background program.

const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const P = require("./paths");
const { run } = require("./win");
const { isRunning, ask } = require("./supervisor");

// Start the background program, separate from whatever started this one.
function startInBackground() {
  const child = spawn(process.execPath, [P.ENTRY, "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Whether the note the background program leaves behind was written since
// this computer last started. Process numbers are reused after a restart,
// so a note left by the copy running before a power cut can name numbers
// that now belong to something else entirely - and stopping "it" would
// then terminate whatever unrelated program inherited the number. The
// note is only worth acting on if it can't predate this boot.
function statusIsFromThisBoot(status) {
  const written = status && (status.updatedAt || status.startedAt);
  if (!written) return false;
  const bootedAt = Date.now() - os.uptime() * 1000;
  return written >= bootedAt;
}

// Stop every running copy of Office Printing except this one.
async function stopRunning() {
  // First the exact programs the background program wrote down - but only
  // while it is actually running, and only when the note is from this boot
  // (see above). Stopping it first means nothing is left to restart the
  // others; anything the note misses is caught by name below.
  for (const [file, port] of [[P.STATUS_FILE, P.LOCK_PORT], [P.SIGNIN_STATUS_FILE, P.OUTBOX_LOCK_PORT]]) {
    const status = P.readJson(file);
    if (status && status.pid && statusIsFromThisBoot(status) && (await isRunning(port))) {
      const pids = [status.pid, ...Object.values(status.parts || {}).map((p) => p.pid)]
        .filter((pid) => pid && pid !== process.pid);
      for (const pid of pids) {
        // Parts running as Windows' own system account (the startup task)
        // can only be stopped by an administrator; for anyone else this
        // simply fails, and "restart" asks them to restart instead.
        try { process.kill(pid); } catch (err) { /* already gone, or not ours to stop */ }
        if (pid === status.pid) await wait(500);
      }
    }
  }
  // Then, on Windows, anything else by the same name (for example a copy
  // started by another person signed in to this computer).
  if (P.IS_WINDOWS && P.IS_PACKAGED) {
    const image = require("path").basename(process.execPath);
    await run("taskkill.exe", ["/F", "/FI", "IMAGENAME eq " + image, "/FI", "PID ne " + process.pid]);
  }
  for (let i = 0; i < 20 && ((await isRunning()) || (await isRunning(P.OUTBOX_LOCK_PORT))); i++) await wait(500);
  return !(await isRunning()) && !(await isRunning(P.OUTBOX_LOCK_PORT));
}

async function restart() {
  // On macOS the background program belongs to launchd (a LaunchDaemon that
  // runs as root). Stopping it and then starting a loose copy by hand would
  // leave launchd's own job "exited" and the new copy outside its care, so
  // ask launchd itself to restart it. Falls back to the old way if the job
  // isn't loaded (for example the very first start after an install).
  if (P.IS_MAC && typeof process.getuid === "function" && process.getuid() === 0) {
    const label = "system/com.printbridge.service";
    const r = await run("launchctl", ["kickstart", "-k", label]);
    if (r.ok) return;
    // Not loaded yet (a first install where "Close without starting" was
    // chosen): load it, which also starts it.
    const plist = "/Library/LaunchDaemons/com.printbridge.service.plist";
    if (fs.existsSync(plist)) {
      const b = await run("launchctl", ["bootstrap", "system", plist]);
      if (b.ok) return;
    }
  }
  // On Windows the background parts may run as the startup task, under
  // Windows' own system account, which someone signed in can't stop - so
  // each running group is asked to restart its own parts. Anything that
  // isn't running (or is an older version that doesn't understand being
  // asked) is started or restarted the old way.
  if (P.IS_WINDOWS) {
    const core = await ask(P.LOCK_PORT, "restart-parts");
    const signin = await ask(P.OUTBOX_LOCK_PORT, "restart-parts");
    if (core === "ok") {
      if (signin !== "ok") startInBackground();
      return;
    }
  }
  await stopRunning();
  startInBackground();
}

module.exports = { startInBackground, stopRunning, restart };
