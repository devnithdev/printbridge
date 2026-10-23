// "Keep this computer's address the same": gives the main computer a fixed
// (static) network address on the computer itself, so the address on the
// wall sign keeps working after a power cut or a router restart. Offered by
// Windows Setup and the Mac setup page, main computer only.
//
// What it does:
//   detect()   finds the network connection this computer uses for the
//              internet (the one with the default route): its address,
//              mask, router (gateway), DNS servers, and whether the router
//              hands out its address (DHCP) or it is already fixed.
//   suggest()  picks a free address on the same network, high up (.200 to
//              .250), where routers rarely hand addresses out - checking that
//              nothing answers on it.
//   apply()    sets it (Windows: PowerShell's network commands; macOS:
//              networksetup), then checks the router still answers. If it
//              doesn't within about half a minute, the change is undone
//              (back to automatic), so this can never leave the computer
//              off the network.
//   restore()  back to automatic (DHCP). Used when the box is unticked on a
//              later Setup run and when uninstalling - but only for a fixed
//              address this program set, never one someone set by hand.
//
// What is changed is noted in install-record.json ("fixedAddress").
//
// The router doesn't know about an address fixed this way, so it could
// (rarely) hand the same address to another device - hence the high
// number and the in-use check. Reserving the address in the router as well
// is the only way to rule that out completely.

const os = require("os");
const { execFile } = require("child_process");
const P = require("./paths");

// --- addresses ---------------------------------------------------------------

function isIPv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text || "").trim());
  return !!m && m.slice(1).every((n) => parseInt(n, 10) <= 255 && String(parseInt(n, 10)) === n);
}
const toNum = (ip) => ip.split(".").reduce((n, p) => n * 256 + parseInt(p, 10), 0) >>> 0;
const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
const maskOf = (prefix) => (prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
const maskText = (prefix) => toIp(maskOf(prefix));
function prefixOf(mask) {
  if (!isIPv4(mask)) return 0;
  const bits = toNum(mask).toString(2);
  return /^1*0*$/.test(bits.padStart(32, "0")) ? (bits.match(/1/g) || []).length : 0;
}

// Why `address` can't be this computer's fixed address, or "" if it can.
function problemWith(address, info) {
  if (!isIPv4(address)) return "That isn't a network address (it looks like 192.168.1.200).";
  const mask = maskOf(info.prefix);
  const net = (toNum(info.address) & mask) >>> 0;
  const n = toNum(address);
  if ((n & mask) >>> 0 !== net >>> 0) return "That address isn't on this computer's network (" + toIp(net) + "/" + info.prefix + ").";
  const broadcast = (net | (~mask >>> 0)) >>> 0;
  if (n === net || n === broadcast) return "That address is reserved for the network itself; choose another.";
  if (address === info.gateway) return "That is the router's address; choose another.";
  return "";
}

// The addresses worth trying, best first: .200 to .250 in this computer's
// own block of 256 (inside its network), else the top of a small network.
function candidates(info) {
  const mask = maskOf(info.prefix);
  const net = (toNum(info.address) & mask) >>> 0;
  const broadcast = (net | (~mask >>> 0)) >>> 0;
  const out = [];
  const block = (toNum(info.address) & 0xffffff00) >>> 0;
  for (let h = 200; h <= 250; h++) {
    const n = (block + h) >>> 0;
    if (n > net && n < broadcast) out.push(toIp(n));
  }
  if (!out.length) for (let n = broadcast - 1; n > net && out.length < 30; n--) out.push(toIp(n));
  return out.filter((a) => a !== info.gateway && a !== info.address);
}

// --- running things ------------------------------------------------------------

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const clean = (t) => String(t || "").replace(/^﻿/, "").replace(/\u0000/g, "");
      resolve({ ok: !error, code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: clean(stdout), stderr: clean(stderr) });
    });
  });
}

function ps(script) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; " + script], 60000);
}
const psq = (t) => "'" + String(t).replace(/'/g, "''") + "'";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Does something answer at `ip`? (Windows' ping says "succeeded" even for
// "Destination host unreachable" coming back from this computer, so its
// answer is read instead of its exit code.)
async function answers(ip) {
  if (!isIPv4(ip)) return false;
  if (P.IS_WINDOWS) {
    const r = await run("ping.exe", ["-n", "1", "-w", "700", ip], 5000);
    return /TTL=/i.test(r.stdout);
  }
  const r = await run("/sbin/ping", ["-c", "1", "-t", "1", ip], 5000);
  return r.ok;
}

// Addresses the computer has recently seen a device at (the ARP table) -
// catches phones and printers that don't answer pings.
function parseArp(text) {
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const ip = (line.match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1];
    const mac = /([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i.test(line) && !/ff[:-]ff[:-]ff[:-]ff[:-]ff[:-]ff/i.test(line);
    if (ip && mac) seen.add(ip);
  }
  return seen;
}

// --- reading the current settings ---------------------------------------------

const WIN_DETECT = `
$ErrorActionPreference = 'SilentlyContinue'
$best = $null; $bm = 999999
foreach ($r in Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4) {
  $ipi = Get-NetIPInterface -InterfaceIndex $r.ifIndex -AddressFamily IPv4
  if ([string]$ipi.ConnectionState -ne 'Connected') { continue }
  $m = [int]$r.RouteMetric + [int]$ipi.InterfaceMetric
  if ($m -lt $bm) { $bm = $m; $best = $r }
}
if (-not $best) { '{}'; exit }
$i = $best.ifIndex
$ipi = Get-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4
$a = Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1
$ad = Get-NetAdapter -InterfaceIndex $i
$d = @((Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4).ServerAddresses)
[pscustomobject]@{ ifIndex = $i; alias = $ad.Name; desc = $ad.InterfaceDescription; media = [string]$ad.PhysicalMediaType;
  ip = $a.IPAddress; prefix = $a.PrefixLength; dhcp = ([string]$ipi.Dhcp -eq 'Enabled'); gateway = $best.NextHop; dns = $d } | ConvertTo-Json -Compress
`;

function parseWindows(json) {
  let o;
  try { o = JSON.parse(String(json || "").trim() || "{}"); } catch (err) { return { found: false }; }
  if (!o || !isIPv4(o.ip) || !isIPv4(o.gateway) || !(o.prefix > 0 && o.prefix < 31)) return { found: false };
  const dns = (Array.isArray(o.dns) ? o.dns : o.dns ? [o.dns] : []).filter(isIPv4);
  return {
    found: true, platform: "windows", ifIndex: o.ifIndex, adapter: String(o.alias || ""),
    wifi: /802\.11|wireless|wi-?fi|wlan/i.test(String(o.media) + " " + String(o.desc) + " " + String(o.alias)),
    address: o.ip, prefix: o.prefix, mask: maskText(o.prefix), gateway: o.gateway, dns, dhcp: !!o.dhcp,
  };
}

// macOS: networksetup names connections by "service" (Wi-Fi, Ethernet...).
function parseServiceOrder(text, device) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const m = /\(Hardware Port: (.*), Device: ([^)]*)\)/.exec(lines[i]);
    if (m && m[2].trim() === device) {
      const name = /^\(\*?\d+\)\s*(.+)$/.exec(lines[i - 1].trim());
      return { service: name ? name[1].trim() : m[1].trim(), port: m[1].trim() };
    }
  }
  return null;
}

function parseRoute(text) {
  return {
    gateway: (/gateway:\s*(\S+)/.exec(text) || [])[1] || "",
    device: (/interface:\s*(\S+)/.exec(text) || [])[1] || "",
  };
}

async function detectMac() {
  const route = parseRoute((await run("/sbin/route", ["-n", "get", "default"])).stdout);
  if (!route.device || !isIPv4(route.gateway)) return { found: false };
  const entry = (os.networkInterfaces()[route.device] || []).find((e) => (e.family === "IPv4" || e.family === 4) && !e.internal);
  if (!entry) return { found: false };
  const svc = parseServiceOrder((await run("/usr/sbin/networksetup", ["-listnetworkserviceorder"])).stdout, route.device);
  if (!svc) return { found: false };
  const getinfo = (await run("/usr/sbin/networksetup", ["-getinfo", svc.service])).stdout;
  let dns = (await run("/usr/sbin/networksetup", ["-getdnsservers", svc.service])).stdout.split(/\s+/).filter(isIPv4);
  if (!dns.length) dns = (await run("/usr/sbin/ipconfig", ["getoption", route.device, "domain_name_server"])).stdout.split(/\s+/).filter(isIPv4);
  const prefix = prefixOf(entry.netmask);
  if (!(prefix > 0 && prefix < 31)) return { found: false };
  return {
    found: true, platform: "mac", device: route.device, service: svc.service, adapter: svc.service,
    wifi: /wi-?fi|airport/i.test(svc.port), address: entry.address, prefix, mask: maskText(prefix),
    gateway: route.gateway, dns, dhcp: !/Manual Configuration/i.test(getinfo),
  };
}

// The current settings, plus whether the fixed address (if any) is ours.
async function detect() {
  let info = { found: false };
  try {
    if (P.IS_WINDOWS) info = parseWindows((await ps(WIN_DETECT)).stdout);
    else if (P.IS_MAC) info = await detectMac();
  } catch (err) { info = { found: false }; }
  const rec = P.readRecord().fixedAddress;
  info.ours = !!(info.found && rec && rec.address === info.address && !info.dhcp);
  return info;
}

// A free address to suggest, or "" if none was found.
async function suggest(info) {
  const list = candidates(info);
  const free = [];
  for (let i = 0; i < list.length && !free.length; i += 8) {
    const batch = list.slice(i, i + 8);
    const busy = await Promise.all(batch.map(answers));
    const arp = parseArp((await run(P.IS_WINDOWS ? "arp.exe" : "/usr/sbin/arp", ["-a", ...(P.IS_WINDOWS ? [] : ["-n"])], 8000)).stdout);
    batch.forEach((a, k) => { if (!busy[k] && !arp.has(a)) free.push(a); });
  }
  return free[0] || "";
}

// --- changing them -------------------------------------------------------------

async function setStatic(info, address) {
  const dns = (info.dns.length ? info.dns : [info.gateway]).slice(0, 2);
  if (P.IS_WINDOWS) {
    const r = await ps(`
$ErrorActionPreference = 'Stop'
$i = ${parseInt(info.ifIndex, 10)}
Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled
Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
Remove-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue
New-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress ${psq(address)} -PrefixLength ${parseInt(info.prefix, 10)} -DefaultGateway ${psq(info.gateway)} | Out-Null
Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses @(${dns.map(psq).join(",")})
'ok'`);
    return { ok: r.ok && /ok/.test(r.stdout), detail: (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-2).join(" ") };
  }
  const a = await run("/usr/sbin/networksetup", ["-setmanual", info.service, address, info.mask, info.gateway]);
  const b = await run("/usr/sbin/networksetup", ["-setdnsservers", info.service, ...dns]);
  return { ok: a.ok && b.ok, detail: (a.stderr || a.stdout || b.stderr).trim() };
}

async function setAutomatic(where) {
  if (P.IS_WINDOWS) {
    const r = await ps(`
$ErrorActionPreference = 'SilentlyContinue'
$i = ${parseInt(where.ifIndex, 10) || -1}
$byName = Get-NetAdapter -Name ${psq(where.adapter || "")}
if ($byName) { $i = $byName.ifIndex }
Remove-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -Confirm:$false
Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -PrefixOrigin Manual | Remove-NetIPAddress -Confirm:$false
Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled
Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses
ipconfig /renew | Out-Null
'ok'`);
    return r.ok && /ok/.test(r.stdout);
  }
  const a = await run("/usr/sbin/networksetup", ["-setdhcp", where.service]);
  await run("/usr/sbin/networksetup", ["-setdnsservers", where.service, "Empty"]);
  return a.ok;
}

function hasAddress(address) {
  return Object.values(os.networkInterfaces()).some((list) => (list || []).some((e) => e.address === address));
}

// Sets `address` (or the suggested one), checks the network still works,
// undoes it if not. Resolves { ok, address, message }.
async function apply(address, given) {
  const info = given || (await detect());
  if (!info.found) return { ok: false, message: "No network connection was found, so the address was left as it is." };
  if (!info.dhcp && !info.ours) {
    return { ok: true, address: info.address, message: "This computer already has a fixed address (" + info.address + "); it was left as it is." };
  }
  if (!address) address = info.ours ? info.address : await suggest(info);
  if (!address) return { ok: false, message: "No free address was found on this network, so the address was left automatic." };
  const problem = problemWith(address, info);
  if (problem) return { ok: false, message: problem + " The address was left as it was." };
  if (info.ours && address === info.address) {
    return { ok: true, address, message: "This computer's address stays fixed at " + address + "." };
  }
  if (address !== info.address && (await answers(address))) {
    return { ok: false, message: "Another device is already using " + address + ", so the address was left as it was. Choose another one." };
  }

  const routerAnswered = await answers(info.gateway);
  const set = await setStatic(info, address);
  let works = false;
  if (set.ok) {
    // Wi-Fi in particular can take a few seconds to settle.
    for (let i = 0; i < 15 && !works; i++) {
      await wait(2000);
      works = hasAddress(address) && (!routerAnswered || (await answers(info.gateway)));
    }
  }
  if (!works) {
    await setAutomatic(info);
    return { ok: false, message: "The fixed address " + address + " didn't work on this network" + (set.detail ? " (" + set.detail + ")" : "") + ", so it was changed back to automatic." };
  }
  P.updateRecord({
    fixedAddress: {
      address, prefix: info.prefix, gateway: info.gateway, dns: info.dns, adapter: info.adapter,
      ifIndex: info.ifIndex || 0, service: info.service || "", device: info.device || "", wifi: !!info.wifi, at: Date.now(),
    },
  });
  return { ok: true, address, message: "This computer's address is now fixed at " + address + " (it was " + info.address + ")." };
}

// Back to automatic - only if the fixed address is the one this program set.
async function restore() {
  const rec = P.readRecord().fixedAddress;
  if (!rec) return { ok: true, message: "" };
  const info = await detect();
  if (info.found && info.address !== rec.address) {
    P.updateRecord({ fixedAddress: null });
    return { ok: true, message: "The network address was changed by someone since, so it was left as it is." };
  }
  const ok = await setAutomatic(rec);
  if (ok) P.updateRecord({ fixedAddress: null });
  return { ok, message: ok ? "This computer's network address is automatic again." : "Couldn't set the network address back to automatic; do it in the network settings." };
}

module.exports = { detect, suggest, apply, restore, problemWith, candidates, parseWindows, parseServiceOrder, parseRoute, parseArp, isIPv4, prefixOf, maskText };
