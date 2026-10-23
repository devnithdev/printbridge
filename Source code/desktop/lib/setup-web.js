// The macOS setup wizard: a small local web page instead of the custom
// pages Windows Setup shows (Apple's own installer can't draw those). The
// .pkg's postinstall script starts this, opens it in a browser, and waits
// for it to finish before it lets the background program start - exactly
// the order Windows follows too (choices are made, THEN the program runs
// with them). Runs only on 127.0.0.1, never reachable from the network.
//
// Asks the same things the Windows wizard does, and in the same order:
//   1. what this computer does (main / shares a printer / only prints),
//      its name, the main computer's address, and - main computer only,
//      if LibreOffice isn't already there - whether to install it;
//   2. main computer only: whether to keep this computer awake, what the
//      lid should do, and whether to give it a fixed network address (see
//      fixip.js). (No battery-critical choice - see power.mac.js
//      for why that one genuinely isn't offered.)
// Then it adds the "PrintBridge" printer (every computer, like Windows),
// applies the power choices (main and printer computers; a computer that
// only prints keeps sleeping normally, also like Windows), and installs
// LibreOffice if asked to.
//
// Run again later (there's a "Reconfigure PrintBridge" item for this - see
// installer-mac), it starts from this computer's current settings, the
// same way running Windows Setup again does.

const http = require("http");
const querystring = require("querystring");
const P = require("./paths");
const B = require("./brand");
const T = require("../../agent/lib/theme");
const { applyChoices } = require("./configure");
const vprinter = require("./vprinter");
const power = require("./power");
const libreoffice = require("./libreoffice");
const progress = require("./progress");
const { openInBrowser, lanAddresses } = require("./win");

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function initialState() {
  const settings = P.readSettings();
  return {
    role: settings.role,
    name: settings.name,
    server: settings.server,
    foundServer: null, // { address, name, id } from "look for it automatically"
    installLibreOffice: !libreoffice.findSoffice(),
    keepAwake: true,
    lidAction: "stay-awake",
    // "Make this the only main computer" - see watchForTakeover in server.js.
    takeover: false,
    // "Keep this computer's address the same" - see fixip.js. net is looked
    // at once, when the page that asks is first shown.
    net: null,
    fixAddr: false,
    fixAddress: "",
  };
}

function layout(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${esc(B.NAME)} Setup</title>
${T.head()}
<style>
${T.CSS}
:root { --brand:${B.PRIMARY}; --brand-dark:${B.PRIMARY_DARK}; --accent:${B.ACCENT}; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; padding:32px 16px; }
main { max-width:560px; margin:0 auto; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px 32px 32px; overflow:hidden; } /* keeps the coloured bar inside the rounded corners */
.bar { height:5px; background:linear-gradient(90deg, var(--brand) 0 80%, var(--accent) 80%); border-radius:3px; margin:-28px -32px 24px; }
h1 { font-size:22px; margin:0 0 4px; }
p.sub { color:var(--soft); margin:0 0 24px; }
fieldset { border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:0 0 18px; }
legend { padding:0 6px; font-weight:600; font-size:13px; color:var(--soft); }
label.row { display:flex; gap:10px; align-items:flex-start; padding:8px 0; cursor:pointer; }
label.row input[type=radio], label.row input[type=checkbox] { margin-top:3px; }
.row .t { font-weight:600; }
.row .d { color:var(--soft); font-size:14px; margin-top:2px; }
label.field { display:block; font-weight:600; font-size:14px; margin:14px 0 6px; }
input[type=text] { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--field); color:var(--ink); font-size:15px; }
input::placeholder { color:var(--soft); opacity:1; }
.hint { color:var(--soft); font-size:13px; margin-top:6px; }
.actions { display:flex; justify-content:space-between; align-items:center; margin-top:24px; }
button, .btn { background:var(--brand); color:#fff; border:none; border-radius:8px; padding:11px 20px; font-size:15px; font-weight:600; cursor:pointer; text-decoration:none; display:inline-block; }
button:hover, .btn:hover { background:var(--brand-dark); }
button.secondary { background:transparent; color:var(--brand-text); padding:11px 8px; }
form.inline { display:inline; }
a.back { color:var(--soft); font-size:14px; text-decoration:none; }
ul.summary { list-style:none; margin:0 0 20px; padding:0; }
ul.summary li { padding:8px 0; border-top:1px solid var(--line); }
ul.summary li:first-child { border-top:none; }
ul.summary b { display:block; font-size:13px; color:var(--soft); font-weight:600; }
.footer { margin-top:26px; color:var(--soft); font-size:12px; }
</style></head><body>${T.button()}<main>
<div class="bar"></div>
<h1>${esc(title)}</h1>
${body}
<div class="footer">${esc(B.NAME)} Setup &middot; ${B.CREDIT_HTML}</div>
</main></body></html>`;
}

function rolePage(state) {
  const hasLO = !!libreoffice.findSoffice();
  const foundNote = state.foundServer
    ? `Found automatically: <b>${esc(state.foundServer.name)}</b> (${esc(state.foundServer.address)}). Change it below if this isn't right.`
    : "";
  return layout(`What does this computer do?`, `
<p class="sub">Choose one. You can run this setup again later to change it.</p>
<form method="POST" action="/">
  <fieldset>
    <legend>This computer</legend>
    <label class="row"><input type="radio" name="role" value="main" ${state.role === "main" ? "checked" : ""} onclick="toggle()">
      <div><div class="t">Is the main computer</div><div class="d">Runs the printing page everyone opens. Choose this on ONE computer only - one that stays on during office hours. Its printers are shared too.</div></div>
    </label>
    <label class="row"><input type="radio" name="role" value="printer" ${state.role === "printer" ? "checked" : ""} onclick="toggle()">
      <div><div class="t">Shares a printer</div><div class="d">A printer is plugged into (or installed on) this computer. The main computer must already be set up; this one finds it by itself.</div></div>
    </label>
    <label class="row"><input type="radio" name="role" value="client" ${state.role === "client" ? "checked" : ""} onclick="toggle()">
      <div><div class="t">Only prints</div><div class="d">No printer here. People using this computer print to the office printers, from Word, Excel and any other program. It still sleeps as usual.</div></div>
    </label>
  </fieldset>

  <label class="field" id="nameLabel">Name for this computer (people see it next to its printers, e.g. "Front desk")</label>
  <input type="text" name="name" id="nameField" maxlength="60" value="${esc(state.name)}">

  <label class="field" id="serverLabel">Main computer's address (only if it isn't found by itself - it's on the wall sign)</label>
  <input type="text" name="server" id="serverField" maxlength="200" value="${esc(state.server)}">
  <p class="hint" id="foundNote">${foundNote}</p>
  <div id="findRow"><button type="submit" name="action" value="find" class="secondary">Look for it automatically</button></div>

  <fieldset id="takeBox" style="display:none;margin-top:18px">
    <legend>Other main computers</legend>
    <label class="row"><input type="checkbox" name="takeover" value="1" ${state.takeover ? "checked" : ""}>
      <div><div class="t">Make this the only main computer</div><div class="d">Every other main computer on this network stops running its printing page and shares its printers through this one, by itself within about a minute (one that is switched off does so when it's next switched on). Nothing is deleted on them, and running setup there can make one the main computer again. Older versions can't do this by themselves - update or remove those by hand.</div></div>
    </label>
  </fieldset>

  <fieldset id="loBox" style="display:none">
    <legend>Word, Excel and PowerPoint files</legend>
    ${hasLO
      ? `<p class="hint">LibreOffice is already installed, so these already print.</p>`
      : `<label class="row"><input type="checkbox" name="installLibreOffice" value="1" ${state.installLibreOffice ? "checked" : ""}>
          <div><div class="t">Also install LibreOffice (free)</div><div class="d">Needed to print Word, Excel and PowerPoint files and photos (PDFs print fine either way). Downloads about 300&nbsp;MB and can take a while.</div></div>
        </label>`}
  </fieldset>

  <div class="actions"><span></span><button type="submit" name="action" value="next">Continue</button></div>
</form>
<script>
function toggle() {
  var role = document.querySelector('input[name=role]:checked').value;
  var show = function (id, on) { document.getElementById(id).style.display = on ? '' : 'none'; };
  show('serverLabel', role !== 'main');
  show('serverField', role !== 'main');
  show('foundNote', role !== 'main');
  show('findRow', role !== 'main');
  show('nameLabel', role !== 'client');
  show('nameField', role !== 'client');
  show('loBox', role === 'main');
  show('takeBox', role === 'main');
}
toggle();
</script>`);
}

// The "keep this computer's address the same" part of the power page.
function addressBox(state) {
  const net = state.net;
  if (!net || !net.found || (!net.dhcp && !net.ours)) return "";
  return `
  <fieldset>
    <legend>Network address</legend>
    <p class="hint" style="margin-top:0">${net.ours
      ? `This computer's address is fixed at <b>${esc(net.address)}</b> (set by an earlier setup). Untick to let the router choose it again.`
      : `This computer's address is <b>${esc(net.address)}</b> right now. The router chose it, and can give it a different one after a power cut or a router restart - then the wall sign's address stops working.`}</p>
    <label class="row"><input type="checkbox" name="fixAddr" value="1" ${state.fixAddr ? "checked" : ""}>
      <div><div class="t">Give this computer a fixed address (recommended)</div><div class="d">A free address high up on this network is suggested; change it if you have your own plan. If the network stops working with it, setup changes it back to automatic by itself.${net.wifi
        ? " <b>This Mac is on Wi-Fi:</b> only tick this if it stays in the office - the fixed address is used on every Wi-Fi network it joins."
        : ""} If you can, also reserve this address in the router.</div></div>
    </label>
    <label class="field" for="fixAddress">Fixed address</label>
    <input type="text" name="fixAddress" id="fixAddress" maxlength="15" value="${esc(state.fixAddress)}">
  </fieldset>`;
}

function powerPage(state) {
  return layout("How should this computer behave?", `
<p class="sub">Recommended for a computer other people print through.</p>
<form method="POST" action="/power">
  <fieldset>
    <legend>Sleep</legend>
    <label class="row"><input type="checkbox" name="keepAwake" value="1" ${state.keepAwake ? "checked" : ""}>
      <div><div class="t">Keep this computer awake</div><div class="d">Recommended. The screen can still turn off after a while - only sleep itself is turned off, so printing keeps working.</div></div>
    </label>
  </fieldset>
  <fieldset>
    <legend>When the lid closes</legend>
    <label class="row"><input type="radio" name="lidAction" value="stay-awake" ${state.lidAction === "stay-awake" ? "checked" : ""}>
      <div><div class="t">Keep working (recommended)</div><div class="d">Printing keeps working with the lid closed, as long as this computer stays plugged in.</div></div>
    </label>
    <label class="row"><input type="radio" name="lidAction" value="sleep" ${state.lidAction === "sleep" ? "checked" : ""}>
      <div><div class="t">Let it sleep as usual</div></div>
    </label>
  </fieldset>
  ${addressBox(state)}
  <p class="hint">When running on battery, this computer also switches on Low Power Mode by itself, to stay reachable for longer. macOS doesn't offer a way for a program to change what happens at critically low battery - that's handled by macOS itself.</p>
  <div class="actions"><a class="back" href="/">&larr; Back</a><button type="submit">Continue</button></div>
</form>`);
}

function confirmPage(state) {
  const roleLabel = { main: "The main computer", printer: "Shares a printer", client: "Only prints" }[state.role];
  const rows = [
    ["This computer", roleLabel],
    ["Name", state.role === "client" ? "(not needed)" : esc(state.name || require("os").hostname())],
  ];
  if (state.role !== "main") rows.push(["Main computer's address", state.server ? esc(state.server) : "(found automatically)"]);
  if (state.role === "main") rows.push(["Other main computers", state.takeover ? "Switch over to this one (this becomes the only main computer)" : "Left as they are"]);
  if (state.role === "main") rows.push(["LibreOffice", libreoffice.findSoffice() ? "Already installed" : (state.installLibreOffice ? "Will be installed" : "Not installed")]);
  if (state.role !== "client") {
    rows.push(["Keep awake", state.keepAwake ? "Yes" : "No"]);
    rows.push(["When the lid closes", state.lidAction === "stay-awake" ? "Keep working" : "Sleep as usual"]);
  }
  if (state.role === "main" && state.net && state.net.found && (state.net.dhcp || state.net.ours)) {
    rows.push(["Network address", state.fixAddr
      ? "Fixed at " + esc(state.fixAddress || "(a free one setup picks)")
      : (state.net.ours ? "Back to automatic (chosen by the router)" : "Automatic (chosen by the router)")]);
  }
  return layout("Ready to set up", `
<p class="sub">This is what will be applied to this computer.</p>
<ul class="summary">
${rows.map(([k, v]) => `<li><b>${esc(k)}</b>${v}</li>`).join("\n")}
</ul>
<form method="POST" action="/install">
  <div class="actions"><a class="back" href="/">&larr; Back</a><button type="submit">Set up ${esc(B.NAME)}</button></div>
</form>`);
}

function donePage(lines) {
  return layout("All set", `
<ul class="summary">
${lines.map((l) => `<li>${esc(l)}</li>`).join("\n")}
</ul>
<p class="hint">You can close this tab. ${esc(B.NAME)} is now starting.</p>`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error("Form too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(querystring.parse(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

function send(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res, to) {
  res.writeHead(303, { Location: to });
  res.end();
}

async function findServerNow() {
  const { findServers } = require("../../agent/lib/find");
  const own = new Set(["127.0.0.1", ...lanAddresses()]);
  const found = (await findServers()).filter((f) => !own.has(f.host));
  return found[0] || null;
}

// Everything "Set up" actually does, once the choices are known - the mac
// equivalent of OfficePrinting.nsi's install Section.
async function install(state) {
  const wantLO = state.role === "main" && state.installLibreOffice && !libreoffice.findSoffice();
  const steps = [
    { id: "settings", label: "Saving this computer's settings", weight: 3 },
    { id: "printer", label: `Adding the "${B.NAME}" printer`, weight: 4 },
  ];
  if (state.role !== "client") steps.push({ id: "power", label: "Applying the power settings", weight: 3 });
  const net = state.role === "main" ? state.net : null;
  const fixChange = net && net.found && (state.fixAddr ? (net.dhcp || net.ours) : net.ours);
  if (fixChange) steps.push({ id: "address", label: state.fixAddr ? "Fixing this computer's network address" : "Making this computer's network address automatic again", weight: 6 });
  if (wantLO) steps.push({ id: "libreoffice", label: "Installing LibreOffice (about 300 MB)", weight: 90 });
  progress.begin(steps);

  progress.start("settings");
  await applyChoices({
    role: state.role,
    name: state.name,
    server: state.server,
    foundid: state.foundServer ? state.foundServer.id : "",
    takeover: state.takeover ? "1" : "",
  });
  progress.finish("settings");

  progress.start("printer");
  const printerResult = await vprinter.add();
  const printerText = printerResult.message || (printerResult.ok ? `Added the "${B.NAME}" printer.` : `Couldn't add the "${B.NAME}" printer.`);
  if (printerResult.ok) progress.finish("printer", printerText); else progress.skip("printer", printerText);

  if (state.role === "client") {
    await power.restore();
  } else {
    progress.start("power");
    await power.save();
    const powerResult = await power.apply({ keepAwake: state.keepAwake, lidAction: state.lidAction });
    if (powerResult.ok === false) progress.skip("power", powerResult.message);
    else progress.finish("power", powerResult.message);
  }

  if (fixChange) {
    progress.start("address");
    const fixip = require("./fixip");
    const r = state.fixAddr ? await fixip.apply(state.fixAddress) : await fixip.restore();
    if (r.ok) progress.finish("address", r.message); else progress.skip("address", r.message);
  }

  if (wantLO) {
    progress.start("libreoffice");
    const ok = await libreoffice.install();
    if (ok) progress.finish("libreoffice", "LibreOffice is installed.");
    else progress.skip("libreoffice", "LibreOffice could NOT be installed now (PDFs still print fine). Run Reconfigure PrintBridge later to try again.");
  }

  if (state.takeover) {
    // Says which main computers were found, and which of them are too old to
    // switch over by themselves (they then need doing by hand).
    let note = "This is now the only main computer: other main computers on this network switch over to it within about a minute of it starting.";
    try {
      const own = new Set(["127.0.0.1", ...lanAddresses()]);
      const others = (await require("../../agent/lib/find").findServers({ alwaysScan: true })).filter((f) => !own.has(f.host));
      const old = others.filter((f) => !f.canStepDown).map((f) => f.name || f.httpBase);
      if (others.length) note += " Found: " + others.map((f) => f.name || f.httpBase).join(", ") + ".";
      if (old.length) note += " " + old.join(", ") + (old.length === 1 ? " runs" : " run") + " an older version and can't switch over by itself: run this setup there (choose \"Shares a printer\") or uninstall PrintBridge there.";
      if (others.length) note += " Their wall signs show their old address, so print this computer's sign to replace them.";
    } catch (err) { /* the note above still stands */ }
    progress.log(note);
    progress.snapshot().lines.push(note);
  }
  progress.complete();
  return progress.snapshot().lines;
}

function progressPage(offer) {
  return layout("Setting up", `
<p class="sub" id="msg">Starting...</p>
<div class="track"><div class="fill" id="fill"></div></div>
<p class="pct" id="pct">0%</p>
<ul class="steps" id="steps"></ul>
<div id="result"></div>
<div id="choice"></div>
<p class="hint" id="hint">This page updates by itself. Please keep it open until it says "All set".</p>
<style>
.track { height:14px; background:var(--line); border-radius:8px; overflow:hidden; margin:6px 0 4px; }
.fill { height:100%; width:0; background:var(--brand); border-radius:8px; transition:width .5s ease; }
.pct { text-align:right; color:var(--soft); font-size:13px; margin:0 0 14px; }
ul.steps { list-style:none; margin:0 0 16px; padding:0; }
ul.steps li { padding:6px 0 6px 28px; position:relative; color:var(--soft); }
ul.steps li::before { content:"○"; position:absolute; left:4px; }
ul.steps li.running { color:var(--ink); font-weight:600; }
ul.steps li.running::before { content:"◔"; color:var(--brand); }
ul.steps li.done { color:var(--ink); }
ul.steps li.done::before { content:"✓"; color:var(--ok); }
ul.steps li.problem::before { content:"!"; color:var(--bad); font-weight:700; }
ul.steps li.problem { color:var(--bad); }
.err { background:var(--bad-bg); border:1px solid var(--bad-line); color:var(--bad-ink); border-radius:8px; padding:10px 12px; margin:10px 0; }
</style>
<script>
var lost = 0;
function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
function draw(s) {
  document.getElementById('fill').style.width = s.percent + '%';
  document.getElementById('pct').textContent = s.percent + '%';
  document.getElementById('msg').textContent = s.error ? 'Something went wrong' : s.message;
  document.getElementById('steps').innerHTML = s.steps.map(function (x) { return '<li class="' + x.status + '">' + esc(x.label) + '</li>'; }).join('');
  if (s.done) {
    var html = s.error ? '<div class="err">' + esc(s.error) + '</div><p><a class="btn" href="/confirm">Try again</a></p>' : '';
    if (!s.error && s.lines.length) html += '<ul class="summary">' + s.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';
    document.getElementById('result').innerHTML = html;
    if (s.error) document.getElementById('hint').textContent = '';
    else if (OFFER) showChoice();
    else document.getElementById('hint').textContent = 'Done. ${esc(B.NAME)} restarts by itself with the new settings. You can close this tab.';
  }
}
// First install: nothing is started until the person says so (or closes this page).
var OFFER = ${offer ? "true" : "false"};
var chosen = false;
function choose(what) {
  if (chosen) return;
  chosen = true;
  document.getElementById('choice').innerHTML = '';
  var msg = document.getElementById('hint');
  msg.textContent = what === 'start'
    ? '${esc(B.NAME)} is starting. You can close this tab.'
    : '${esc(B.NAME)} is installed but not started. It starts by itself the next time this Mac starts, or open Applications > ${esc(B.NAME)} > Restart ${esc(B.NAME)} to start it now. You can close this tab.';
  fetch('/choose?c=' + what, { method: 'POST' }).catch(function () {});
}
function showChoice() {
  document.getElementById('msg').textContent = 'All set. ${esc(B.NAME)} is installed.';
  document.getElementById('hint').textContent = 'Start it now, or just close this page.';
  document.getElementById('choice').innerHTML =
    '<div class="actions"><button type="button" class="secondary" onclick="choose(\\'later\\')">Close without starting</button>' +
    '<button type="button" onclick="choose(\\'start\\')">Start ${esc(B.NAME)} now</button></div>';
  // Closing the tab or window counts as "just close".
  window.addEventListener('pagehide', function () { if (!chosen) { chosen = true; navigator.sendBeacon('/choose?c=later'); } });
}
function poll() {
  fetch('/progress.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
    lost = 0;
    if (!s.started) { location.href = '/confirm'; return; }
    draw(s);
    if (!s.done) setTimeout(poll, 700);
  }).catch(function () {
    // The setup program closes this page's server itself once everything is done.
    lost++;
    if (lost > 6) { document.getElementById('msg').textContent = 'All set.'; document.getElementById('hint').textContent = 'You can close this tab.'; return; }
    setTimeout(poll, 700);
  });
}
poll();
</script>`);
}

// Builds the server without starting it, so runInstallFlow() below can
// race it against a timeout and shut it down cleanly either way.
function createServer(options) {
  const offerStart = !!(options && options.offerStart);
  let startChoice = null; // "start" | "later" (only asked on a first install)
  let state = initialState();
  let resolveDone;
  // Set the moment "Set up PrintBridge" is pressed, before install() is
  // awaited - so a timeout that fires while a slow install (e.g. the ~300MB
  // LibreOffice download) is still running knows one is already under way,
  // rather than starting a second, concurrent one of its own. Two calls to
  // applyChoices()/vprinter.add()/power.save()+apply() at once could each
  // read settings.json/install-record.json, change them, and write back
  // over each other's changes.
  let installStarted = false;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  // A few seconds after the work ends, so the progress page can fetch its
  // final state; then this page's server is closed and setup is finished.
  // After a failure it stays up, so "Try again" can work.
  const finishSoon = (failed) => {
    if (failed) return;
    if (offerStart) {
      // Waits for "Start now" / "Close without starting" (or the page being
      // closed). If nobody answers in 10 minutes, start it: a computer must
      // not be left half-finished because a window was forgotten.
      setTimeout(() => { if (!startChoice) closeSoon("start"); }, 10 * 60 * 1000).unref();
      return;
    }
    setTimeout(() => {
      try { server.close(); if (server.closeAllConnections) server.closeAllConnections(); } catch (err) { /* going anyway */ }
      resolveDone();
    }, 4000);
  };
  const closeSoon = (what) => {
    if (startChoice) return;
    startChoice = what;
    setTimeout(() => {
      try { server.close(); if (server.closeAllConnections) server.closeAllConnections(); } catch (err) { /* going anyway */ }
      resolveDone();
    }, 1500);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/choose") {
        closeSoon(url.searchParams.get("c") === "later" ? "later" : "start");
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end("{\"ok\":true}");
      }
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, rolePage(state));
      if (req.method === "POST" && url.pathname === "/") {
        // Both buttons on this page submit the same form now (they have to
        // - a nested <form> around "Look for it automatically" isn't valid
        // HTML, and browsers close the outer form as soon as they see it,
        // leaving the LibreOffice checkbox and Continue button outside any
        // form at all). "action" says which button was pressed.
        const body = await readBody(req);
        state.role = P.ROLES.has(body.role) ? body.role : "printer";
        state.name = String(body.name || "").trim().slice(0, 60);
        state.server = String(body.server || "").trim();
        state.installLibreOffice = body.installLibreOffice === "1";
        state.takeover = state.role === "main" && body.takeover === "1";
        if (body.action === "find") {
          state.foundServer = await findServerNow().catch(() => null);
          if (state.foundServer) state.server = "";
          return redirect(res, "/");
        }
        // The lid/keep-awake choice is only asked on the main computer -
        // a printer computer gets the same recommended values silently
        // (they're already what `state` starts with), same as Windows.
        return redirect(res, state.role === "main" ? "/power" : "/confirm");
      }
      if (req.method === "GET" && url.pathname === "/power") {
        if (state.role !== "main") return redirect(res, "/confirm");
        if (!state.net) {
          const fixip = require("./fixip");
          state.net = await fixip.detect().catch(() => ({ found: false }));
          if (state.net.found) {
            state.fixAddress = state.net.ours ? state.net.address : (state.net.dhcp ? await fixip.suggest(state.net).catch(() => "") : "");
            // Recommended on a cable connection; on Wi-Fi it's left to the person.
            state.fixAddr = state.net.ours || (state.net.dhcp && !state.net.wifi && !!state.fixAddress);
          }
        }
        return send(res, 200, powerPage(state));
      }
      if (req.method === "POST" && url.pathname === "/power") {
        const body = await readBody(req);
        state.keepAwake = body.keepAwake === "1";
        state.lidAction = body.lidAction === "sleep" ? "sleep" : "stay-awake";
        state.fixAddr = body.fixAddr === "1";
        if (typeof body.fixAddress === "string") state.fixAddress = body.fixAddress.trim().slice(0, 15);
        if (state.fixAddr && state.net && state.net.found && state.fixAddress) {
          const problem = require("./fixip").problemWith(state.fixAddress, state.net);
          if (problem) return send(res, 200, powerPage(state).replace("<form", `<p class="hint" style="color:var(--bad)">${esc(problem)}</p><form`));
        }
        return redirect(res, "/confirm");
      }
      if (req.method === "GET" && url.pathname === "/confirm") {
        if (installStarted) return redirect(res, "/progress");
        return send(res, 200, confirmPage(state));
      }
      if (req.method === "GET" && url.pathname === "/progress") return send(res, 200, progressPage(offerStart));
      if (req.method === "GET" && url.pathname === "/progress.json") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify(progress.snapshot()));
      }
      if (req.method === "POST" && url.pathname === "/install") {
        // Answers straight away and does the work in the background, so the
        // browser can show a progress bar instead of a page that keeps loading
        // (LibreOffice alone is a 300 MB download).
        if (!installStarted) {
          installStarted = true;
          install(state).then(
            () => finishSoon(),
            (err) => {
              progress.fail((err && err.message) || String(err));
              installStarted = false; // lets "Try again" run it once more
              finishSoon(true);
            }
          );
        }
        return redirect(res, "/progress");
      }
      redirect(res, "/");
    } catch (err) {
      send(res, 500, layout("Something went wrong", `<p>${esc(err.message)}</p><p><a class="btn" href="/">Start over</a></p>`));
    }
  });
  return { server, done, installStarted: () => installStarted, choice: () => startChoice };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(P.SETUP_WEB_PORT, "127.0.0.1", () => {
      const url = "http://127.0.0.1:" + P.SETUP_WEB_PORT + "/";
      console.log(B.NAME + " setup: open " + url + " to finish setting up this computer.");
      openInBrowser(url); // harmless no-op if there's no signed-in GUI session to open it in
      resolve();
    });
  });
}

// Runs the wizard until someone finishes it - for running (or re-running,
// to change something) by hand, with no time limit. See runInstallFlow()
// below for how Setup itself uses this on a fresh install.
async function start() {
  const { server, done } = createServer();
  await listen(server);
  return done;
}

// .unref()'d so this timer alone can never keep the process alive - without
// this, a successful, well-finished install still left Node running for up
// to timeoutMs afterward, blocking installer-mac/postinstall's following
// `launchctl bootstrap` for however long was left on the clock.
function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

// Whether someone is signed in at the screen right now, so the wizard has
// somewhere to open. /dev/console is owned by whoever is signed in there;
// "root" (or not being able to ask at all) means nobody is.
function hasConsoleUser() {
  try {
    const { execFileSync } = require("child_process");
    const owner = execFileSync("stat", ["-f%Su", "/dev/console"], { timeout: 5000 }).toString().trim();
    return !!owner && owner !== "root";
  } catch (err) {
    return false;
  }
}

// Used when there's nobody to answer the wizard (an unattended install, or
// nobody finished it within the time given): applies whatever this
// computer is already set to, or - on a brand new install - the same
// sensible defaults the wizard itself starts from, so it ends up working
// straight away either way. Doesn't touch LibreOffice - that one is
// slow and worth a person's yes, not a silent default.
async function applyCurrentSettings() {
  const state = initialState();
  await applyChoices({ role: state.role, name: state.name, server: state.server, foundid: "" });
  await vprinter.add();
  if (state.role === "client") {
    await power.restore();
  } else {
    await power.save();
    await power.apply({ keepAwake: true, lidAction: "stay-awake" });
  }
}

// The whole first-run flow, called once by Setup (installer-mac/postinstall)
// right after the files are in place. If someone is signed in to answer
// it, the wizard is given up to `timeoutMs` to be finished (the same
// attended experience as Windows Setup's own pages); otherwise, or if it
// isn't finished in time, this computer is set up with the recommended
// settings instead, so it's always left working either way.
async function runInstallFlow(options) {
  const timeoutMs = (options && options.timeoutMs) || 15 * 60 * 1000;
  if (!hasConsoleUser()) {
    console.log("Nobody is signed in to answer the setup wizard; using the recommended settings.");
    await applyCurrentSettings();
    return { start: true };
  }
  // A first install asks at the end whether to start now; an update starts
  // again by itself, as before (the old version was stopped to update it).
  const { server, done, installStarted, choice } = createServer({ offerStart: !P.isConfigured() });
  await listen(server);
  const timedOut = await Promise.race([done.then(() => false), wait(timeoutMs).then(() => true)]);
  if (!timedOut) return { start: choice() !== "later" }; // finished on its own - install() already applied everything
  if (installStarted()) {
    // "Set up PrintBridge" was pressed and install() is already running
    // (most likely stuck on the LibreOffice download) - let it finish on
    // its own rather than starting a second, overlapping install.
    console.log("The setup wizard's install is still running past the time limit; letting it finish rather than starting another.");
    await done;
    return { start: choice() !== "later" };
  }
  console.log("The setup wizard wasn't finished in time; using the recommended settings instead.");
  server.close();
  await applyCurrentSettings();
  return { start: true };
}

module.exports = { start, runInstallFlow, applyCurrentSettings };
