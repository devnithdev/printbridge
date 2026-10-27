// "Keep this computer's address the same" (4.1.3+): reading Windows' and
// macOS's network settings, choosing a sensible free address, refusing a
// bad one. (Changing the address itself needs a real Windows or Mac.)
const assert = require("assert"), path = require("path"), os = require("os"), fs = require("fs");
process.env.OP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pbfix-"));
const F = require(path.join(__dirname, "..", "desktop", "lib", "fixip"));
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };

const win = F.parseWindows(JSON.stringify({ ifIndex: 12, alias: "Ethernet", desc: "Intel(R) Ethernet Connection", media: "802.3", ip: "192.168.1.37", prefix: 24, dhcp: true, gateway: "192.168.1.1", dns: ["192.168.1.1", "8.8.8.8"] }));
ok(win.found && win.address === "192.168.1.37" && win.mask === "255.255.255.0" && win.gateway === "192.168.1.1" && win.dhcp && !win.wifi && win.dns.length === 2, "Windows: the internet connection's address, mask, router, DNS and DHCP are read");
const wifi = F.parseWindows(JSON.stringify({ ifIndex: 7, alias: "Wi-Fi", desc: "Intel(R) Wi-Fi 6 AX201", media: "Native 802.11", ip: "10.0.5.20", prefix: 22, dhcp: false, gateway: "10.0.4.1", dns: "10.0.4.1" }));
ok(wifi.found && wifi.wifi && !wifi.dhcp && wifi.dns[0] === "10.0.4.1" && wifi.mask === "255.255.252.0", "Windows: Wi-Fi is recognised, a single DNS server and a /22 network are read");
ok(!F.parseWindows("{}").found && !F.parseWindows("not json").found && !F.parseWindows(JSON.stringify({ ip: "169.254.3.4" })).found, "Windows: no connection (or nonsense) means nothing is offered");

const order = "An asterisk (*) denotes that a network service is disabled.\n(1) USB 10/100/1000 LAN\n(Hardware Port: USB 10/100/1000 LAN, Device: en7)\n\n(2) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n";
const svc = F.parseServiceOrder(order, "en0");
ok(svc && svc.service === "Wi-Fi" && svc.port === "Wi-Fi" && F.parseServiceOrder(order, "en7").service === "USB 10/100/1000 LAN", "macOS: the network service for the connection in use is found by its device");
const route = F.parseRoute("   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.0.1\n  interface: en0\n");
ok(route.gateway === "192.168.0.1" && route.device === "en0", "macOS: the router and connection come from the default route");

const arp = F.parseArp("? (192.168.1.200) at 3c:22:fb:1:2:3 on en0 ifscope [ethernet]\n? (192.168.1.201) at (incomplete) on en0 ifscope [ethernet]\n  192.168.1.202         a4-5e-60-11-22-33     dynamic\n  192.168.1.255         ff-ff-ff-ff-ff-ff     static\n");
ok(arp.has("192.168.1.200") && arp.has("192.168.1.202") && !arp.has("192.168.1.201") && !arp.has("192.168.1.255"), "devices seen recently (the ARP table, macOS and Windows) count as using an address");

const c = F.candidates(win);
ok(c[0] === "192.168.1.200" && c[c.length - 1] === "192.168.1.250" && !c.includes("192.168.1.37"), "suggested addresses are .200-.250 on the same network");
const small = F.candidates({ address: "192.168.1.130", prefix: 26, gateway: "192.168.1.129" });
ok(small.length && small.every((a) => { const h = +a.split(".")[3]; return h > 128 && h < 191; }) && small[0] === "192.168.1.190", "on a small network the suggestion stays inside it (top of the range)");

ok(F.problemWith("192.168.1.200", win) === "", "a free address on the same network is accepted");
ok(/isn't on this computer's network/.test(F.problemWith("192.168.2.200", win)), "an address on another network is refused");
ok(/router's address/.test(F.problemWith("192.168.1.1", win)) && /reserved/.test(F.problemWith("192.168.1.255", win)) && /reserved/.test(F.problemWith("192.168.1.0", win)), "the router's, network's and broadcast addresses are refused");
ok(/isn't a network address/.test(F.problemWith("192.168.1.300", win)) && /isn't a network address/.test(F.problemWith("192.168.1.20; rm -rf /", win)), "anything that isn't a plain address is refused (so nothing odd reaches the system commands)");
ok(F.prefixOf("255.255.255.0") === 24 && F.prefixOf("255.255.252.0") === 22 && F.prefixOf("255.0.255.0") === 0, "masks convert to prefix lengths (and a broken mask is rejected)");

(async () => {
  // When no connection is found, nothing is changed.
  const r = await F.apply("", { found: false });
  ok(r.ok === false && /No network connection was found/.test(r.message), "where the network can't be read, nothing is changed and it says so");
  ok((await F.restore()).ok, "restoring when Setup never fixed an address does nothing");
  console.log(n + " checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
