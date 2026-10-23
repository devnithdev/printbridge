// Applying the choices made when setting up this computer - what it does
// (main / printer / client), its name, and which main computer to use.
// Shared by both installers so they follow exactly the same rules:
//   Windows - main.js's "configure" command, fed by an answers file the
//             NSI wizard writes (see OfficePrinting.nsi and readChoices()
//             in main.js).
//   macOS   - setup-web.js's wizard, which calls this directly since it
//             runs in the same process.

const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("./paths");

// The address the outbox remembers from the last printout it sent (see
// SERVER_CACHE in outbox.js). It is only ever a shortcut, so throwing it
// away costs nothing - but leaving it behind when this computer is pointed
// at a different main computer means it keeps answering, and keeps being
// used, for as long as the old one is still switched on.
function forgetRememberedServer() {
  // removeJson also takes its backup copy, which would otherwise be read
  // in its place (see durable.js).
  P.removeJson(path.join(P.OUTBOX_DIR, "server.json"));
}

// choices: { role, name, server, foundid, takeover ("1" = make this the only main computer) }
async function applyChoices(choices) {
  choices = Object.assign({}, choices, { role: String(choices.role || "").trim().toLowerCase() });
  // A printer or client computer that is being pointed at a DIFFERENT main
  // computer (a new one was set up, or another address was typed in)
  // forgets its old connection, so it connects to the new one straight away.
  const configFile = path.join(P.PRINTER_DIR, "config.json");
  const config = P.readJson(configFile);
  if (choices.role === "client") {
    // A computer that stops sharing printers ("only prints" now) takes them
    // off the main computer's list and forgets its connection - whichever
    // main computer it was last connected to. Checked first and on its own
    // (rather than after the "different main" check below), because that
    // check deletes config.json when the wizard is ALSO pointed at a
    // different main address at the same time - and once it's gone,
    // tellMainComputer() below would have had nothing left to read the old
    // main's address from, and would silently never run.
    if (config) {
      await require("./uninstall").tellMainComputer();
      P.removeJson(configFile);
      forgetRememberedServer();
    }
  } else if (choices.role !== "main" && config && config.serverUrl) {
    // A printer or client computer that is being pointed at a DIFFERENT
    // main computer (a new one was set up, or another address was typed
    // in) forgets its old connection, so it connects to the new one
    // straight away.
    const hostnameOf = (u) => {
      try { return new URL(String(u).replace(/^ws/i, "http")).hostname.toLowerCase(); } catch (err) { return ""; }
    };
    let typed = String(choices.server || "").trim();
    if (typed && !/^[a-z]+:\/\//i.test(typed)) typed = "http://" + typed;
    const typedHost = typed ? hostnameOf(typed) : "";
    const typedDiffers = !!typedHost && typedHost !== hostnameOf(config.serverUrl);
    const foundDiffers = choices.foundid && config.serverId && config.serverId !== choices.foundid;
    if (typedDiffers || foundDiffers) {
      P.removeJson(configFile);
      forgetRememberedServer();
      console.log("This computer will connect to the new main computer.");
    }
  }
  P.writeSettings({
    role: P.ROLES.has(choices.role) ? choices.role : "printer",
    name: String(choices.name || "").replace(/["<>]/g, "").trim().slice(0, 60) || os.hostname(),
    server: String(choices.server || "").trim(),
  });
  // "Make this the only main computer": the moment it was asked for is
  // saved where this computer's website reads it (see watchForTakeover in
  // server.js). Every other main computer on the network that sees it
  // switches itself over to this one. A later Setup run that doesn't tick
  // it again leaves the claim as it was.
  if (choices.role === "main" && String(choices.takeover || "") === "1") {
    P.ensureDirs();
    P.writeJson(path.join(P.WEBSITE_DIR, "claim.json"), { at: Date.now() });
    // It is the main computer again (if it ever stepped down for another one).
    P.updateRecord({ steppedDown: null });
    console.log("This is now the only main computer: any other main computer on the network switches over to it.");
  } else if (choices.role === "main" && P.readRecord().steppedDown) {
    P.updateRecord({ steppedDown: null });
  }
  // A report from before these settings would only mislead Setup.
  try { fs.rmSync(path.join(P.PRINTER_DIR, "status.json"), { force: true }); } catch (err) { /* fine */ }
  // Remembers the brand name this install is using, so a later Setup run
  // (an update, or a fresh rename) can find and clean up shortcuts left
  // over from whatever brand name was used before - see "status".
  P.updateRecord({ brand: require("./brand").NAME });
  console.log("Saved this computer's settings.");
}

module.exports = { applyChoices };
