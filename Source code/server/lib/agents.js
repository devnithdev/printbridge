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
const { db, save } = require("./store");
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

// Save (or update) what an agent told us about its printers.
function rememberPrinters(agent, printers) {
  const seen = new Set();

  for (const incoming of printers) {
    const name = String(incoming.name || "").trim();
    if (!name) continue;
    const id = printerId(agent.id, name);
    seen.add(id);

    let record = db.printers.find((p) => p.id === id);
    if (!record) {
      record = {
        id,
        agentId: agent.id,
        name,
        hidden: false,
        capabilities: null,
        updatedAt: 0,
      };
      db.printers.push(record);
    }
    record.capabilities = incoming.capabilities || null;
    record.updatedAt = Date.now();
  }

  // Printers that vanished from the agent (unplugged, removed) are forgotten,
  // but only for this agent.
  for (let i = db.printers.length - 1; i >= 0; i--) {
    const p = db.printers[i];
    if (p.agentId === agent.id && !seen.has(p.id)) db.printers.splice(i, 1);
  }

  save();
  events.emit("printers-changed");
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
        name: p.name,
        computerName: agent ? agent.name : "unknown",
        agentId: p.agentId,
        online: isOnline(p.agentId),
        capabilities: p.capabilities,
      };
    })
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
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
        computerName: agent ? agent.name : "unknown",
        agentId: p.agentId,
        online: isOnline(p.agentId),
        hidden: !!p.hidden,
        capabilities: p.capabilities,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findPrinter(id) {
  return db.printers.find((p) => p.id === id) || null;
}

function canPrintTo(printer) {
  return !!printer && !printer.hidden;
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

    if (message.type === "hello") {
      const agent = findAgentByToken(message.token);
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

      rememberPrinters(agent, Array.isArray(message.printers) ? message.printers : []);

      socket.send(JSON.stringify({ type: "welcome", agentId: agent.id, agentName: agent.name }));
      console.log(
        "Printer computer online:",
        agent.name,
        "(" + agent.platform + ")",
        "printers:",
        (message.printers || []).map((p) => p.name).join(", ") || "none"
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
  isOnline,
  listPrinters,
  listPrintersForManaging,
  findPrinter,
  canPrintTo,
  findAgentByToken,
  printerId,
};
