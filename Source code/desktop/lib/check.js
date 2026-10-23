// "Check PrintBridge" in the Start menu: a plain-English page that
// says whether everything on this computer is working and, if not, exactly
// what to do. It opens in the web browser. It only looks; the one thing it
// does is start it if it wasn't running.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const P = require("./paths");
const B = require("./brand");
const T = require("../../agent/lib/theme");
const { run, lanAddresses, openInBrowser } = require("./win");
const { isRunning } = require("./supervisor");
const { findSoffice } = require("./libreoffice");
const { VERSION } = require("./version");

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs || 3000 }, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => {
        try {
          resolve(response.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null);
        } catch (err) {
          resolve(null);
        }
      });
      // Cut off half-way (timed out mid-answer): settle rather than leave
      // the check waiting for ever and never showing its page.
      response.on("error", () => resolve(null));
      response.on("aborted", () => resolve(null));
      response.on("close", () => resolve(null));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

async function sleepMinutes() {
  if (!P.IS_WINDOWS) return null;
  const out = {};
  for (const [label, setting] of [["sleep", "STANDBYIDLE"], ["hibernate", "HIBERNATEIDLE"]]) {
    const r = await run("powercfg.exe", ["/query", "SCHEME_CURRENT", "SUB_SLEEP", setting]);
    const values = (r.stdout.match(/0x[0-9a-f]{8}/gi) || []).slice(-2).map((h) => parseInt(h, 16));
    if (values.length === 2) out[label] = values; // [plugged in, on battery], in seconds
  }
  return out;
}

// The mac equivalent: "Currently in use" is whichever power source is
// active right now (so, on a laptop, this reflects battery settings while
// unplugged) - close enough to Windows' "plugged in or on battery" pair
// for the one-line verdict this feeds into.
async function macSleepStatus() {
  if (!P.IS_MAC) return null;
  const r = await run("pmset", ["-g"]);
  const section = r.stdout.split(/Currently in use:/i)[1] || "";
  const value = (name) => {
    const m = section.match(new RegExp("^\\s*" + name + "\\s+(\\d+)", "m"));
    return m ? parseInt(m[1], 10) : null;
  };
  const sleep = value("sleep");
  const disablesleep = value("disablesleep");
  if (sleep == null) return null;
  return { sleepSeconds: sleep * 60, disablesleep: disablesleep === 1 };
}

async function firewallRuleExists() {
  if (P.IS_MAC) {
    const socketfilterfw = "/usr/libexec/ApplicationFirewall/socketfilterfw";
    const state = await run(socketfilterfw, ["--getglobalstate"]);
    if (!/enabled/i.test(state.stdout)) return true; // switched off - nothing to be blocked by
    const apps = await run(socketfilterfw, ["--listapps"]);
    return apps.stdout.toLowerCase().includes(String(P.INSTALL_DIR).toLowerCase())
      || apps.stdout.toLowerCase().includes(B.NAME.toLowerCase());
  }
  if (!P.IS_WINDOWS) return true;
  const r = await run("netsh.exe", ["advfirewall", "firewall", "show", "rule", "name=Office Printing"]);
  return r.ok;
}

function lastLines(file, count) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-count).join("\n");
  } catch (err) {
    return "(nothing yet)";
  }
}

function minutes(seconds) {
  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

// Windows Setup can simply be run again to change anything; macOS has no
// separate Setup program to re-run once it's installed - there's a
// "Reconfigure PrintBridge" item instead (see installer-mac/postinstall
// and setup-web.js). Two forms, for the two places this reads in a sentence.
const runSetupAgain = P.IS_MAC ? `open "Reconfigure ${B.NAME}" (in the Applications folder)` : `run ${B.NAME} Setup again`;
const RunSetupAgain = P.IS_MAC ? `Open "Reconfigure ${B.NAME}" (in the Applications folder)` : `Run ${B.NAME} Setup again`;
// Where the shortcuts to open/check/restart it live.
const whereShortcuts = P.IS_MAC ? `the "${B.NAME}" folder in Applications` : "the Start menu";

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return "just now";
  if (m < 120) return m + " minutes ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + " hours ago";
  return Math.round(h / 24) + " days ago";
}

// Automatic updates (see updater.js): what happened last, in one row.
function updatesRow(add) {
  let r;
  try { r = require("./updater").report(); } catch (err) { return; }
  const { state, result } = r;
  const newer = (v) => v && require("./updater").compareVersions(v, VERSION) > 0;
  if (r.off === "no-key") {
    add(null, "Automatic updates aren't set up in this version", `To update, run the newest ${esc(B.NAME)} Setup on this computer.`);
    return;
  }
  if (r.off === "switched-off") {
    add(null, "Automatic updates are switched off on this computer",
      "To switch them back on, delete update-settings.json in " + esc(P.DATA_DIR) + ".");
    return;
  }
  if (r.off === "not-system" || (P.IS_WINDOWS && !P.readRecord().startupTask)) {
    add(false, "This computer can't update itself",
      P.IS_WINDOWS ? `Updates are installed by the startup task, which is missing. Run ${esc(B.NAME)} Setup again to fix this.`
        : `Restart ${esc(B.NAME)} from ${whereShortcuts}.`);
    return;
  }
  if (r.installing || state.status === "installing") {
    add(null, "A new version is being installed", "This takes a few minutes. Printing carries on by itself afterwards.");
    return;
  }
  if (result && result.version && !result.ok && newer(result.version) && Date.now() - (result.at || 0) < 7 * 24 * 3600 * 1000) {
    const gaveUp = result.failures && result.failures.count >= 3;
    add(false, "Version " + esc(result.version) + " couldn't be installed automatically",
      esc(result.message || "") + " " + (gaveUp
        ? `It won't try this version again by itself: run the newest ${esc(B.NAME)} Setup on this computer, or choose "Update ${esc(B.NAME)} now".`
        : "It tries again by itself in a day."));
    return;
  }
  if (result && result.ok && result.version === VERSION && Date.now() - (result.at || 0) < 7 * 24 * 3600 * 1000) {
    add(true, "Updated to version " + esc(VERSION) + " automatically", esc(new Date(result.at).toLocaleString()) + ".");
    return;
  }
  const latest = state.latest && state.latest.version;
  if (newer(latest)) {
    const why = {
      "waiting-turn": "It installs by itself within the next half hour.",
      downloading: "It is being downloaded.",
      "download-failed": "Downloading it didn't work (" + esc(state.lastError || "") + "); it tries again in half an hour.",
      "waiting-quiet": "It installs as soon as nothing is printing here (" + esc(state.waitingFor || "") + ").",
      paused: "It has been paused by whoever publishes updates.",
      manual: `It can't be installed automatically from this version: run the newest ${esc(B.NAME)} Setup on this computer.`,
      "no-file": "There is no installer for this kind of computer in it.",
      "retry-later": "An earlier try didn't work; it tries again by itself.",
      "gave-up": `Earlier tries didn't work: run the newest ${esc(B.NAME)} Setup on this computer.`,
    }[state.status] || "It installs by itself.";
    add(null, "Version " + esc(latest) + " is available (this is " + esc(VERSION) + ")", why);
    return;
  }
  if (!state.lastCheckAt) {
    add(true, "Automatic updates are on", "This is version " + esc(VERSION) + ". It looks for new versions a few minutes after starting, then every few hours.");
    return;
  }
  if (!state.lastCheckOk && (!state.lastSuccessAt || Date.now() - state.lastSuccessAt > 3 * 24 * 3600 * 1000)) {
    add(false, "Couldn't check for updates" + (state.lastSuccessAt ? " since " + esc(ago(state.lastSuccessAt)) : ""),
      esc(state.lastError || "") + ". This computer needs the internet to update itself; printing works without it.");
    return;
  }
  add(true, "Up to date (version " + esc(VERSION) + ")", "Checked " + esc(ago(state.lastSuccessAt || state.lastCheckAt)) + `. New versions install by themselves.`);
}

async function gather(startIfStopped) {
  const settings = P.readSettings();
  const rows = []; // { ok: true|false|null, title, detail }
  const add = (ok, title, detail) => rows.push({ ok, title, detail: detail || "" });

  let running = await isRunning();
  let justStarted = false;
  // On macOS the real program is a LaunchDaemon and runs as root; "Check
  // PrintBridge.command" itself runs as whoever double-clicked it. Started
  // directly here (a plain spawn, not through launchd), it would come up
  // as that person instead - unable to write the root-owned data folder -
  // leaving a second, broken copy fighting the real one for the same port
  // once it eventually comes back. So this only starts it itself when it
  // can start it correctly: on Windows always, on macOS only when this is
  // already running as root (which "check" never is when launched from the
  // menu). Otherwise it just says which menu item does start it properly.
  const canStartHere = !P.IS_MAC || (typeof process.getuid === "function" && process.getuid() === 0);
  if (!running && startIfStopped && canStartHere) {
    const { startInBackground } = require("./control");
    startInBackground();
    await new Promise((resolve) => setTimeout(resolve, 8000));
    running = await isRunning();
    justStarted = running;
  }
  if (running) {
    add(true, justStarted ? `${B.NAME} wasn't running, so it has just been started` : `${B.NAME} is running`);
  } else {
    add(false, `${B.NAME} is not running`,
      P.IS_MAC
        ? `Open ${whereShortcuts} and choose "Restart ${B.NAME}" (it will ask for an administrator password). If this keeps happening, restart the computer.`
        : `Open the Start menu, find ${B.NAME} and choose "Restart ${B.NAME}". ` +
          "If this keeps happening, restart the computer.");
  }

  // Windows: the startup task that brings printing back after a power cut
  // with nobody signed in (see service.js). Not used on a computer that
  // only prints.
  if (P.IS_WINDOWS && settings.role !== "client") {
    // (A computer that only prints has the task too, since 4.1.3, but only
    // for automatic updates - the updates row below covers it.)
    // Setup notes it down when it adds the task; asking Task Scheduler as well
    // covers a record that is missing (someone signed in without administrator
    // rights may not be allowed to ask, so the note comes first).
    const task = !!P.readRecord().startupTask || (await require("./service").exists());
    add(task, task ? `${B.NAME} starts by itself when Windows starts` : `${B.NAME} only starts when someone signs in`,
      task ? "Even after a power cut, with nobody signed in." :
        `After a power cut, printing stays off until someone signs in to this computer. Run ${B.NAME} Setup again to fix this.`);
  }

  updatesRow(add);

  // This computer used to be the main computer, until another one was made
  // "the only main computer" (see applyStepDown in supervisor.js).
  const steppedDown = P.readRecord().steppedDown;
  if (steppedDown && settings.role !== "main") {
    add(true, "This computer is no longer the main computer",
      esc((steppedDown.byName || "Another computer") + (steppedDown.address ? " (" + steppedDown.address + ")" : "")) +
        " was made the only main computer on " + esc(new Date(steppedDown.at || Date.now()).toLocaleString()) +
        ", so this one now shares its printers through it. To make this the main computer again, " + runSetupAgain +
        ", choose the main computer and tick \"Make this the only main computer\".");
  }

  if (settings.role === "main") {
    const about = await getJson("http://localhost:" + P.PORT + "/api/office-printing", 4000);
    // Any other main computer still answering on this network?
    if (about) {
      try {
        const others = (await require("../../agent/lib/find").askNetwork({ waitMs: 2000 })).filter((f) => f.id && f.id !== about.id);
        if (!others.length) {
          if (about.claimAt) add(true, "This is the only main computer on this network", "Any other main computer that is switched on later switches over to this one by itself.");
        } else {
          const names = others.map((f) => esc((f.name || "A main computer") + " (" + f.httpBase + ")")).join(", ");
          const old = others.filter((f) => !f.canStepDown);
          add(false, others.length === 1 ? "Another main computer is running on this network" : others.length + " other main computers are running on this network",
            names + ". The office's printers are split between their printing pages. " +
            (about.claimAt
              ? (old.length ? "Older versions can't switch over by themselves: run Setup on them and choose \"shares a printer\", or uninstall " + esc(B.NAME) + " there. Newer ones switch over within a minute." : "They switch over to this one within a minute.")
              : "To make this the only one, " + runSetupAgain + " and tick \"Make this the only main computer\"."));
        }
      } catch (err) { /* the other rows still stand */ }
    }
    const addresses = lanAddresses();
    if (about) {
      add(true, "The printing website is working",
        addresses.length
          ? "People print by opening <b>" + addresses.map((a) => esc("http://" + a + ":" + P.PORT)).join("</b> or <b>") + "</b>" +
            (addresses.length > 1 ? " (use the first one unless it doesn't work)." : ".") +
            " <a href=\"http://localhost:" + P.PORT + "/poster.html\">Print the sign for the wall</a>."
          : "This computer isn't connected to a network right now, so nobody else can reach it.");
    } else {
      add(false, "The printing website isn't answering",
        justStarted ? "It was only just started - wait a minute and check again." :
          `Choose "Restart ${B.NAME}" from ${whereShortcuts}. If that doesn't help, restart the computer.`);
    }
    // "Keep this computer's address the same" (see fixip.js).
    try {
      const net = await require("./fixip").detect();
      if (net.found && !net.dhcp) {
        add(true, "This computer's address is fixed at " + esc(net.address), "So the wall sign's address keeps working after a power cut or a router restart.");
      } else if (net.found) {
        add(null, "This computer's address can change",
          "The router chose " + esc(net.address) + " and may give it a different one after a power cut or a router restart. Other computers find it again by themselves, but the wall sign would show the old address. " +
          "To stop this, " + runSetupAgain + " and tick \"Give this computer a fixed address\" - or reserve its address in the router.");
      }
    } catch (err) { /* the other rows still stand */ }
    const soffice = findSoffice();
    add(!!soffice, soffice ? "Word, Excel and PowerPoint files and photos can be printed" : "Word, Excel and PowerPoint files and photos can't be printed yet",
      soffice ? "" : P.IS_MAC
        ? `PDFs print fine. For the others, ${runSetupAgain} and choose to install LibreOffice ` +
          "(it needs the internet), or install it yourself from libreoffice.org."
        : `PDFs print fine. For the others, run ${B.NAME} Setup again and tick ` +
          "\"Also install LibreOffice\" (it needs the internet), or install LibreOffice from libreoffice.org.");
    const fw = await firewallRuleExists();
    const fwName = P.IS_MAC ? "the Firewall" : "Windows Firewall";
    add(fw, fw ? `Other devices are allowed through ${fwName}` : `${fwName} may be blocking other devices`,
      fw ? "" : P.IS_MAC
        ? `Open System Settings, then Network, then Firewall Options, and allow incoming connections for ${B.NAME}.`
        : `Run ${B.NAME} Setup again to fix this.`);
  }

  if (settings.role === "client") {
    const website = await require("./outbox").findWebsite(true);
    add(!!website, website ? "The printing website was found" : "The printing website can't be found",
      website ? "At <b>" + esc(website) + "</b>. Printouts open there." :
        "Make sure the main computer is switched on and this computer is on the same Wi-Fi or network. " +
        `If it still can't be found, ${runSetupAgain} and type in the address from the wall sign.`);
  }

  if (P.IS_WINDOWS || P.IS_MAC) {
    const hasPrinter = await require("./vprinter").exists();
    add(hasPrinter,
      hasPrinter ? `The "${B.NAME}" printer is ready` : `The "${B.NAME}" printer is missing`,
      hasPrinter ? "Choose it in the Print window of Excel, Word or any other program. The print page then opens with a preview." :
        `${RunSetupAgain} to add it back.`);
  }

  const agent = settings.role === "client" ? { state: "none" } : P.readJson(path.join(P.PRINTER_DIR, "status.json"));
  if (agent && agent.state === "none") {
    // a computer that only prints shares no printers
  } else if (!agent) {
    // Only "starting" while the program actually runs; when it doesn't, the
    // first row already says so and what to do.
    if (running) add(null, "Printer sharing is starting", "Check again in a minute.");
  } else if (agent.state === "connected") {
    const names = agent.printers || [];
    add(true, "This computer is connected to the printing website as \"" + esc(agent.agentName) + "\"",
      esc(agent.website || ""));
    const wherePrintersAreAdded = P.IS_MAC ? "System Settings, then Printers &amp; Scanners" : "Windows (Settings, then Printers &amp; scanners)";
    add(names.length > 0,
      names.length ? "Printers shared from this computer: " + names.map(esc).join(", ") : "No printers were found on this computer",
      names.length ? "" : settings.role === "main"
        ? "That's fine if printers are shared from other computers. To share one from here, install it in " +
          wherePrintersAreAdded + ". It shows up within 5 minutes."
        : "Install the printer in " + wherePrintersAreAdded + " and print a test page. " +
          "It shows up here within 5 minutes.");
  } else {
    const fix = agent.state === "searching"
      ? "Make sure the main computer is switched on and this computer is on the same Wi-Fi or network. " +
        `It keeps looking by itself. If it still can't find it, ${runSetupAgain} and type in ` +
        "the address from the wall sign."
      : "It keeps trying by itself. If this doesn't clear up, make sure the main computer is on, then choose " +
        `"Restart ${B.NAME}" from ${whereShortcuts}.`;
    add(false, esc(agent.message || "Not connected to the printing website yet"), fix);
  }

  // Only computers other people print through must stay awake.
  if (settings.role !== "client") {
    const power = await sleepMinutes();
    if (power && power.sleep) {
      const [ac, dc] = power.sleep;
      const [hac, hdc] = power.hibernate || [0, 0];
      const ok = ac === 0 && dc === 0 && hac === 0 && hdc === 0;
      add(ok, ok ? "This computer won't go to sleep by itself" : "This computer may go to sleep and stop printing",
        ok ? "" : "It is set to sleep after " + minutes(Math.min(...[ac, dc, hac, hdc].filter((v) => v > 0))) +
          `. Run ${B.NAME} Setup again to fix this.`);
    } else if (power) {
      // Windows wouldn't say. Leaving the row out altogether would let this
      // page report that everything is working on a main computer that is
      // in fact set to go to sleep and stop printing for the whole office -
      // the one thing here that shouldn't fail quietly.
      add(null, "This computer's sleep settings couldn't be read",
        "Windows didn't answer, usually because security software blocked it. Check in Settings, then System, then Power, that this computer is set never to sleep.");
    }
    const macPower = await macSleepStatus();
    if (macPower) {
      const ok = macPower.sleepSeconds === 0 || macPower.disablesleep;
      add(ok, ok ? "This computer won't go to sleep by itself" : "This computer may go to sleep and stop printing",
        ok ? "" : "It is set to sleep after " + minutes(macPower.sleepSeconds) +
          `. ${RunSetupAgain} to fix this.`);
    }
  }

  return { settings, rows };
}

function page(report) {
  const { settings, rows } = report;
  const problems = rows.filter((r) => r.ok === false).length;
  const icon = (ok) => (ok === true ? "&#10003;" : ok === false ? "!" : "&hellip;");
  const logs = ["office-printing", "website", "printer", "printouts"]
    .concat(["updates"])
    .filter((n) => (settings.role === "main" || n !== "website") && (settings.role !== "client" || n !== "printer"))
    .map((n) => "<h3>" + n + ".log</h3><pre>" + esc(lastLines(path.join(P.LOG_DIR, n + ".log"), 25)) + "</pre>")
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${B.NAME} check</title>
${T.head()}
<style>
${T.CSS}
:root { --brand:${B.PRIMARY}; --accent:${B.ACCENT}; }
:root[data-theme="dark"] h1 { color:var(--brand-text); }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 "Segoe UI", system-ui, sans-serif; padding:32px 16px; }
@media (max-width: 600px) { body { padding-top:64px; } } /* clear of the round theme button */
main { max-width:720px; margin:0 auto; }
h1 { font-size:26px; margin:0 0 4px; color:var(--brand); }
.bar { height:5px; background:linear-gradient(90deg, var(--brand) 0 80%, var(--accent) 80%); border-radius:3px; margin:0 0 20px; }
.sub { color:var(--soft); margin:0 0 24px; }
.verdict { font-size:20px; font-weight:600; margin:0 0 16px; }
.verdict.good { color:var(--ok); } .verdict.bad { color:var(--bad); }
ul { list-style:none; margin:0; padding:0; background:var(--card); border:1px solid var(--line); border-radius:12px; }
li { display:flex; gap:14px; padding:14px 18px; border-top:1px solid var(--line); }
li:first-child { border-top:none; }
.i { flex:none; width:28px; height:28px; border-radius:50%; display:grid; place-items:center; font-weight:700; border:2px solid currentColor; }
.ok .i { color:var(--ok); } .bad .i { color:var(--bad); } .wait .i { color:var(--soft); }
.t { font-weight:600; } .d { color:var(--soft); font-size:15px; margin-top:2px; }
a { color:inherit; }
details { margin-top:28px; } summary { cursor:pointer; color:var(--soft); }
pre { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; font-size:12px; overflow:auto; white-space:pre-wrap; }
h3 { font-size:14px; margin:18px 0 6px; }
</style></head><body>${T.button()}<main>
<div class="bar"></div>
<h1>${B.NAME}</h1>
<p class="sub">${esc({ main: "Main computer", printer: "Printer computer", client: "Computer that only prints" }[settings.role])} &middot; ${esc(os.hostname())} &middot; checked ${esc(new Date().toLocaleString())}</p>
<p class="verdict ${problems ? "bad" : "good"}">${problems ? (problems === 1 ? "One thing needs attention" : problems + " things need attention") : "Everything is working"}</p>
<ul>
${rows.map((r) => `<li class="${r.ok === true ? "ok" : r.ok === false ? "bad" : "wait"}"><span class="i">${icon(r.ok)}</span><div><div class="t">${r.title}</div>${r.detail ? `<div class="d">${r.detail}</div>` : ""}</div></li>`).join("\n")}
</ul>
<details><summary>Details for whoever looks after this</summary>
<p>Settings and logs are in ${esc(P.DATA_DIR)}. Version ${esc(VERSION)}. Updates: ${esc(require("./updater").updateDir())} (updates.log).</p>
${logs}
</details>
<p style="color:var(--soft);font-size:13px;margin-top:22px">${esc(B.NAME)} &middot; ${B.CREDIT_HTML}</p>
</main></body></html>`;
}

async function runCheck(options) {
  const report = await gather(!(options && options.noStart));
  const file = path.join(os.tmpdir(), "office-printing-check.html");
  fs.writeFileSync(file, page(report));
  if (!(options && options.noOpen)) openInBrowser(file);
  return { file, report };
}

module.exports = { runCheck };
