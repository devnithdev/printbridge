// The agent.
//
// This little program runs on the computer that a printer is plugged into.
// It connects outward to the server (so the computer needs no open ports),
// proves who it is with a token, reports its printers, and then prints
// whatever the server sends it.
//
// It can run two ways:
//   - as a plain Node.js script (`node agent.js`), for development, or
//   - as a single packaged .exe (built with `pkg`) that a Windows user can
//     just double-click, with no separate Node.js install needed.
// BASE_DIR below is what makes both work: it is always the real folder the
// program lives in, never a location inside the packaged .exe itself.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, exec } = require("child_process");
const WebSocket = require("ws");

const { listPrintersWithCapabilities } = require("./lib/printers");
const durable = require("./lib/durable");
const { printFile } = require("./lib/print");

// When bundled with pkg, __dirname points *inside* the packaged snapshot,
// which cannot be written to and does not sit next to the real .exe. In
// that case pkg sets process.pkg, and the real, writable folder is wherever
// the .exe itself was double-clicked from.
const IS_PACKAGED = !!process.pkg;
const BASE_DIR = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;

// The installed version (OfficePrinting.exe) runs this file in "managed"
// mode: it keeps its settings in C:\ProgramData\Office Printing\printer,
// sets itself up with no questions, and never stops to wait for a keypress.
const MANAGED = process.env.OFFICE_PRINTING_MANAGED === "1";
const SETTINGS_DIR = process.env.PRINT_AGENT_DIR || BASE_DIR;

const CONFIG_FILE = path.join(SETTINGS_DIR, "config.json");
const STATUS_FILE = path.join(SETTINGS_DIR, "status.json");
const DOWNLOAD_DIR = path.join(SETTINGS_DIR, "downloads");
const VERSION = "4.2.0";

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// --- the bundled printing helper ----------------------------------------
//
// SumatraPDF is the free program that actually hands a PDF to a Windows
// printer. Rather than asking every user to download it separately and put
// it in exactly the right folder, a copy is baked into this .exe and
// written out next to it the first time it runs. That makes this one file
// the only thing anyone needs to copy onto a new computer.
//
// It is only written if it isn't already there, so anyone who prefers their
// own (or a newer) copy can simply drop it in and that one gets used.

const SUMATRA_NOTICE = [
  "SumatraPDF.exe, unpacked next to this program, is SumatraPDF - a free,",
  "open-source PDF reader used here to send PDFs to the printer.",
  "",
  "It is not part of this print agent and was not written by whoever gave",
  "you this program. It is distributed under the GNU GPL v3.",
  "",
  "Homepage:    https://www.sumatrapdfreader.org",
  "Source code: https://github.com/sumatrapdfreader/sumatrapdf",
  "Licence:     https://www.gnu.org/licenses/gpl-3.0.html",
  "",
  "Deleting this file and SumatraPDF.exe is safe - the agent will simply",
  "unpack a fresh copy the next time it starts.",
  "",
].join("\r\n");

function unpackSumatraIfNeeded() {
  if (os.platform() !== "win32") return; // only Windows printing needs it
  if (!IS_PACKAGED) return; // nothing is bundled when run with plain `node`
  if (MANAGED) return; // the installer puts SumatraPDF.exe in place itself

  const target = path.join(BASE_DIR, "SumatraPDF.exe");
  if (fs.existsSync(target)) return; // already there - leave it alone

  try {
    // __dirname points into the read-only bundle inside this .exe, which is
    // exactly where pkg keeps bundled assets - the one place it IS correct.
    const bundled = path.join(__dirname, "tools", "SumatraPDF.exe");
    fs.writeFileSync(target, fs.readFileSync(bundled));
    fs.writeFileSync(path.join(BASE_DIR, "SumatraPDF-LICENCE.txt"), SUMATRA_NOTICE);
    console.log("Unpacked the printing helper (SumatraPDF.exe) next to this program.");
  } catch (err) {
    console.log("");
    console.log("Could not unpack the printing helper: " + err.message);
    console.log("Printing may fail. You can fix this by downloading SumatraPDF");
    console.log("(the portable version) from sumatrapdfreader.org and saving it");
    console.log("as SumatraPDF.exe in this same folder.");
    console.log("");
  }
}

// --- keeping the console out of the way -----------------------------------
//
// Nobody should have to look at a black terminal window to use this. Setup
// happens in the browser instead (below), and on Windows this program
// minimizes its own console window the moment it starts, for both first
// run and every run after. It can't disappear entirely without native code
// this project doesn't depend on - and hiding a program's own window
// entirely is also something antivirus software watches for - so
// "minimized in the taskbar" is the target, not invisible.
function minimizeConsoleWindowIfWindows() {
  if (os.platform() !== "win32") return;

  try {
    const psScript =
      "$sig = '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int n);'; " +
      "Add-Type -MemberDefinition $sig -Name W -Namespace PrintAgent -ErrorAction SilentlyContinue; " +
      "$p = Get-Process -Id " + process.pid + " -ErrorAction SilentlyContinue; " +
      "if ($p -and $p.MainWindowHandle -ne 0) { [PrintAgent.W]::ShowWindowAsync($p.MainWindowHandle, 6) | Out-Null }";

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
      { windowsHide: true, stdio: "ignore", detached: true }
    );
    child.on("error", () => {}); // best-effort - a visible window is harmless
    child.unref();
  } catch (err) {
    // Same as above: nothing to do if this fails, just carry on.
  }
}

function openInBrowser(url) {
  const platform = os.platform();
  const command =
    platform === "win32" ? 'start "" "' + url + '"' :
    platform === "darwin" ? 'open "' + url + '"' :
    'xdg-open "' + url + '"';

  exec(command, () => {}); // best-effort - the URL is also printed as a fallback
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error("That request was too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error("That request didn't make sense."));
      }
    });
    req.on("error", reject);
  });
}

// --- talking to the website during setup ---------------------------------
//
// People type addresses in all sorts of shapes. Accept any of them and work
// out both forms the agent needs: the ws:// address it connects to, and the
// http:// address it signs in and downloads files through.
//
//   10.139.169.94                    -> ws://10.139.169.94:3000/agent
//   10.139.169.94:3000               -> ws://10.139.169.94:3000/agent
//   http://10.139.169.94:3000        -> ws://10.139.169.94:3000/agent
//   https://print.example.com        -> wss://print.example.com/agent
//   ws://10.139.169.94:3000/agent    -> unchanged
function normalizeServerAddress(input) {
  let text = String(input || "").trim();
  if (!text) return null;

  if (!/^[a-z]+:\/\//i.test(text)) text = "http://" + text;

  let url;
  try {
    url = new URL(text);
  } catch (err) {
    return null;
  }
  if (!url.hostname) return null;
  // "http//192.168.1.20:3000" (a missing colon) would otherwise be read as a computer called "http".
  if (/^(https?|wss?)$/i.test(url.hostname)) return null;

  const secure = url.protocol === "https:" || url.protocol === "wss:";
  // The printing website runs on port 3000, so "192.168.1.20" on its own
  // means 192.168.1.20:3000 - people often leave the ":3000" off.
  if (!secure && !url.port) url.port = "3000";
  const origin = (secure ? "https://" : "http://") + url.host;

  return {
    httpBase: origin,
    wsUrl: (secure ? "wss://" : "ws://") + url.host + "/agent",
  };
}

// A small POST helper built on http/https - see downloadFile below for why
// fetch() is avoided throughout this program.
function postJson(baseUrl, pathName, body, cookie) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(baseUrl + pathName);
    } catch (err) {
      reject(new Error("That address doesn't look right."));
      return;
    }

    const payload = Buffer.from(JSON.stringify(body || {}), "utf8");
    const client = url.protocol === "https:" ? https : http;
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": payload.length,
    };
    if (cookie) headers.Cookie = cookie;

    const request = client.request(
      { method: "POST", hostname: url.hostname, port: url.port, path: url.pathname, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch (err) {
            data = {};
          }
          resolve({
            status: response.statusCode,
            data,
            cookies: response.headers["set-cookie"] || [],
          });
        });
        response.on("error", reject);
      }
    );

    request.on("error", (err) => {
      // The raw messages here ("ECONNREFUSED", "ENOTFOUND") mean nothing to
      // most people, so say what actually went wrong. The `reachable: false`
      // flag lets the setup wizard tell "we never got to the website" apart
      // from "the website said no", so it can ask for the right thing again.
      let problem;
      if (err.code === "ECONNREFUSED") {
        problem = new Error("Nothing answered at that address. Is the website running?");
      } else if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
        problem = new Error("That address couldn't be found on the network.");
      } else if (err.code === "ETIMEDOUT") {
        problem = new Error("That address didn't respond. Check you're on the same network.");
      } else {
        problem = new Error(err.message);
      }
      problem.reachable = false;
      reject(problem);
    });

    request.setTimeout(15000, () => {
      const timedOut = new Error("That address didn't respond in time.");
      timedOut.reachable = false;
      request.destroy(timedOut);
    });
    request.write(payload);
    request.end();
  });
}

// Asks the website to register this computer and hand back its token.
// There are no accounts to sign in to - the website is open on the office
// network, so this is one request and nothing to copy by hand.
async function requestTokenFromWebsite(httpBase, agentName) {
  const created = await postJson(httpBase, "/api/manage/computers", { name: agentName });

  if (created.status === 404) {
    throw new Error(
      "That address answered, but it isn't the printing website (or it's an " +
      "older version). Check the address and try again."
    );
  }
  if (created.status !== 200 || !created.data.token) {
    throw new Error(
      created.data.error || "The website wouldn't register this computer (code " + created.status + ")."
    );
  }

  return created.data.token;
}

// --- first-run setup wizard ------------------------------------------------
//
// If there is no config.json yet, a tiny local web server is started and
// the person's normal browser opens to it automatically - a plain sign-in
// page instead of typing into a terminal. Filling it in calls the same
// sign-in/token logic as everywhere else in this file, saves config.json,
// and this function resolves once that succeeds. The little server then
// shuts itself down; nothing about it lingers.

function setupPageHtml(defaultAgentName) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect this printer - PrintBridge</title>
${require("./lib/theme").head()}
<style>
${require("./lib/theme").CSS}
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--bg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink); padding: 24px;
  }
  .card { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 32px;
    box-shadow: 0 1px 3px var(--shadow), 0 8px 24px var(--shadow); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 24px; color: var(--soft); font-size: 14px; line-height: 1.5; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 16px 0 6px; color: var(--ink); }
  input[type=text], input[type=email], input[type=password] {
    width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 14px;
    background: var(--field); color: var(--ink);
  }
  input::placeholder { color: var(--soft); opacity: 1; }
  input:focus { outline: 2px solid #1E6FBF; outline-offset: 1px; border-color: #1E6FBF; }
  button {
    width: 100%; margin-top: 24px; padding: 11px; border: none; border-radius: 8px;
    background: #1E6FBF; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  button:disabled { background: #7fa9d6; cursor: default; }
  .toggle { margin-top: 18px; font-size: 13px; text-align: center; }
  .toggle a { color: var(--brand-text); cursor: pointer; text-decoration: none; }
  .toggle a:hover { text-decoration: underline; }
  .msg { margin-top: 16px; font-size: 13px; padding: 10px 12px; border-radius: 8px; display: none; }
  .msg.error { display: block; background: var(--bad-bg); color: var(--bad-ink); }
  .msg.success { display: block; background: var(--ok-bg); color: var(--ok-ink); }
  .hint { font-size: 12px; color: var(--soft); margin-top: 4px; }
  .hidden { display: none !important; }
  .note { margin-top: 22px; font-size: 12px; color: var(--soft); line-height: 1.5; }
</style>
</head>
<body>
  ${require("./lib/theme").button()}
  <div class="card">
    <h1>Connect this printer</h1>
    <p class="sub">One box to fill in, once. This computer remembers it and connects on its own from now on.</p>

    <form id="f">
      <label for="address">Printing website address</label>
      <input id="address" type="text" placeholder="e.g. 192.168.1.23:3000" required>
      <div class="hint">It's shown on the website's own "Printers &amp; setup" page.</div>

      <label for="name">Name for this computer</label>
      <input id="name" type="text" value="${escapeHtml(defaultAgentName)}" required>
      <div class="hint">So people know which printer is which.</div>

      <div id="msg" class="msg"></div>

      <button id="submitBtn" type="submit">Connect</button>
    </form>

    <p class="note">No account and no password: the printing website is open to
    everyone on your office network, the same as the printer itself.</p>
    <p class="note" style="margin-top:14px">PrintBridge &middot; <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" style="vertical-align:-2px;margin-right:3px" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5c-.6.8.6 1.7 0 2.5M11.5 3.5c-.6.8.6 1.7 0 2.5"/><path d="M3 21h14"/></svg>by @devnithdev</p>
  </div>

<script>
  document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = document.getElementById("msg");
    var btn = document.getElementById("submitBtn");
    msg.className = "msg"; msg.textContent = "";
    btn.disabled = true; btn.textContent = "Connecting...";

    var body = {
      address: document.getElementById("address").value,
      agentName: document.getElementById("name").value,
    };

    fetch("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 200 && res.data.ok) {
          msg.className = "msg success";
          msg.textContent = 'Connected as "' + res.data.agentName + '". You can close this tab.';
          btn.textContent = "Connected";
        } else {
          throw new Error(res.data.error || "Something went wrong.");
        }
      })
      .catch(function (err) {
        msg.className = "msg error";
        msg.textContent = err.message;
        btn.disabled = false;
        btn.textContent = "Connect";
      });
  });
</script>
</body>
</html>`;
}

function runSetupWizard() {
  return new Promise((resolve, reject) => {
    const setupServer = http.createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(setupPageHtml(os.hostname()));
        return;
      }

      if (req.method === "GET" && req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/setup") {
        readJsonBody(req)
          .then(async (body) => {
            const target = normalizeServerAddress(body.address);
            if (!target) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "That website address doesn't look right." }));
              return;
            }

            const agentName = String(body.agentName || "").trim().slice(0, 60) || os.hostname();
            let token = "";

            try {
              token = await requestTokenFromWebsite(target.httpBase, agentName);
            } catch (err) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
              return;
            }

            const config = {
              serverUrl: target.wsUrl,
              token,
              agentName,
              sumatraPath: "",
              ghostscriptPath: "",
              dryRun: false,
            };
            // Saved the power-cut-safe way, like every other settings file.
            durable.writeJson(CONFIG_FILE, config);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, agentName }));

            console.log('This computer is now registered as "' + agentName + '".');
            console.log("Settings saved next to this program - you won't be asked again.");

            setTimeout(() => setupServer.close(), 200); // let the response flush first
            resolve(config);
          })
          .catch((err) => {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message || "Something went wrong." }));
          });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    setupServer.on("error", reject);

    setupServer.listen(0, "127.0.0.1", () => {
      const port = setupServer.address().port;
      const url = "http://127.0.0.1:" + port + "/";
      console.log("Opening your browser to finish setup...");
      console.log("If it doesn't open on its own, go to: " + url);
      openInBrowser(url);
    });
  });
}

// --- settings -------------------------------------------------------------

// Read with a fallback to the backup copy, in case a power cut caught the
// last save (see lib/durable.js).
function readConfigFile() {
  return durable.readJson(CONFIG_FILE);
}

async function loadConfig() {
  // Environment variables always win, for development and for anyone who
  // prefers scripting this instead of using the wizard or config.json.
  const envToken = process.env.PRINT_AGENT_TOKEN;
  const envUrl = process.env.PRINT_SERVER_URL;

  let fromFile = readConfigFile();

  if (!fromFile && !envToken) {
    fromFile = await runSetupWizard();
  }
  fromFile = fromFile || {};

  const config = {
    serverUrl: envUrl || fromFile.serverUrl || "ws://localhost:3000/agent",
    token: envToken || fromFile.token || "",
    agentName: process.env.PRINT_AGENT_NAME || fromFile.agentName || os.hostname(),
    sumatraPath: fromFile.sumatraPath || process.env.SUMATRA_PATH || "",
    ghostscriptPath: fromFile.ghostscriptPath || process.env.GHOSTSCRIPT_PATH || "",
    dryRun: process.env.AGENT_DRY_RUN === "1" || fromFile.dryRun === true,
    baseDir: BASE_DIR,
  };

  if (!config.token) {
    console.log("");
    console.log("No agent token set. Delete config.json and run this again to");
    console.log("go through setup, or paste a token into config.json by hand.");
    console.log("");
    waitForKeyThenExit(1);
    return null;
  }

  return config;
}

// On Windows, double-clicking the .exe opens a window that would otherwise
// vanish instantly on an error, before anyone can read it. Pause instead.
function waitForKeyThenExit(code) {
  if (IS_PACKAGED && process.stdin.isTTY) {
    console.log("Press Enter to close this window...");
    process.stdin.once("data", () => process.exit(code));
  } else {
    process.exit(code);
  }
}

// ws://host/agent  ->  http://host      (where files are downloaded from)
function httpBase(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  return url.toString().replace(/\/$/, "");
}

// --- connection ---------------------------------------------------------

let config = null;
let HTTP_BASE = "";
let socket = null;
let reconnectDelay = 1000;
let refreshTimer = null;
let lastPrintersJson = "";

// The printers on this computer. If Windows couldn't be asked just now
// (see listWindowsPrinters), the last list seen is used instead of none.
const LAST_PRINTERS_FILE = path.join(SETTINGS_DIR, "last-printers.json");
async function scanPrinters() {
  let printers = null;
  try {
    printers = await listPrintersWithCapabilities();
  } catch (err) {
    printers = null;
  }
  if (printers) {
    try { fs.writeFileSync(LAST_PRINTERS_FILE, JSON.stringify(printers)); } catch (err) { /* only a fallback */ }
    return printers;
  }
  console.log("Couldn't read this computer's printers just now; keeping the last list.");
  // Straight after starting, "the last list" is the one saved last time -
  // otherwise a slow print spooler at start-up would still report none.
  const saved = lastPrintersJson || (() => { try { return fs.readFileSync(LAST_PRINTERS_FILE, "utf8"); } catch (err) { return ""; } })();
  try { return JSON.parse(saved || "[]"); } catch (err) { return []; }
}

let quietTimer = null;

function connect() {
  console.log("Connecting to", config.serverUrl, "...");
  // Give up on an attempt after 10 seconds: an address that no longer
  // exists would otherwise hang for a couple of minutes each time.
  socket = new WebSocket(config.serverUrl, { handshakeTimeout: 10000 });
  const thisSocket = socket;

  // The website checks in every 30 seconds. If nothing at all has arrived
  // for 90, the connection is dead even if Windows hasn't noticed (the main
  // computer lost power, or its address changed): drop it and reconnect,
  // which is also what starts the search for a website that has moved.
  let lastHeard = Date.now();
  const heard = () => { lastHeard = Date.now(); };
  thisSocket.on("ping", heard);
  thisSocket.on("message", heard);
  if (quietTimer) clearInterval(quietTimer);
  quietTimer = setInterval(() => {
    if (thisSocket.readyState === WebSocket.OPEN && Date.now() - lastHeard > 90000) {
      console.log("Nothing heard from the website for 90 seconds; reconnecting.");
      thisSocket.terminate();
    }
  }, 15000);

  socket.on("open", async () => {
    heard();
    reconnectDelay = 1000;
    failuresInARow = 0;
    searchesInARow = 0;
    movedSearchGap = 2 * 60 * 1000;
    const printers = await scanPrinters();
    lastPrintersJson = JSON.stringify(printers);
    lastPrinterNames = printers.map((p) => p.name);

    send({
      type: "hello",
      token: config.token,
      agentName: config.agentName,
      platform: os.platform() + " " + os.release(),
      version: VERSION,
      printers,
    });

    console.log(
      "Connected. Reported",
      printers.length,
      "printer(s):",
      printers.map((p) => p.name).join(", ") || "none"
    );
    if (config.dryRun) console.log("DRY RUN is on: nothing will actually print.");

    startPrinterRefresh();
  });

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      return;
    }

    if (message.type === "welcome") {
      console.log("Server accepted this agent as:", message.agentName);
      writeStatus("connected", "Connected to the printing website.");
      if (MANAGED && !config.serverId) rememberWebsiteId();
      return;
    }
    if (message.type === "error") {
      console.log("Server said:", message.message);
      return;
    }
    if (message.type === "job") {
      handleJob(message).catch((err) => console.log("Job error:", err.message));
    }
  });

  socket.on("close", (code, reason) => {
    if (quietTimer && socket === thisSocket) { clearInterval(quietTimer); quietTimer = null; }
    stopPrinterRefresh();
    const why = reason ? reason.toString() : "";
    console.log("Disconnected." + (why ? " (" + why + ")" : ""));

    if (code === 4003 && MANAGED) {
      // The website no longer knows this computer - usually because it was
      // started fresh. Register again rather than stopping for good.
      console.log("The website no longer recognises this computer. Registering it again.");
      writeStatus("registering", "The website no longer recognised this computer - connecting it again.");
      forgetTokenAndRegister();
      return;
    }

    if (MANAGED) {
      failuresInARow++;
      writeStatus("problem", "Can't reach the printing website at " + HTTP_BASE + " - trying again.");
      maybeSearchForMovedWebsite();
    }

    if (code === 4003) {
      console.log("");
      console.log("The server did not recognise this agent's token.");
      console.log("Delete config.json next to this program and run it again");
      console.log("to set it up fresh with a new token from the website.");
      waitForKeyThenExit(1);
      return;
    }

    console.log("Trying again in", Math.round(reconnectDelay / 1000), "second(s).");
    setTimeout(connect, reconnectDelay);
    // Wait a little longer each time, up to 30 seconds.
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  socket.on("error", (err) => {
    console.log("Connection problem:", err.message);
  });
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function reportStatus(jobId, status, message, nativeJobId, noFailover) {
  send({ type: "status", jobId, status, message: message || "", nativeJobId: nativeJobId || "", noFailover: !!noFailover });
}

// Printers get plugged in and unplugged; check every 5 minutes and tell
// the server only when something actually changed.
function startPrinterRefresh() {
  stopPrinterRefresh();
  refreshTimer = setInterval(async () => {
    let printers = null;
    try { printers = await listPrintersWithCapabilities(); } catch (err) { printers = null; }
    if (!printers) return; // couldn't tell this time; the list stays as it was
    try { fs.writeFileSync(LAST_PRINTERS_FILE, JSON.stringify(printers)); } catch (err) { /* only a fallback */ }
    const asJson = JSON.stringify(printers);
    if (asJson !== lastPrintersJson) {
      lastPrintersJson = asJson;
      lastPrinterNames = printers.map((p) => p.name);
      writeStatus(lastState, lastMessage);
      send({ type: "printers", printers });
      console.log("Printer list changed, sent an update.");
    }
  }, 5 * 60 * 1000);
}

function stopPrinterRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

// --- doing a job --------------------------------------------------------

// Downloads the file with Node's built-in http/https modules, not the
// global fetch() function. fetch only exists on newer Node versions, and
// the Windows .exe has to be built on an older one (Node 16, see desktop/build.sh), so
// relying on fetch would break there even though it works fine when run
// with a modern `node agent.js` on macOS.
function downloadFile(fileUrl, jobId) {
  return new Promise((resolve, reject) => {
    const fullUrl = HTTP_BASE + fileUrl;
    const client = fullUrl.startsWith("https:") ? https : http;

    const request = client.get(
      fullUrl,
      { headers: { Authorization: "Bearer " + config.token } },
      (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume(); // drain it so the socket can close cleanly
          reject(new Error("Download failed with status " + response.statusCode));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const filePath = path.join(DOWNLOAD_DIR, jobId + ".pdf");
            fs.writeFileSync(filePath, Buffer.concat(chunks));
            resolve(filePath);
          } catch (err) {
            reject(err);
          }
        });
        response.on("error", reject);
      }
    );

    request.on("error", reject);
    // A download that stops arriving would leave the job at "downloading"
    // for ever.
    request.setTimeout(120000, () => request.destroy(new Error("the download stopped arriving")));
  });
}

// Jobs this computer has already taken. The website sends a job again
// whenever it didn't hear how it ended - the connection dropped while it
// was printing, or the website itself restarted - and printing it again
// would put a second copy in the tray. So a job already being printed is
// ignored, and one already finished just gets its ending sent again.
// Kept in a small file, so a restart of this program doesn't forget.
const HANDLED_FILE = path.join(SETTINGS_DIR, "handled-jobs.json");
const handledJobs = new Map(); // "jobId|printer" -> { status, message, nativeJobId, at }
// Tells this run of the program apart from earlier ones (a process id can
// be handed out again after a restart, so it isn't used for this).
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2);
try {
  const saved = JSON.parse(fs.readFileSync(HANDLED_FILE, "utf8"));
  for (const [id, entry] of Object.entries(saved || {})) handledJobs.set(id, entry);
} catch (err) {
  /* none yet */
}
// Per job AND printer: when a printer fails and the website moves the job
// to another printer on this same computer, that is new work, not a repeat.
const jobKey = (job) => job.jobId + "|" + job.printer;
function saveHandled() {
  try {
    fs.writeFileSync(HANDLED_FILE, JSON.stringify(Object.fromEntries(handledJobs)));
  } catch (err) {
    /* only a safeguard */
  }
}
function forgetJob(key) {
  handledJobs.delete(key);
  saveHandled();
}
function rememberJob(key, entry) {
  handledJobs.delete(key); // re-added at the end, so the oldest stay first
  handledJobs.set(key, Object.assign({ at: Date.now() }, entry));
  // A day is far longer than any job waits; 500 is plenty for a busy office.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, e] of handledJobs) {
    if (handledJobs.size > 500 || e.at < dayAgo) handledJobs.delete(id);
    else break;
  }
  saveHandled();
}

// How many jobs this computer is printing right now, for the status file:
// automatic updates wait for 0 before restarting (see busyReason in
// desktop/lib/updater.js).
let printingNow = 0;
let printingSince = 0;

async function handleJob(job) {
  printingNow++;
  printingSince = Date.now();
  writeStatus(lastState, lastMessage);
  try {
    return await handleOneJob(job);
  } finally {
    printingNow = Math.max(0, printingNow - 1);
    writeStatus(lastState, lastMessage);
  }
}

async function handleOneJob(job) {
  const key = jobKey(job);
  const seen = handledJobs.get(key);
  if (seen && seen.status === "working") {
    // Only while this program is still running - after a restart, a job
    // left "working" was interrupted, and is safest reported as failed
    // rather than printed a second time from the start.
    if (seen.run === RUN_ID) {
      console.log("Job", job.jobId, "is already being printed; not starting it again.");
      return;
    }
    console.log("Job", job.jobId, "was interrupted by a restart; reporting it rather than printing it twice.");
    rememberJob(key, { status: "failed", noFailover: true, message: "This computer restarted while printing it - check the printer, and print it again if it didn't come out." });
  }
  const ended = handledJobs.get(key);
  if (ended && (ended.status === "done" || ended.status === "failed")) {
    console.log("Job", job.jobId, "was already", ended.status + "; telling the website again.");
    reportStatus(job.jobId, ended.status, ended.message, ended.nativeJobId, ended.noFailover);
    return;
  }
  rememberJob(key, { status: "working", run: RUN_ID });

  console.log("Job", job.jobId, "for", job.printer, "-", job.fileName);
  reportStatus(job.jobId, "accepted", "Agent picked up the job.");

  let filePath = null;

  try {
    reportStatus(job.jobId, "downloading", "Downloading the file.");
    filePath = await downloadFile(job.fileUrl, job.jobId);
    console.log("  downloaded to", filePath);
  } catch (err) {
    console.log("  download failed:", err.message);
    // Not remembered as "failed": the website may send it again once the
    // file can be fetched, and there is nothing printed to double up.
    forgetJob(key);
    reportStatus(job.jobId, "failed", "Could not download the file: " + err.message);
    return;
  }

  try {
    reportStatus(job.jobId, "printing", "Sending to " + job.printer + ".");
    const result = await printFile(job.printer, filePath, job.options || {}, config);
    console.log("  printed:", result.detail);
    rememberJob(key, { status: "done", message: result.detail, nativeJobId: result.nativeJobId || "" });
    reportStatus(job.jobId, "done", result.detail, result.nativeJobId);
  } catch (err) {
    console.log("  printing failed:", err.message);
    rememberJob(key, { status: "failed", message: err.message });
    reportStatus(job.jobId, "failed", err.message);
  } finally {
    // Never leave downloaded documents lying around on the computer.
    fs.unlink(filePath, (err) => {
      if (err) console.log("  could not delete", filePath, "-", err.message);
      else console.log("  deleted", filePath);
    });
  }
}

// --- managed mode (the installed OfficePrinting.exe) ----------------------
//
// Set up by the installer, so there is nobody to ask anything. It works out
// where the printing website is by itself:
//   - on the main computer, it's this computer (localhost);
//   - otherwise, the address typed into the installer, if one was; or
//   - it searches the office network for it (lib/find.js).
// Then it registers itself, saves the token, and connects. If the main
// computer's address ever changes, it searches again and reconnects.

const { findServers, identify } = require("./lib/find");

const ROLE = process.env.OP_ROLE === "main" ? "main" : "printer";
let failuresInARow = 0;
// Searching the network is gentle but not free, and office security tools
// can mistake frequent searches for something suspicious. So while the
// website can't be found (say, the main computer is off overnight), wait
// longer between searches each time: 30 s, 1, 2, 5, then every 10 minutes.
const SEARCH_WAITS = [30, 60, 120, 300, 600].map((s) => s * 1000);
let searchesInARow = 0;
function nextSearchWait() {
  return SEARCH_WAITS[Math.min(searchesInARow++, SEARCH_WAITS.length - 1)];
}
let movedSearchGap = 2 * 60 * 1000; // grows to 15 minutes while the website stays away
let lastSearchAt = 0;
let lastRegisterAt = 0;
let lastState = "starting";
let lastMessage = "";
let lastPrinterNames = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A small file the "Check Office Printing" page reads to say what this
// computer is doing, in plain words.
function writeStatus(state, message) {
  if (!MANAGED) return;
  lastState = state;
  lastMessage = message || "";
  const status = {
    state,
    message: lastMessage,
    website: HTTP_BASE || "",
    agentName: (config && config.agentName) || process.env.OP_NAME || os.hostname(),
    printers: lastPrinterNames,
    busy: printingNow,
    busyAt: printingSince,
    updatedAt: Date.now(),
  };
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (err) {
    /* only informational */
  }
}

// Saved by writing a flushed temporary copy and swapping it in, plus a
// backup copy, so a power cut can't leave this computer without its
// connection (see lib/durable.js).
function saveConfig() {
  durable.writeJson(CONFIG_FILE, config);
}

// Where is the website? Returns an http:// address, or null if not found yet.
// An address typed into Setup is used when it answers - but when it doesn't
// (the main computer was given a new address after a power cut, say), the
// network is searched instead of waiting on a dead address for ever. Among
// the websites found, the one this computer belonged to before (its
// permanent id) wins.
async function locateWebsite() {
  if (ROLE === "main") return "http://localhost:3000";

  const typed = normalizeServerAddress(process.env.OP_SERVER || "");
  if (typed) {
    const url = new URL(typed.httpBase);
    if (await identify(url.hostname, parseInt(url.port, 10) || 80)) return typed.httpBase;
    console.log("The address typed into Setup (" + typed.httpBase + ") isn't answering; searching the network instead.");
  }

  writeStatus("searching", "Looking for the printing website on this network...");
  const found = await findServers();
  lastSearchAt = Date.now();
  if (found.length === 0) return null;
  const wantedId = (config && config.serverId) || "";
  const same = wantedId ? found.find((f) => f.id === wantedId) : null;
  if (!same && found.length > 1) {
    console.log("Found more than one printing website: " + found.map((f) => f.httpBase).join(", ") +
      ". Using the first. To choose, type the address into Setup instead.");
  }
  return (same || found[0]).httpBase;
}

async function registerOnce() {
  const base = await locateWebsite();
  if (!base) {
    writeStatus("searching", "The printing website wasn't found on this network yet. " +
      "Is the main computer switched on? This computer keeps looking by itself.");
    return false;
  }

  const agentName = String(process.env.OP_NAME || "").trim().slice(0, 60) || os.hostname();
  writeStatus("registering", "Connecting this computer to " + base + "...");
  let token;
  try {
    token = await requestTokenFromWebsite(base, agentName);
  } catch (err) {
    console.log("Could not register with " + base + ": " + err.message);
    writeStatus("problem", "Couldn't connect to " + base + ": " + err.message);
    return false;
  }

  const url = new URL(base);
  const about = await identify(url.hostname, parseInt(url.port, 10) || 80);
  const target = normalizeServerAddress(base);

  config = Object.assign({}, config || {}, {
    serverUrl: target.wsUrl,
    token,
    agentName,
    serverId: (about && about.id) || "",
    serverName: (about && about.name) || "",
    sumatraPath: (config && config.sumatraPath) || "",
    ghostscriptPath: (config && config.ghostscriptPath) || "",
    dryRun: process.env.AGENT_DRY_RUN === "1",
  });
  try {
    saveConfig();
  } catch (err) {
    // Carry on connected; it's only a problem if this program restarts
    // before the next successful save.
    console.log("Could not save this computer's connection: " + err.message);
  }
  console.log('Registered this computer as "' + agentName + '" with ' + base + ".");
  return true;
}

async function forgetTokenAndRegister() {
  // At most once every 2 minutes, so a confused website can't cause a storm
  // of new registrations.
  const wait = Math.max(0, lastRegisterAt + 2 * 60 * 1000 - Date.now());
  if (wait) await sleep(wait);
  lastRegisterAt = Date.now();
  if (config) {
    config.token = "";
    try { saveConfig(); } catch (err) { /* re-registering will save again */ }
  }
  while (!(await registerOnce())) await sleep(ROLE === "main" ? 5000 : nextSearchWait());
  HTTP_BASE = httpBase(config.serverUrl);
  connect();
}

// If the website has been unreachable for a while, the main computer may
// simply have been given a new network address (common after a power cut
// or router restart). Search the network for the same website - recognised
// by its permanent id - and move over to its new address.
let searching = false;
let lastQuickSearchAt = 0;
async function maybeSearchForMovedWebsite() {
  if (ROLE === "main" || searching) return;
  if (failuresInARow < 2) return;
  // A quick search (one question to the whole network, answered by the main
  // computer itself - see lib/find.js) every 20 seconds or so; the slower
  // knock-on-every-door search only now and then, as before.
  const now = Date.now();
  const fullDue = now - lastSearchAt >= movedSearchGap;
  if (!fullDue && now - lastQuickSearchAt < 20000) return;

  searching = true;
  try {
    lastQuickSearchAt = now;
    const found = await findServers({ tcp: fullDue });
    if (fullDue) {
      lastSearchAt = Date.now();
      movedSearchGap = Math.min(movedSearchGap * 2, 15 * 60 * 1000);
    }
    const current = new URL(HTTP_BASE).host;
    // Recognised by its permanent id. If the only website on the network has
    // a different id (its saved list was lost and it started afresh) and the
    // old address has been dead for a while, it is still the one to use: it
    // won't know this computer, which then simply registers again there.
    const match = found.find((f) => (config.serverId ? f.id === config.serverId : found.length === 1)) ||
      (found.length === 1 && failuresInARow >= 6 ? found[0] : null);
    if (match && new URL(match.httpBase).host !== current) {
      console.log("The printing website has moved to " + match.httpBase + ". Switching over.");
      config.serverUrl = normalizeServerAddress(match.httpBase).wsUrl;
      if (match.id) config.serverId = match.id;
      if (match.name) config.serverName = match.name;
      try { saveConfig(); } catch (err) { console.log("Could not save the new address: " + err.message); }
      HTTP_BASE = httpBase(config.serverUrl);
      reconnectDelay = 1000; // the pending retry will use the new address
    }
  } catch (err) {
    console.log("Search for the website failed: " + err.message);
  } finally {
    searching = false;
  }
}

// Settings moved over from an older version don't know the website's
// permanent id yet; learn it once connected.
async function rememberWebsiteId() {
  try {
    const url = new URL(HTTP_BASE);
    const about = await identify(url.hostname, parseInt(url.port, 10) || 80);
    if (about && about.id) {
      config.serverId = about.id;
      try { saveConfig(); } catch (err) { /* learnt again next time */ }
    }
  } catch (err) {
    /* try again next time */
  }
}

async function startManaged() {
  console.log("PrintBridge - sharing this computer's printers (" + ROLE + " computer).");
  config = readConfigFile();

  // A setup moved over from an older version may point at this computer's
  // own website while this computer is now only a printer computer, or the
  // other way round. Such settings can't work, so start afresh.
  if (config && config.serverUrl) {
    const pointsHere = /\/\/(localhost|127\.0\.0\.1)[:/]/i.test(config.serverUrl);
    if (pointsHere && ROLE !== "main") config = null;
  }
  if (config && ROLE === "main" && config.serverUrl &&
      !/\/\/(localhost|127\.0\.0\.1)[:/]/i.test(config.serverUrl)) {
    // Talk to our own website directly, so an address change can't matter.
    config.serverUrl = "ws://localhost:3000/agent";
    try { saveConfig(); } catch (err) { /* harmless */ }
  }

  while (!config || !config.token) {
    if (await registerOnce()) break;
    // On the main computer the website is starting at the same moment, so
    // it will be there in seconds; elsewhere, wait longer each time.
    await sleep(ROLE === "main" ? 5000 : nextSearchWait());
  }
  if (process.env.AGENT_DRY_RUN === "1") config.dryRun = true;
  // The name chosen in Setup wins over one saved by an older version; the
  // website updates its list to match when this computer connects.
  const chosenName = String(process.env.OP_NAME || "").trim().slice(0, 60);
  if (chosenName && chosenName !== config.agentName) {
    config.agentName = chosenName;
    try { saveConfig(); } catch (err) { /* used for this run regardless */ }
  }
  config.baseDir = BASE_DIR;
  HTTP_BASE = httpBase(config.serverUrl);
  writeStatus("connecting", "Connecting to the printing website...");
  connect();
}

// --- go -----------------------------------------------------------------

process.on("SIGINT", () => {
  console.log("\nStopping.");
  if (socket) socket.close(1000, "Stopped by user");
  process.exit(0);
});

function startStandalone() {
  (async () => {
    // Minimized immediately, first thing, on every launch - setup and normal
    // use both happen without this window needing to be looked at.
    minimizeConsoleWindowIfWindows();

    config = await loadConfig();
    if (!config) return; // loadConfig already explained why and is exiting
    unpackSumatraIfNeeded();
    HTTP_BASE = httpBase(config.serverUrl);
    connect();
  })();
}

if (require.main === module) startStandalone();

module.exports = { startManaged };
