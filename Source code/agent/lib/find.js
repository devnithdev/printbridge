// Finding the printing website on the office network, so nobody has to
// type its address into a printer computer.
//
// Two ways, quickest first:
//
//   1. Ask out loud. One small message is sent to the whole office network
//      (a UDP broadcast on port 39276): "is the printing website here?".
//      The main computer answers with where it is and its permanent id.
//      This takes about a second and works whatever address the main
//      computer was given today (after a power cut or a router restart).
//   2. Knock on every door. If nobody answered (an older main computer that
//      doesn't listen yet, or a network that blocks broadcasts), it looks at
//      this computer's own network address (for example 192.168.1.37),
//      knocks on port 3000 of every neighbour on the same network
//      (192.168.1.1 to 192.168.1.254), and asks each one that answers "are
//      you the office printing website?". A whole office network takes a
//      few seconds.
//
// startResponder() is the main computer's side of 1 (see server.js).

const os = require("os");
const net = require("net");
const http = require("http");
const dgram = require("dgram");

const PORT = 3000;
const DISCOVERY_PORT = parseInt(process.env.OP_DISCOVERY_PORT, 10) || 39276;
const QUESTION = "PRINTBRIDGE-WHERE?1";
const ANSWER_APP = "office-printing";

function ipToNumber(ip) {
  return ip.split(".").reduce((n, part) => (n * 256) + parseInt(part, 10), 0) >>> 0;
}

function numberToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function prefixLength(netmask) {
  return ipToNumber(netmask).toString(2).replace(/0+$/, "").length;
}

// Every address worth knocking on. Big company networks can be huge, so at
// most 1,022 neighbours (a /22) are tried around each of this computer's own
// addresses - which covers any ordinary office.
function neighbourAddresses() {
  const out = new Set();
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] || []) {
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue; // "no network" address

      const bits = Math.max(prefixLength(entry.netmask || "255.255.255.0"), 22);
      if (bits >= 31) continue;
      const size = 2 ** (32 - bits);
      const start = (ipToNumber(entry.address) & (~(size - 1) >>> 0)) >>> 0;

      for (let i = 1; i < size - 1; i++) out.add(numberToIp(start + i));
    }
  }
  return [...out];
}

// Is anything listening on this address's port 3000? Gives up quickly,
// because almost every neighbour won't be.
function portIsOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function getJson(host, port, pathName, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: pathName, timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          resolve(null);
        }
      });
      response.on("error", () => resolve(null));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

// Asks one address whether it is the printing website. Newer websites say
// so directly (and give their permanent id); older ones are recognised by
// the shape of their /api/hello answer.
async function identify(host, port) {
  const about = await getJson(host, port, "/api/office-printing", 2500);
  if (about && about.app === "office-printing") {
    return Object.assign({ host, port, httpBase: "http://" + host + ":" + port, id: about.id || "", name: about.name || "", older: false }, takeoverFacts(about));
  }
  const hello = await getJson(host, port, "/api/hello", 2500);
  if (hello && Array.isArray(hello.printers) && "maxUploadMb" in hello) {
    return { host, port, httpBase: "http://" + host + ":" + port, id: "", name: "", older: true, version: "", claimAt: 0, canStepDown: false };
  }
  return null;
}

// "Make this the only main computer" (see watchForTakeover in server.js):
// a main computer that was told so by Setup says when (claimAt). Main
// computers that understand this answer with a claimAt number - 0 if they
// never claimed - so canStepDown tells the ones that will switch off by
// themselves apart from older versions that won't.
function takeoverFacts(about) {
  const has = typeof about.claimAt === "number";
  return {
    version: String(about.version || ""),
    claimAt: has && isFinite(about.claimAt) ? about.claimAt : 0,
    canStepDown: has,
  };
}

// Every broadcast address worth asking: the whole-network one, plus each
// network this computer is on (some routers only pass the latter).
function broadcastAddresses() {
  const out = new Set(["255.255.255.255"]);
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] || []) {
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (entry.internal || entry.address.startsWith("169.254.")) continue;
      const mask = ipToNumber(entry.netmask || "255.255.255.0");
      out.add(numberToIp(((ipToNumber(entry.address) & mask) | (~mask >>> 0)) >>> 0));
    }
  }
  return [...out];
}

// Way 1: ask the whole network at once and collect the answers for a moment.
function askNetwork(options) {
  const opts = options || {};
  const waitMs = opts.waitMs || 2500;
  const targets = opts.targets || broadcastAddresses();
  const port = opts.discoveryPort || DISCOVERY_PORT;
  return new Promise((resolve) => {
    const found = new Map();
    let socket;
    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch (err) {
      return resolve([]);
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch (err) { /* already closed */ }
      resolve([...found.values()]);
    };
    socket.on("error", finish);
    socket.on("message", (msg, rinfo) => {
      let about;
      try { about = JSON.parse(msg.toString("utf8")); } catch (err) { return; }
      if (!about || about.app !== ANSWER_APP) return;
      const webPort = parseInt(about.port, 10) || PORT;
      // The address it answered from is the one that reaches it from here.
      const host = rinfo.address;
      const key = (about.id || host) + "@" + host;
      if (!found.has(key)) {
        found.set(key, Object.assign({ host, port: webPort, httpBase: "http://" + host + ":" + webPort, id: about.id || "", name: about.name || "", older: false, via: "ask" }, takeoverFacts(about)));
      }
    });
    socket.bind(0, () => {
      try { socket.setBroadcast(true); } catch (err) { return finish(); }
      const question = Buffer.from(QUESTION);
      // Asked three times, a little apart: busy or power-saving Wi-Fi often
      // drops (or delays) a lone broadcast, and one lost message must not
      // mean "not found".
      const send = () => {
        for (const target of targets) {
          try { socket.send(question, port, target, () => {}); } catch (err) { /* next one */ }
        }
      };
      send();
      setTimeout(() => { if (!finished) send(); }, Math.min(500, waitMs / 4));
      setTimeout(() => { if (!finished) send(); }, Math.min(1200, waitMs / 2));
      setTimeout(finish, waitMs);
    });
  });
}

// The main computer's side of way 1: answers "is the printing website
// here?" with how to reach it. about() is asked each time, so the answer is
// always current. Returns a function that stops answering.
function startResponder(about, options) {
  const opts = options || {};
  const port = opts.discoveryPort || DISCOVERY_PORT;
  const log = opts.log || (() => {});
  let socket = null;
  let stopped = false;
  let retryTimer = null;

  const open = () => {
    if (stopped) return;
    socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (msg, rinfo) => {
      if (msg.toString("utf8").trim() !== QUESTION) return;
      let answer;
      try {
        answer = Buffer.from(JSON.stringify(Object.assign({ app: ANSWER_APP }, about())));
      } catch (err) {
        return;
      }
      socket.send(answer, rinfo.port, rinfo.address, () => {});
    });
    socket.on("error", (err) => {
      // For example the port is taken for a moment after a restart. The
      // printing website works without this (other computers then find it
      // the slower way), so just try again in a minute.
      log("Network answering paused (" + err.message + "); trying again in a minute.");
      try { socket.close(); } catch (e) { /* already closed */ }
      socket = null;
      if (!stopped) retryTimer = setTimeout(open, 60000);
    });
    socket.bind(port, () => log("Answering searches from other computers (UDP " + port + ")."));
  };
  open();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (socket) try { socket.close(); } catch (err) { /* already closed */ }
  };
}

// Way 2: knock on every neighbour's port 3000.
async function scanNetwork(opts) {
  const port = opts.port || PORT;
  const hosts = opts.hosts || neighbourAddresses();
  const timeoutMs = opts.timeoutMs || 1200; // 600 ms missed the main computer on slow Wi-Fi
  const parallel = opts.parallel || 96;

  const open = [];
  let next = 0;
  async function worker() {
    while (next < hosts.length) {
      const host = hosts[next++];
      if (await portIsOpen(host, port, timeoutMs)) open.push(host);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, hosts.length) }, worker));

  const found = [];
  for (const host of open) {
    const server = await identify(host, port);
    if (server) found.push(server);
  }
  return found;
}

// Returns every printing website found, e.g.
//   [{ host: "192.168.1.20", httpBase: "http://192.168.1.20:3000", id: "srv_...", ... }]
// options:
//   tcp: false   only ask (way 1); never knock on every door
//   udp: false   only knock (way 2)
//   hosts        addresses to knock on, for testing (implies udp: false)
//   alwaysScan   knock on every door even when the question was answered
async function findServers(options) {
  const opts = options || {};
  let found = [];
  if (opts.udp !== false && !opts.hosts) {
    found = await askNetwork(opts);
  }
  if ((found.length === 0 || opts.alwaysScan) && opts.tcp !== false) {
    // With alwaysScan (Setup's search), both ways are used, so main computers
    // too old to answer the question are found as well.
    found = found.concat(await scanNetwork(opts));
  }
  // The same website can answer on two of this computer's networks (Wi-Fi
  // and cable); keep one answer per website, the first address it gave.
  const seen = new Set();
  found = found.filter((f) => {
    const key = f.id || f.httpBase;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  found.sort((a, b) => ipToNumber(a.host) - ipToNumber(b.host));
  return found;
}

module.exports = { findServers, identify, neighbourAddresses, askNetwork, startResponder, broadcastAddresses, DISCOVERY_PORT, QUESTION };
