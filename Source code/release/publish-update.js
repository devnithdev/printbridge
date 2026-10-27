#!/usr/bin/env node
// Publishing a new version for automatic updates (see desktop/lib/updater.js).
// Normally run through PUBLISH-UPDATE.command, next to BUILD-ALL.command.
//
//   node publish-update.js keygen           make the signing key (once, ever)
//   node publish-update.js sign [--notes "What's new"] [--paused]
//                                           make latest.json + its signature for
//                                           the installers just built
//   node publish-update.js upload           put them on GitHub as a new release
//                                           (needs the "gh" tool, signed in)
//   node publish-update.js all              sign, then upload
//   node publish-update.js bump 4.1.4       raise the version number everywhere
//                                           it is written (do this first, then build)
//
// Options:  --key FILE    the private key (default: the folder below)
//           --repo O/R    the GitHub repository (default: from update-config.js)
//           --relative    installers listed by name only, for hosting all the
//                         files together on your own website
//
// THE PRIVATE KEY: made once by "keygen", in
//   ~/Documents/PrintBridge update key (keep secret)/printbridge-update-key.pem
// Every computer only installs versions signed with it. Keep a copy somewhere
// safe (a USB stick in a drawer, a password manager). If it is lost, new
// versions can't be published to existing computers any more: they would
// each need the new Setup run on them by hand, once. If someone else gets
// it, they could publish a version of their own - make a new key, build,
// and run the new Setup by hand on every computer.
//
// Uses only what comes with Node.js (16 or newer).

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { execFileSync, spawnSync } = require("child_process");

const SRC = path.join(__dirname, "..");
const KEY_FILE_JS = path.join(SRC, "desktop", "lib", "update-key.js");
const CONFIG = require(path.join(SRC, "desktop", "lib", "update-config.js"));
const DEFAULT_KEY = path.join(os.homedir(), "Documents", "PrintBridge update key (keep secret)", "printbridge-update-key.pem");

const args = process.argv.slice(2);
const command = (args[0] && !args[0].startsWith("--") ? args.shift() : "all").toLowerCase();
const opt = (name, fallback) => {
  const i = args.indexOf("--" + name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const say = (t) => console.log(t);
function stop(text) {
  console.error("\nSTOPPED: " + text + "\n");
  process.exit(1);
}

function version() {
  // Read as text so a stale require cache can never give an old number.
  const m = /VERSION:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(SRC, "desktop", "lib", "version.js"), "utf8"));
  if (!m) stop("couldn't read the version from desktop/lib/version.js");
  return m[1];
}

// Every place the version is written must agree, or computers would keep
// "updating" to a version that reports a different number.
function checkVersionEverywhere(v) {
  const places = [
    ["desktop/package.json", /"version":\s*"([^"]+)"/],
    ["server/package.json", /"version":\s*"([^"]+)"/],
    ["agent/package.json", /"version":\s*"([^"]+)"/],
    ["server/server.js", /const VERSION = "([^"]+)"/],
    ["agent/agent.js", /const VERSION = "([^"]+)"/],
    ["installer/OfficePrinting.nsi", /!define VERSION "([^"]+)"/],
    ["desktop/tools/relabel-exe/relabel-exe.js", /FileVersion: "([^"]+)"/],
  ];
  const wrong = [];
  for (const [file, re] of places) {
    let text = "";
    try { text = fs.readFileSync(path.join(SRC, file), "utf8"); } catch (err) { continue; }
    const m = re.exec(text);
    if (m && m[1] !== v) wrong.push(file + " says " + m[1]);
  }
  if (wrong.length) stop("desktop/lib/version.js says " + v + ", but " + wrong.join(", ") + ".\nRun \"node publish-update.js bump " + v + "\", build again, then publish.");
}

function publicKeysInBuild() {
  const text = fs.readFileSync(KEY_FILE_JS, "utf8");
  return (text.match(/"([A-Za-z0-9+/=]{40,})"/g) || []).map((s) => s.slice(1, -1));
}

function spkiOf(privateKey) {
  return crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
}

function readPrivateKey(file) {
  if (!fs.existsSync(file)) stop("the signing key isn't at " + file + ".\nIf this is the first time, run:  node publish-update.js keygen");
  return crypto.createPrivateKey(fs.readFileSync(file));
}

function keygen() {
  const file = path.resolve(opt("key", DEFAULT_KEY));
  if (fs.existsSync(file)) {
    const pub = spkiOf(readPrivateKey(file));
    if (!publicKeysInBuild().includes(pub)) addPublicKey(pub);
    say("The signing key already exists (" + file + "). Nothing new was made.");
    return;
  }
  const existing = publicKeysInBuild();
  if (existing.length && !opt("force", false)) {
    stop("this source code already trusts a signing key, but its private key isn't at " + file + ".\n" +
      "Point to it with --key FILE. Only if it is truly lost, run keygen again with --force: computers\n" +
      "already installed would then need the new Setup run on them by hand, once.");
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  fs.writeFileSync(path.join(path.dirname(file), "READ ME.txt"),
    "PrintBridge update signing key - made " + new Date().toISOString().slice(0, 10) + "\n\n" +
    "printbridge-update-key.pem signs every new version of PrintBridge. Computers only install\n" +
    "versions signed with it.\n\n" +
    "- Keep a copy somewhere safe and offline (a USB stick in a drawer, or a password manager).\n" +
    "- Never put it in the source code folder, email it, or upload it anywhere.\n" +
    "- If it is lost: make a new one (publish-update.js keygen --force), build, and run the new Setup\n" +
    "  by hand on every computer once. If someone else may have it: do the same, straight away.\n");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  addPublicKey(pub, existing.length && opt("force", false));
  say("Made the signing key:\n  " + file + "\nand put its public half in desktop/lib/update-key.js.");
  say("BACK IT UP NOW (see READ ME.txt next to it). Then build (BUILD-ALL.command): only builds made from now on can update themselves.");
}

function addPublicKey(pub, replace) {
  let text = fs.readFileSync(KEY_FILE_JS, "utf8");
  const keys = replace ? [] : publicKeysInBuild();
  if (!keys.includes(pub)) keys.push(pub);
  text = text.replace(/PUBLIC_KEYS:\s*\[[\s\S]*?\]/, "PUBLIC_KEYS: [\n" + keys.map((k) => '    "' + k + '",').join("\n") + "\n  ]");
  fs.writeFileSync(KEY_FILE_JS, text);
}

// Writes the new version number into every file that carries it.
function bump(next) {
  if (!/^\d{1,4}(\.\d{1,4}){1,3}$/.test(String(next || ""))) stop("give the new version number, for example:  node publish-update.js bump 4.1.4");
  const v = version();
  const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
  if (cmp(next, v) <= 0) stop("the new version must be higher than " + v + ".");
  const esc = (t) => t.replace(/[.]/g, "\\.");
  const edits = [
    ["desktop/lib/version.js", new RegExp('VERSION: "' + esc(v) + '"'), 'VERSION: "' + next + '"'],
    ["desktop/package.json", new RegExp('"version": "' + esc(v) + '"'), '"version": "' + next + '"'],
    ["server/package.json", new RegExp('"version": "' + esc(v) + '"'), '"version": "' + next + '"'],
    ["agent/package.json", new RegExp('"version": "' + esc(v) + '"'), '"version": "' + next + '"'],
    ["server/server.js", new RegExp('const VERSION = "' + esc(v) + '"'), 'const VERSION = "' + next + '"'],
    ["agent/agent.js", new RegExp('const VERSION = "' + esc(v) + '"'), 'const VERSION = "' + next + '"'],
    ["installer/OfficePrinting.nsi", new RegExp('!define VERSION "' + esc(v) + '"'), '!define VERSION "' + next + '"'],
    ["desktop/tools/relabel-exe/relabel-exe.js", new RegExp('"' + esc(v) + '"', "g"), '"' + next + '"'],
    ["BUILD-ON-MAC.txt", new RegExp("PrintBridge-" + esc(v) + "\\.dmg", "g"), "PrintBridge-" + next + ".dmg"],
    ["installer-mac/BUILD-ON-MAC.txt", new RegExp("PrintBridge-" + esc(v) + "\\.dmg", "g"), "PrintBridge-" + next + ".dmg"],
  ];
  for (const [file, re, to] of edits) {
    const full = path.join(SRC, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    if (!re.test(text)) { say("  (no version number found in " + file + ")"); continue; }
    re.lastIndex = 0;
    fs.writeFileSync(full, text.replace(re, to));
    say("  " + file);
  }
  say("Version is now " + next + ". Build (BUILD-ALL.command), test it on one computer, then publish (PUBLISH-UPDATE.command).");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// "owner/repo" from the manifest address, if it is a GitHub release address.
function githubRepo() {
  const given = opt("repo", "");
  if (given && given !== true) return given;
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\//.exec(CONFIG.MANIFEST_URL);
  return m ? m[1] : "";
}

function releaseDir(v) {
  return path.join(SRC, "..", "Updates", v);
}

function get(url, redirects) {
  return new Promise((resolve) => {
    https.get(url, { headers: { "User-Agent": "PrintBridge-publish" }, timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (redirects || 0) < 6) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), (redirects || 0) + 1));
      }
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(res.statusCode === 200 ? body : null));
    }).on("error", () => resolve(null)).on("timeout", function () { this.destroy(); });
  });
}

async function sign() {
  const v = version();
  checkVersionEverywhere(v);
  const key = readPrivateKey(path.resolve(opt("key", DEFAULT_KEY)));
  const pub = spkiOf(key);
  if (!publicKeysInBuild().includes(pub)) {
    stop("this signing key isn't the one in desktop/lib/update-key.js, so computers would ignore the update.\n" +
      "Use the right key with --key FILE.");
  }

  // Never publish the same or an older version again (computers ignore it).
  const live = await get(CONFIG.MANIFEST_URL);
  if (live) {
    try {
      const lv = JSON.parse(live).version;
      const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
      // (--paused re-signs the version already out, to hold back the computers that haven't installed it yet.)
      if (cmp(v, lv) <= 0 && !(opt("paused", false) && cmp(v, lv) === 0)) stop("version " + lv + " is already published, and this is " + v + ".\nRaise the version number (node publish-update.js bump <version>), build again, then publish.");
      say("Published now: " + lv + ". Publishing: " + v + ".");
    } catch (err) { /* not readable: carry on */ }
  } else {
    say("No published version found yet at " + CONFIG.MANIFEST_URL + " (fine for the first one).");
  }

  const installers = [
    ["windows", path.join(SRC, "installer", "dist", "PrintBridgeSetup.exe")],
    ["mac", path.join(SRC, "installer-mac", "dist", "PrintBridge.pkg")],
  ].filter(([, f]) => fs.existsSync(f) && fs.statSync(f).size > 0);
  if (!installers.length) stop("no installers found. Build first (BUILD-ALL.command), then publish.");

  // A build from before the version was raised would keep reinstalling itself.
  const versionAt = fs.statSync(path.join(SRC, "desktop", "lib", "version.js")).mtimeMs;
  for (const [, f] of installers) {
    if (fs.statSync(f).mtimeMs < versionAt) stop(path.basename(f) + " is older than the version number change. Build again (BUILD-ALL.command), then publish.");
  }

  const repo = githubRepo();
  const out = releaseDir(v);
  fs.mkdirSync(out, { recursive: true });
  const files = {};
  for (const [platform, f] of installers) {
    const name = path.basename(f);
    fs.copyFileSync(f, path.join(out, name));
    files[platform] = {
      // --relative: next to latest.json, wherever it is put (own website).
      url: repo && !opt("relative", false) ? "https://github.com/" + repo + "/releases/download/v" + v + "/" + encodeURIComponent(name) : name,
      sha256: sha256(f),
      size: fs.statSync(f).size,
    };
  }
  const dmg = path.join(SRC, "installer-mac", "dist", "PrintBridge-" + v + ".dmg");
  if (fs.existsSync(dmg) && fs.statSync(dmg).size > 0) {
    fs.copyFileSync(dmg, path.join(out, path.basename(dmg)));
  }
  const notes = opt("notes", "");
  const manifest = {
    app: "printbridge",
    version: v,
    released: new Date().toISOString().slice(0, 10),
    notes: notes === true ? "" : String(notes),
    spreadMinutes: 30,
    files,
  };
  if (opt("paused", false)) manifest.paused = true;
  const body = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const signature = crypto.sign(null, body, key);
  if (!crypto.verify(null, body, crypto.createPublicKey(key), signature)) stop("the signature didn't check out");
  fs.writeFileSync(path.join(out, "latest.json"), body);
  fs.writeFileSync(path.join(out, "latest.json.sig"), signature.toString("base64") + "\n");
  say("\nReady to publish, in " + out + ":");
  for (const n of fs.readdirSync(out)) say("  " + n);
  say("Covers: " + Object.keys(files).join(" and ") + (installers.length < 2 ? "  (only this one was built - the other kind of computer won't update this time)" : ""));
  return { v, out, repo };
}

function gitCredentialToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const r = spawnSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      timeout: 5000,
    });
    if (r.status === 0 && r.stdout) {
      const m = /^password=(.+)$/m.exec(r.stdout);
      if (m) return m[1].trim();
    }
  } catch (err) { /* no credential helper */ }
  return "";
}

function sourceRepo() {
  try {
    const r = spawnSync("git", ["-C", SRC, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && r.stdout) {
      const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\s*$/.exec(r.stdout);
      if (m) return m[1];
    }
  } catch (err) { /* not a git checkout */ }
  return "";
}

function ghRequest(method, urlStr, token, bodyBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = {
      "User-Agent": "PrintBridge-publish",
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (bodyBuffer) {
      headers["Content-Type"] = contentType || "application/json; charset=utf-8";
      headers["Content-Length"] = bodyBuffer.length;
    }
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers,
      timeout: 300000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* plain text */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

async function publishToRepoWithApi(repo, v, title, notes, assets, token) {
  say("Publishing release v" + v + " on github.com/" + repo + "...");
  const tag = "v" + v;
  let rel = await ghRequest("GET", "https://api.github.com/repos/" + repo + "/releases/tags/" + encodeURIComponent(tag), token);
  if (rel.status === 404) {
    const payload = Buffer.from(JSON.stringify({
      tag_name: tag,
      name: title,
      body: notes,
      draft: false,
      prerelease: false,
      make_latest: "true",
    }));
    rel = await ghRequest("POST", "https://api.github.com/repos/" + repo + "/releases", token, payload);
  }
  if (rel.status < 200 || rel.status >= 300 || !rel.json || !rel.json.upload_url) {
    throw new Error("GitHub API (" + repo + ") answered " + rel.status + ": " + (rel.json && rel.json.message ? rel.json.message : rel.text.slice(0, 200)));
  }
  const uploadBase = rel.json.upload_url.replace(/\{[^}]*\}.*$/, "");
  const existing = Array.isArray(rel.json.assets) ? rel.json.assets : [];

  for (const file of assets) {
    const name = path.basename(file);
    const old = existing.find((a) => a.name === name);
    if (old && old.id) {
      await ghRequest("DELETE", "https://api.github.com/repos/" + repo + "/releases/assets/" + old.id, token);
    }
    const data = fs.readFileSync(file);
    say("  Uploading " + name + " (" + Math.max(1, Math.round(data.length / 1024)) + " KB)...");
    const up = await ghRequest("POST", uploadBase + "?name=" + encodeURIComponent(name), token, data, "application/octet-stream");
    if (up.status < 200 || up.status >= 300) {
      throw new Error("Failed to upload " + name + " to " + repo + " (" + up.status + "): " + up.text.slice(0, 200));
    }
  }
}

async function upload(info) {
  const v = info ? info.v : version();
  const out = info ? info.out : releaseDir(v);
  const repo = info ? info.repo : githubRepo();
  if (!fs.existsSync(path.join(out, "latest.json.sig"))) stop("nothing signed for " + v + " yet. Run sign first.");
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "latest.json"), "utf8"));
  const assets = fs.readdirSync(out).map((n) => path.join(out, n));
  if (!repo) {
    say("\nUpload every file in " + out + " so that latest.json and latest.json.sig are at\n  " + CONFIG.MANIFEST_URL + "\n(with the installers next to them).");
    return;
  }

  // Publish to the update feed repository AND the main source repository (if different).
  const repos = [repo];
  const srcRepo = sourceRepo();
  if (srcRepo && !repos.includes(srcRepo) && !opt("repo", "")) repos.push(srcRepo);

  const token = gitCredentialToken();
  if (token) {
    for (const r of repos) {
      await publishToRepoWithApi(r, v, "PrintBridge " + v, manifest.notes || ("PrintBridge " + v), assets, token);
    }
    say("\nPublished to " + repos.map((r) => "github.com/" + r).join(" and ") + ".");
    say("Every computer updates itself within about 6 hours, after any printing that is going on");
    say("(or straight away with \"Update PrintBridge now\"). Check PrintBridge on each one shows how it went.");
    return;
  }

  if (!haveGh()) {
    say("\nTo publish it (neither git keychain credentials nor the \"gh\" tool were found, so do it on the website):");
    say("  1. Open https://github.com/" + repo + "/releases/new");
    say("  2. Tag: v" + v + "   Title: PrintBridge " + v);
    say("  3. Drag in ALL the files from: " + out);
    say("  4. Tick \"Set as the latest release\" and press Publish release.");
    return;
  }
  for (const r of repos) {
    const exists = spawnSync("gh", ["repo", "view", r], { encoding: "utf8" }).status === 0;
    if (!exists) {
      say("Making the public repository " + r + " for the update files...");
      execFileSync("gh", ["repo", "create", r, "--public", "--description", "PrintBridge installers and automatic-update files"], { stdio: "inherit" });
    }
    say("Publishing release v" + v + " on github.com/" + r + "...");
    execFileSync("gh", ["release", "create", "v" + v, ...assets, "--repo", r, "--title", "PrintBridge " + v,
      "--notes", manifest.notes || ("PrintBridge " + v), "--latest"], { stdio: "inherit" });
  }
  say("\nPublished. Every computer updates itself within about 6 hours, after any printing that is going on");
  say("(or straight away with \"Update PrintBridge now\"). Check PrintBridge on each one shows how it went.");
}

(async () => {
  try {
    if (command === "keygen") return keygen();
    if (command === "bump") return bump(args[0]);
    if (command === "sign") return void (await sign());
    if (command === "upload") return await upload();
    if (command === "all") {
      if (!fs.existsSync(path.resolve(opt("key", DEFAULT_KEY)))) {
        stop("there is no signing key yet. Make it with:  node publish-update.js keygen\nthen build (so the installers know the key), then publish.");
      }
      return await upload(await sign());
    }
    stop("unknown command \"" + command + "\" (keygen, sign, upload or all).");
  } catch (err) {
    stop(err && err.message ? err.message : String(err));
  }
})();
