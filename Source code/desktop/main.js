// PrintBridge (internally "Office Printing") - the one program installed on every computer.
//
// OfficePrinting.exe does different jobs depending on how it is started:
//
//   (nothing) or start   the background program: runs the website and/or
//                        printer sharing, and keeps them running (on
//                        Windows: started at sign-in; runs the printouts
//                        part, and the rest only if the startup task isn't)
//   service              Windows: the same, started by the startup task when
//                        Windows starts (website and printer sharing)
//   website / printer /  one of those parts (started by the background program)
//   outbox
//   open                 opens the printing page in the web browser
//   check                opens a plain-English "is everything working?" page
//   restart / stop       restarts or stops the background program
//   update-now           asks the background program to look for a new
//                        version now (and install it if there is one)
//
// and, used only by the installer:
//   configure <file>     saves the choices made in the installer
//   find-server <ini>    looks for the printing website on the network
//   detect-old <ini>     looks for an older setup on this computer (Windows)
//   replace-old <role>   moves an older setup over and switches it off (Windows)
//   network-info <ini>   this computer's network connection, and a free
//                        address to suggest for "keep this computer's
//                        address the same" (see lib/fixip.js)
//   fix-address on [address] | off
//                        gives this computer a fixed network address, or
//                        makes it automatic again (only one Setup fixed)
//   install-libreoffice  downloads and installs LibreOffice
//   add-printer          adds the "PrintBridge" printer
//   install-service      Windows: adds the startup task (see lib/service.js)
//   remove-service       Windows: removes it
//   start-service        Windows: starts it now
//   status <ini>         facts for the installer's last page (Windows)
//   setup-wizard         the macOS setup wizard (asks what Windows Setup's
//                        own pages ask, since the .pkg installer can't draw
//                        custom pages); runs until finished, then returns
//   finish-install       macOS only: offers the wizard above if someone is
//                        signed in to answer it, otherwise applies the
//                        recommended settings; called once by Setup
//
//   start-signed-in      Windows: starts the sign-in part for everyone
//                        signed in (after a silent update - see service.js)
//
// and by automatic updates (see lib/updater.js):
//   apply-update <dir>   the update runner: installs the downloaded version,
//                        checks it starts, puts the previous one back if not
//
// and by the uninstaller:
//   before-uninstall     removes the printer, LibreOffice (if Setup added
//                        it) and old files; tells the main computer goodbye

const fs = require("fs");
const path = require("path");

const P = require("./lib/paths");

const command = String(process.argv[2] || "start").toLowerCase();
const arg = process.argv[3] || "";

// The installer reads answers with Windows' own INI reader, which handles
// Unicode only in UTF-16 files - so names in any language survive.
function writeIni(file, section, values) {
  const lines = ["[" + section + "]"];
  for (const [key, value] of Object.entries(values)) {
    lines.push(key + "=" + String(value == null ? "" : value).replace(/[\r\n]+/g, " "));
  }
  const text = "﻿" + lines.join("\r\n") + "\r\n";
  fs.writeFileSync(file, Buffer.from(text, "utf16le"));
}

// The installer writes its choices as a UTF-16 text file of key=value lines.
function readChoices(file) {
  const raw = fs.readFileSync(file);
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.slice(2).toString("utf16le") : raw.toString("utf8").replace(/^﻿/, "");
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z]+)=(.*)$/i.exec(line.trim());
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

async function main() {
  switch (command) {
    case "start":
    case "service": {
      // Awaited and caught: this program has no window, so a problem while
      // starting would otherwise vanish without a trace (and, before the
      // background program's own handler is in place, stop it for good).
      try {
        await require("./lib/supervisor").start(command === "service" ? "service" : undefined);
      } catch (err) {
        try { require("./lib/log").logger("office-printing").line("Couldn't start: " + (err && err.stack ? err.stack : err)); } catch (e) { /* nowhere to say it */ }
        process.exitCode = 1;
      }
      return;
    }

    case "website": {
      // If the background program goes away, go with it.
      process.on("disconnect", () => process.exit(0));
      require("../server/server.js");
      return;
    }

    case "printer": {
      process.on("disconnect", () => process.exit(0));
      require("../agent/agent.js").startManaged();
      return;
    }

    case "outbox": {
      process.on("disconnect", () => process.exit(0));
      require("./lib/outbox").start();
      return;
    }

    case "open": {
      const settings = P.readSettings();
      const { openInBrowser } = require("./lib/win");
      let url = "http://localhost:" + P.PORT;
      if (settings.role !== "main") {
        const found = await require("./lib/outbox").findWebsite(true);
        if (found) url = found;
        else {
          await require("./lib/check").runCheck();
          return;
        }
      }
      openInBrowser(url);
      return;
    }

    case "check": {
      await require("./lib/check").runCheck({ noOpen: arg === "--no-open" });
      return;
    }

    case "update-now": {
      const B = require("./lib/brand");
      const answer = await require("./lib/supervisor").ask(P.LOCK_PORT, "update-check");
      if (answer === "ok" || answer === "busy") {
        console.log(B.NAME + " is looking for a new version now. If there is one, it is downloaded and installed by itself " +
          "(after any printing that is going on). \"Check " + B.NAME + "\" shows how it went.");
      } else if (answer.startsWith("off:no-key")) {
        console.log("Automatic updates aren't set up in this version of " + B.NAME + ".");
      } else if (answer.startsWith("off:switched-off")) {
        console.log("Automatic updates are switched off on this computer (update-settings.json in " + P.DATA_DIR + ").");
      } else if (answer.startsWith("off:")) {
        console.log(P.IS_WINDOWS
          ? "Updates are installed by " + B.NAME + "'s startup task, which isn't running on this computer. Run " + B.NAME + " Setup again to fix this."
          : "Updates can't be installed by the copy of " + B.NAME + " that is running. Restart " + B.NAME + " and try again.");
        process.exitCode = 1;
      } else {
        console.log(B.NAME + " isn't running, so it can't look for updates. Restart it first.");
        process.exitCode = 1;
      }
      return;
    }

    case "apply-update": {
      // The folder the background program prepared (see updater.js).
      if (arg) process.env.OP_UPDATE_DIR = arg;
      await require("./lib/updater").applyUpdate();
      return;
    }

    case "start-signed-in": {
      const n = await require("./lib/service").startForSignedInUsers(process.execPath);
      console.log(n ? "Started for " + n + (n === 1 ? " person" : " people") + " signed in." : "Nobody is signed in; it starts at the next sign-in.");
      return;
    }

    case "restart": {
      await require("./lib/control").restart();
      return;
    }

    case "stop": {
      const stopped = await require("./lib/control").stopRunning();
      const B = require("./lib/brand");
      console.log(stopped ? B.NAME + " has stopped." : B.NAME + " could not be stopped completely.");
      process.exitCode = stopped ? 0 : 1;
      return;
    }

    // --- used by the installer -------------------------------------------

    case "configure": {
      await require("./lib/configure").applyChoices(readChoices(arg));
      return;
    }

    case "find-server": {
      const { findServers } = require("../agent/lib/find");
      // Leave out this computer's own website (when it's being updated).
      const own = new Set(["127.0.0.1", ...require("./lib/win").lanAddresses()]);
      // alwaysScan: also knocks on every door when the quick question was
      // answered, so main computers too old to answer it are listed too (the
      // "make this the only main computer" page needs all of them).
      const lookOnce = async () => (await findServers({ alwaysScan: true })).filter((f) => !own.has(f.host));
      let found = await lookOnce();
      // One lost broadcast (or a Wi-Fi card still waking up) must not make Setup
      // think there is no main computer, so look once more before giving up.
      if (found.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        found = await lookOnce();
      }
      // Every main computer found, for the "only main computer" page: one line
      // each (main1..main4), how many are too old to switch off by themselves
      // (oldcount), and the name of one already set as the only main computer
      // (claimedby), if any.
      const shown = found.slice(0, 4); // as many as fit on Setup's page
      const lines = {};
      shown.forEach((f, i) => {
        lines["main" + (i + 1)] = "  -  " + (f.name || "A main computer") + "  (" + f.httpBase + ")" +
          (f.canStepDown ? "" : "  - older version: update or remove it by hand");
      });
      const claimed = found.filter((f) => f.claimAt > 0).sort((a, b) => b.claimAt - a.claimAt)[0];
      writeIni(arg, "found", Object.assign({
        count: found.length,
        address: found.length ? found[0].httpBase : "",
        name: found.length ? found[0].name : "",
        id: found.length ? found[0].id : "",
        oldcount: found.filter((f) => !f.canStepDown).length,
        claimedby: claimed ? (claimed.name || claimed.httpBase) : "",
        more: found.length > shown.length ? found.length - shown.length : 0,
      }, lines));
      return;
    }

    case "network-info": {
      const fixip = require("./lib/fixip");
      const info = await fixip.detect();
      let suggested = "";
      if (info.found && info.dhcp) suggested = await fixip.suggest(info);
      writeIni(arg, "net", {
        found: info.found ? "1" : "0",
        adapter: info.adapter || "",
        wifi: info.wifi ? "1" : "0",
        address: info.address || "",
        gateway: info.gateway || "",
        dhcp: info.dhcp ? "1" : "0",
        ours: info.ours ? "1" : "0",
        suggested: info.ours ? info.address : suggested,
      });
      return;
    }

    case "fix-address": {
      const fixip = require("./lib/fixip");
      const r = String(arg).toLowerCase() === "off" ? await fixip.restore() : await fixip.apply(String(process.argv[4] || "").trim());
      if (r.message) console.log(r.message);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }

    case "detect-old": {
      const old = require("./lib/oldsetup");
      writeIni(arg, "old", old.summary(await old.detect()));
      return;
    }

    case "diagnose": {
      // Everything the old-version search sees, for whoever looks after this.
      const found = await require("./lib/oldsetup").detect();
      const { run } = require("./lib/win");
      const raw = {};
      for (const [name, cmd, args] of [["tasklist", "tasklist.exe", ["/FO", "CSV", "/NH"]], ["netstat", "netstat.exe", ["-ano", "-p", "TCP"]]]) {
        const r = await run(cmd, args);
        raw[name] = { ok: r.ok, code: r.code, stdout: r.stdout.slice(0, 3000), stderr: r.stderr.slice(0, 500), error: r.error ? String(r.error.message) : "" };
      }
      fs.writeFileSync(arg, JSON.stringify({ found, raw }, null, 2));
      return;
    }

    case "replace-old": {
      await require("./lib/oldsetup").migrate(["main", "client"].includes(String(arg).toLowerCase()) ? String(arg).toLowerCase() : "printer");
      return;
    }

    case "save-power": {
      await require("./lib/power").save();
      return;
    }

    case "restore-sleep": {
      await require("./lib/power").restoreSleep();
      return;
    }

    case "restore-power": {
      await require("./lib/power").restore();
      return;
    }

    case "add-printer": {
      const result = await require("./lib/vprinter").add();
      console.log(result.message);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    case "install-service": {
      const result = await require("./lib/service").install();
      console.log(result.message);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    case "remove-service": {
      const result = await require("./lib/service").remove();
      if (result.message) console.log(result.message);
      return;
    }

    case "start-service": {
      process.exitCode = (await require("./lib/service").startNow()) ? 0 : 1;
      return;
    }

    case "remove-printer": {
      const result = await require("./lib/vprinter").remove();
      console.log(result.message);
      return;
    }

    case "before-uninstall": {
      // arg is "1" when the uninstaller's "Keep LibreOffice" box was
      // ticked; anything else (including nothing, for an older Setup or a
      // plain /S with no switches) means remove it as before.
      await require("./lib/uninstall").run({ keepLibreOffice: arg === "1" });
      return;
    }

    case "uninstall-status": {
      // What the Windows uninstaller needs to know before it draws its
      // page: is there a LibreOffice install to offer keeping?
      writeIni(arg, "status", {
        libreofficebysetup: P.readRecord().libreofficeBySetup ? "1" : "0",
      });
      return;
    }

    case "libreoffice-by-setup": {
      // The same question as "uninstall-status" above, for Uninstall
      // PrintBridge.command - a single "1" or "0" on stdout is easier for
      // a shell script to read than an answers file.
      console.log(P.readRecord().libreofficeBySetup ? "1" : "0");
      return;
    }

    case "install-libreoffice": {
      const ok = await require("./lib/libreoffice").install();
      process.exitCode = ok ? 0 : 1;
      return;
    }

    case "setup-wizard": {
      await require("./lib/setup-web").start();
      return;
    }

    case "finish-install": {
      // Called once by installer-mac/postinstall: offers the setup wizard
      // to whoever is signed in (waiting for them to finish it), and
      // otherwise - or if they don't - applies the recommended settings,
      // so this computer is left working either way.
      // An automatic update (see updater.js) changes nothing and asks
      // nothing: every setting stays as it was. Only the printer is checked.
      if (P.isConfigured() && require("./lib/updater").isInstalling()) {
        console.log("Automatic update: keeping this computer's settings.");
        try { await require("./lib/vprinter").add(); } catch (err) { /* Check shows it */ }
        try { fs.rmSync(path.join(P.DATA_DIR, "start-choice.txt"), { force: true }); } catch (err) { /* fine */ }
        return;
      }
      const flow = await require("./lib/setup-web").runInstallFlow();
      // On a first install the person may have chosen "Close without starting":
      // tell postinstall, which then leaves the background program for the
      // next start of this Mac.
      const choiceFile = path.join(P.DATA_DIR, "start-choice.txt");
      try {
        if (flow && flow.start === false) { fs.mkdirSync(P.DATA_DIR, { recursive: true }); fs.writeFileSync(choiceFile, "later"); }
        else fs.rmSync(choiceFile, { force: true });
      } catch (err) { /* then it starts, as it always did */ }
      return;
    }

    case "status": {
      const { lanAddresses } = require("./lib/win");
      const { findSoffice } = require("./lib/libreoffice");
      const settings = P.readSettings();
      const agent = P.readJson(path.join(P.PRINTER_DIR, "status.json")) || {};
      const addresses = lanAddresses();
      const running = await require("./lib/supervisor").isRunning();
      // A computer that only prints has no connection of its own: it is
      // "connected" when the printing website answers.
      if (settings.role === "client") {
        const found = await require("./lib/outbox").findWebsite(false);
        agent.state = found ? "connected" : "searching";
        agent.website = found || "";
      }
      // A brand name an earlier install here used, only reported when it
      // differs from this build's - so Setup can clean up that earlier
      // brand's shortcuts (see OfficePrinting.nsi and the "configure" command above).
      // Installs from before this tracking existed have no recorded brand;
      // for those, Setup reads the name from the earlier install's entry
      // in Settings > Apps instead (see OfficePrinting.nsi).
      const B = require("./lib/brand");
      const record = P.readRecord();
      let prevBrand = "";
      // Setup deletes the Start menu folder and desktop shortcut named after
      // this, with administrator rights - and install-record.json can be
      // edited by anyone signed in here. So only a plain name is passed on:
      // never anything that could reach outside the Start menu folder.
      const plainName = (n) => typeof n === "string" && n.length <= 60 &&
        /^[A-Za-z0-9][A-Za-z0-9 ()_-]*$/.test(n);
      if (record.brand && record.brand !== B.NAME && plainName(record.brand)) prevBrand = record.brand;

      writeIni(arg, "status", {
        configured: P.isConfigured() ? "1" : "0",
        running: running ? "1" : "0",
        role: settings.role,
        name: settings.name,
        // The main computer's address as typed into Setup last time, so
        // running Setup again (an update) keeps it instead of emptying it.
        server: settings.server,
        startuptask: P.readRecord().startupTask ? "1" : "0",
        address: addresses.length ? "http://" + addresses[0] + ":" + P.PORT : "",
        libreoffice: findSoffice() ? "1" : "0",
        connected: agent.state === "connected" ? "1" : "0",
        website: agent.website || "",
        printers: (agent.printers || []).join(", "),
        winprinter: (await require("./lib/vprinter").exists()) ? "1" : "0",
        prevbrand: prevBrand,
      });
      return;
    }

    case "version": {
      console.log(require("./lib/brand").NAME + " " + require("./lib/version").VERSION + "  " + require("./lib/brand").CREDIT);
      return;
    }

    default:
      console.log("Unknown command: " + command);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.log("Problem: " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
