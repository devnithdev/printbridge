// A stand-in printing website: just enough for an agent to find it, register and connect.
const http = require("http");
const { WebSocketServer } = require("ws");
const find = require(require("path").join(__dirname, "..") + "/agent/lib/find");
const port = parseInt(process.argv[2], 10), id = process.argv[3];
const tokens = new Set();
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/office-printing") return res.end(JSON.stringify({ app: "office-printing", id, name: "MAIN-PC", version: "4.1.1" }));
  if (req.url === "/api/manage/computers" && req.method === "POST") { const t = "tok-" + Math.random().toString(36).slice(2); tokens.add(t); return res.end(JSON.stringify({ token: t })); }
  if (req.url.startsWith("/api/uploads/printout")) { let n = 0; req.on("data", (c) => n += c.length); req.on("end", () => { console.log("PRINTOUT " + n); res.end(JSON.stringify({ openUrl: "/?held=1" })); }); return; }
  res.statusCode = 404; res.end("{}");
});
const wss = new WebSocketServer({ server, path: "/agent" });
wss.on("connection", (ws) => ws.on("message", (d) => { const m = JSON.parse(d); if (m.type === "hello") { if (!tokens.has(m.token) && !process.env.ACCEPT_ANY) return ws.close(4003, "unknown"); console.log("HELLO " + m.agentName); ws.send(JSON.stringify({ type: "welcome", agentName: m.agentName })); } }));
server.listen(port, () => console.log("WEB " + port + " " + id));
if (!process.env.NO_ANSWER) find.startResponder(() => ({ id, name: "MAIN-PC", port }));
