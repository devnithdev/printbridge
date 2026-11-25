// Everything about connected agents and their printers.
//
// An agent is the little program that runs next to a printer. It connects
// outward to this server over WebSocket, proves who it is with a token, and
// then tells us which printers it has and what those printers can do.
//
// Printers are available to everyone on the network - like a printer
// standing in a corridor. An agent's token is not about people; it stops a
// stranger pretending to BE one of your printer computers.

const { EventEmitter } = require("events");
const path = require("path");
const { db, save, DATA_FILE } = require("./store");
const durable = require("../../agent/lib/durable");
const { hashToken } = require("./ids");

const events = new EventEmitter();

// Agents that are connected right now. This is deliberately in memory:
// a connection cannot survive a restart anyway.
const socketsByAgentId = new Map(); // agentId -> WebSocket
const agentIdBySocket = new Map(); // WebSocket -> agentId

function printerId(agentId, printerName) {
  return agentId + "::" + printerName;
}

function findAgentByToken(token) {
  if (!token) return null;
  const hashed = hashToken(token);
  return db.agents.find((a) => a.tokenHash === hashed) || null;
}

function isOnline(agentId) {
  return socketsByAgentId.has(agentId);
}

function sendToAgent(agentId, message) {
  const socket = socketsByAgentId.get(agentId);
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function disconnectAgent(agentId) {
  const socket = socketsByAgentId.get(agentId);
  if (socket) {
    socketsByAgentId.delete(agentId);
    agentIdBySocket.delete(socket);
    try { socket.close(4003, "Removed"); } catch (err) { /* ignore */ }
  }
  for (const id of [...health.keys()]) {
    if (id.startsWith(agentId + "::")) health.delete(id);
  }
  events.emit("printers-changed");
}

// What was set by hand on Printers & setup, kept for a printer that drops out
// of its computer's list, so it isn't lost when the printer comes back.
const KEPT_SETTINGS = ["hidden", "broken", "colorMode", "duplexMode", "printerType", "displayName"];
function keptOf(printer) {
  const kept = {};
  for (const key of KEPT_SETTINGS) if (printer[key] !== undefined && printer[key] !== false && printer[key] !== "auto" && printer[key] !== "") kept[key] = printer[key];
  return kept;
}

// The same settings, also in a file of their own, by computer name and printer
// name (not the ids in the printer list, which are made again if that list is
// ever lost or a computer registers anew). So an update, a restart or a lost list
// never puts back the colour, both sides, hidden, out of order and rename choices:
// the printer is recognised by where it is and what it is called.
// Written only when someone changes a setting here, never when printers register,
// so a computer that arrives with nothing set can't wipe what was chosen.
const SETTINGS_FILE = path.join(path.dirname(DATA_FILE), "printer-settings.json");
let kept = null;
function keptSettings() {
  if (!kept) {
    const read = durable.readJson(SETTINGS_FILE);
    kept = read && typeof read === "object" && !Array.isArray(read) ? read : {};
  }
  return kept;
}
const settingsKey = (agentName, printerName) => agentName + "::" + printerName;

function persistSettings() {
  const all = keptSettings();
  let changed = false;
  for (const p of db.printers) {
    const agent = db.agents.find((a) => a.id === p.agentId);
    const key = settingsKey(agent ? agent.name : p.agentId, p.name);
    const now = keptOf(p);
    const same = JSON.stringify(all[key] || {}) === JSON.stringify(now);
    if (same) continue;
    if (Object.keys(now).length) all[key] = now; else delete all[key];
    changed = true;
  }
  if (!changed) return;
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - 500))) delete all[old]; // the oldest go
  try {
    durable.writeJson(SETTINGS_FILE, all);
  } catch (err) {
    console.log("Couldn't save the printer settings file: " + err.message);
  }
}

// First start with this file: copy what is set now, so nothing chosen before has to be set again.
if (!require("fs").existsSync(SETTINGS_FILE)) persistSettings();

function rememberSettings(printer) {
  const kept = keptOf(printer);
  if (!Object.keys(kept).length) return;
  db.printerSettings = db.printerSettings || {};
  db.printerSettings[printer.id] = kept;
  const ids = Object.keys(db.printerSettings);
  for (const old of ids.slice(0, Math.max(0, ids.length - 200))) delete db.printerSettings[old]; // the oldest go
}

// Save (or update) what an agent told us about its printers.
function rememberPrinters(agent, printers) {
  const seen = new Set();

  for (const incoming of printers) {
    if (!incoming || typeof incoming !== "object") continue;
    const name = String(incoming.name || "").trim();
    if (!name) continue;
    const id = printerId(agent.id, name);
    seen.add(id);

    let record = db.printers.find((p) => p.id === id);
    if (!record) {
      // Back after dropping out of its computer's list for a while (switched
      // off, unplugged): it keeps what was set on Printers & setup.
      record = Object.assign({
        id,
        agentId: agent.id,
        name,
        hidden: false,
        colorMode: "auto",
        capabilities: null,
        updatedAt: 0,
      }, keptSettings()[settingsKey(agent.name, name)], (db.printerSettings || {})[id]);
      if (db.printerSettings) delete db.printerSettings[id];
      db.printers.push(record);
    }
    record.reportedCapabilities = incoming.capabilities || null;
    applyColorMode(record);
    record.updatedAt = Date.now();
  }

  // Printers that vanished from the agent (unplugged, removed) are forgotten,
  // but only for this agent.
  for (let i = db.printers.length - 1; i >= 0; i--) {
    const p = db.printers[i];
    if (p.agentId === agent.id && !seen.has(p.id)) {
      rememberSettings(p);
      db.printers.splice(i, 1);
    }
  }

  save();
  events.emit("printers-changed");
}

// Colour or black and white. The computer guesses (agent/lib/printers.js),
// and the guess can be wrong, so the Manage page can say for sure:
// "auto" believes the computer, "color" and "mono" overrule it. The
// result goes into capabilities, so the print page, the checks before
// printing and failover all follow it without knowing about this.
const COLOR_MODES = new Set(["auto", "color", "mono"]);
const PRINTER_TYPES = new Set(["auto", "inkjet", "laser", "dotmatrix", "thermal"]);

// Both sides works the same way: "auto" believes the computer, "yes" and
// "no" overrule it (a printer can say it has duplex when it hasn't), and
// "hand" means it prints both sides only if someone turns the paper over.
const DUPLEX_MODES = new Set(["auto", "yes", "no", "hand"]);

function applyColorMode(record) {
  // Printers saved before this existed only have what the computer said.
  if (record.reportedCapabilities === undefined) record.reportedCapabilities = record.capabilities || null;
  const mode = COLOR_MODES.has(record.colorMode) ? record.colorMode : "auto";
  const duplex = DUPLEX_MODES.has(record.duplexMode) ? record.duplexMode : "auto";
  const reported = record.reportedCapabilities;
  if (mode === "auto" && duplex === "auto") {
    record.capabilities = reported;
    return;
  }
  record.capabilities = Object.assign({}, reported || {},
    mode === "auto" ? {} : { color: mode === "color" },
    duplex === "auto" ? {} : { duplex: duplex === "yes", duplexByHand: duplex === "hand" });
}

function setColorMode(record, mode) {
  if (!COLOR_MODES.has(mode)) return false;
  record.colorMode = mode;
  applyColorMode(record);
  save();
  persistSettings();
  events.emit("printers-changed");
  return true;
}

function setDuplexMode(record, mode) {
  if (!DUPLEX_MODES.has(mode)) return false;
  record.duplexMode = mode;
  applyColorMode(record);
  save();
  persistSettings();
  events.emit("printers-changed");
  return true;
}

// What kind of printer it is: what the Manage page says, else a guess from
// its name. People mistake dot matrix printers for ordinary ones, so the
// print page shows this, and failover only moves a job to the same kind.
const TYPE_GUESSES = [
  ["dotmatrix", /dot ?matrix|\b(LQ|LX|FX|DFX|PLQ)[-\s]?\d|\bML[-\s]?\d{3}|microline|tally|\bDP[-\s]?\d{3}\b/i],
  ["thermal", /thermal|receipt|\bTM[-\s]?[TUMPH]?\d|\bPOS[-\s]?\d|\bXP[-\s]?\d{2,3}|zebra|\bZD\d|\bGK\d|rongta|\blabel\b/i],
  ["inkjet", /ink ?jet|deskjet|officejet|\benvy\b|smart ?tank|ink ?tank|ecotank|pixma|stylus|workforce|\bL\d{3,4}\b|\bET[-\s]?\d{4}|\bG\d{4}\b|\bM[GP]\d{3,4}|\bTS\d{4}|\bDCP-T|\bMFC-J/i],
  ["laser", /laser|\bLBP|imageclass|i-sensys|\bHL-|\bMFC-L|\bDCP-L|xpress|\bSL-|ecosys|\bFS-\d|bizhub|imagerunner|phaser|versalink|workcentre|\bKX-MB|\bCLX|\bM\d{3,4}[a-z]{0,4}\b|\bP\d{4}/i],
];
function kindOf(record) {
  if (PRINTER_TYPES.has(record.printerType) && record.printerType !== "auto") return record.printerType;
  const found = TYPE_GUESSES.find(([, pattern]) => pattern.test(record.name || ""));
  return found ? found[0] : "unknown";
}

// A name people see for a printer, instead of the one its computer gives it
// ("Front desk laser" instead of "HP LaserJet Professional P1102"). The real
// name stays: it is how the printer's computer finds the printer, and what the
// kind and brand are guessed from. Empty text goes back to the real name.
// Answers false when another printer already shows that name.
const labelOf = (p) => p.displayName || p.name;
function setDisplayName(record, text) {
  const clean = String(text == null ? "" : text).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  // Its own name typed back in just clears the rename.
  const target = clean && clean.toLowerCase() !== String(record.name).toLowerCase() ? clean : "";
  // Not a name another printer shows, nor another printer's own name: Printers & setup and the drop page would mix them up.
  if (target && db.printers.some((p) => p !== record && (labelOf(p).toLowerCase() === target.toLowerCase() || String(p.name).toLowerCase() === target.toLowerCase()))) return false;
  if (target) record.displayName = target;
  else delete record.displayName;
  save();
  persistSettings();
  events.emit("printers-changed");
  return true;
}

function setPrinterType(record, type) {
  if (!PRINTER_TYPES.has(type)) return false;
  record.printerType = type;
  save();
  persistSettings();
  events.emit("printers-changed");
  return true;
}

// How each printer is doing (jam, no paper...), as its computer last said.
// Kept in memory only: it is stale the moment that computer goes quiet.
const health = new Map(); // printer id -> { problem, waiting, at }
const HEALTH_FRESH_MS = 3 * 60 * 1000;

function rememberHealth(agentId, list) {
  let changed = false;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = printerId(agentId, String(item.name || "").trim());
    if (!db.printers.some((p) => p.id === id)) continue;
    const problem = String(item.problem || "").slice(0, 120);
    const prev = health.get(id);
    if ((prev ? prev.problem : "") !== problem) changed = true;
    health.set(id, {
      problem,
      waiting: Math.max(0, parseInt(item.waiting, 10) || 0),
      at: Date.now(),
    });
  }
  if (changed) events.emit("health-changed");
}

// "" when fine (or nothing is known); else a short reason like "Paper jam".
function problemOf(printer) {
  const h = printer && health.get(printer.id);
  if (!h || !isOnline(printer.agentId) || Date.now() - h.at > HEALTH_FRESH_MS) return "";
  return h.problem;
}

// The printer list the print page shows. Hidden printers are ones someone
// switched off on the Manage page - broken, private office, whatever.
function listPrinters() {
  return db.printers
    .filter((p) => !p.hidden)
    .map((p) => {
      const agent = db.agents.find((a) => a.id === p.agentId);
      return {
        id: p.id,
        name: p.name,           // what its computer calls it (used for printing and guessing its kind)
        label: labelOf(p),      // what people are shown
        computerName: agent ? agent.name : "unknown",
        agentId: p.agentId,
        online: isOnline(p.agentId),
        printerType: PRINTER_TYPES.has(p.printerType) ? p.printerType : "auto",
        kind: kindOf(p),
        capabilities: p.capabilities,
        broken: !!p.broken,
        problem: problemOf(p),
      };
    })
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

// Everything, including hidden printers - for the Manage page.
function listPrintersForManaging() {
  return db.printers
    .map((p) => {
      const agent = db.agents.find((a) => a.id === p.agentId);
      return {
        id: p.id,
        name: p.name,
        label: labelOf(p),
        displayName: p.displayName || "",
        computerName: agent ? agent.name : "unknown",
        agentId: p.agentId,
        online: isOnline(p.agentId),
        hidden: !!p.hidden,
        broken: !!p.broken,
        printerType: PRINTER_TYPES.has(p.printerType) ? p.printerType : "auto",
        kind: kindOf(Object.assign({}, p, { printerType: "auto" })), // what "Automatic" means for it
        colorMode: COLOR_MODES.has(p.colorMode) ? p.colorMode : "auto",
        duplexMode: DUPLEX_MODES.has(p.duplexMode) ? p.duplexMode : "auto",
        reportedDuplex: p.reportedCapabilities === undefined
          ? (p.capabilities ? p.capabilities.duplex : null)
          : (p.reportedCapabilities ? p.reportedCapabilities.duplex : null),
        // What the computer itself said (true, false, or null: doesn't know).
        reportedColor: p.reportedCapabilities === undefined
          ? (p.capabilities ? p.capabilities.color : null)
          : (p.reportedCapabilities ? p.reportedCapabilities.color : null),
        capabilities: p.capabilities,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findPrinter(id) {
  return db.printers.find((p) => p.id === id) || null;
}

function canPrintTo(printer) {
  // Marked out of order at the office: still listed, never printed to.
  return !!printer && !printer.hidden && !printer.broken;
}

// --- WebSocket handling -------------------------------------------------

function handleConnection(socket) {
  let authenticated = false;

  // An agent that does not say hello with a valid token within 45 seconds
  // is dropped, so strangers cannot sit on a connection. (Not less: the
  // agent lists its printers before saying hello, and on Windows that can
  // take up to 20 seconds with network printers or a slow print spooler -
  // with 10 here, such a computer was dropped and retried for ever.)
  const helloTimer = setTimeout(() => {
    if (!authenticated) socket.close(4001, "No hello");
  }, 45000);

  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "hello") {
      const agent = typeof message.token === "string" ? findAgentByToken(message.token) : null;
      if (!agent) {
        socket.send(
          JSON.stringify({ type: "error", message: "Unknown agent token." })
        );
        socket.close(4003, "Bad token");
        return;
      }

      authenticated = true;
      clearTimeout(helloTimer);

      // If the same agent is already connected, drop the older connection.
      const existing = socketsByAgentId.get(agent.id);
      if (existing && existing !== socket) existing.close(4004, "Replaced");

      socketsByAgentId.set(agent.id, socket);
      agentIdBySocket.set(socket, agent.id);

      agent.lastSeenAt = Date.now();
      if (message.agentName) agent.name = String(message.agentName).slice(0, 60);
      agent.platform = message.platform || "unknown";
      agent.version = message.version || "";
      save();

      const printerList = Array.isArray(message.printers) ? message.printers : [];
      rememberPrinters(agent, printerList);

      socket.send(JSON.stringify({ type: "welcome", agentId: agent.id, agentName: agent.name }));
      console.log(
        "Printer computer online:",
        agent.name,
        "(" + agent.platform + ")",
        "printers:",
        printerList.map((p) => p && p.name).filter(Boolean).join(", ") || "none"
      );

      events.emit("agent-online", agent.id);
      return;
    }

    if (!authenticated) return;

    const agentId = agentIdBySocket.get(socket);

    // The agent re-sends its printer list when something changes.
    if (message.type === "printers") {
      const agent = db.agents.find((a) => a.id === agentId);
      if (agent) {
        rememberPrinters(agent, Array.isArray(message.printers) ? message.printers : []);
      }
      return;
    }

    // Jam, no paper, switched off... (agent/lib/health.js), every minute when it changes.
    if (message.type === "health") {
      if (Array.isArray(message.printers)) rememberHealth(agentId, message.printers);
      return;
    }

    // Job progress: queued -> downloading -> printing -> done / failed.
    if (message.type === "status") {
      events.emit("status", {
        agentId,
        jobId: message.jobId,
        status: message.status,
        message: message.message || "",
        nativeJobId: message.nativeJobId || "",
        noFailover: message.noFailover === true,
      });
      return;
    }
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    const agentId = agentIdBySocket.get(socket);
    agentIdBySocket.delete(socket);
    if (agentId && socketsByAgentId.get(agentId) === socket) {
      socketsByAgentId.delete(agentId);
      console.log("Printer computer offline:", agentId);
      events.emit("agent-offline", agentId);
    }
  });

  socket.on("error", () => {
    /* the close handler does the cleanup */
  });
}

// Ping every connected agent every 30 seconds. If one stops answering,
// the connection is dead and we clean it up.
function startHeartbeat(wss) {
  setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch (err) {
        /* ignore */
      }
    }
  }, 30000);
}

module.exports = {
  events,
  handleConnection,
  startHeartbeat,
  sendToAgent,
  disconnectAgent,
  isOnline,
  listPrinters,
  problemOf,
  listPrintersForManaging,
  findPrinter,
  canPrintTo,
  setColorMode,
  setDuplexMode,
  setPrinterType,
  persistSettings,
  rememberPrinters,
  setDisplayName,
  labelOf,
  kindOf,
  findAgentByToken,
  printerId,
};
