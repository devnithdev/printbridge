#!/usr/bin/env node
// Makes relay/dist/worker.js: one file, ready to paste into Cloudflare's
// editor (Workers & Pages > the worker > Edit code), with the page and its
// script inside it and a new random pairing code.
//
//   node build.js            new pairing code (printed; type it into PrintBridge)
//   node build.js CODE       keep a pairing code you already have
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const here = __dirname;
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const claim = process.argv[2] || Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join("").replace(/(.{4})(?=.)/g, "$1-");

let src = fs.readFileSync(path.join(here, "worker.js"), "utf8");
src = src.replace("__PAGE__", () => JSON.stringify(fs.readFileSync(path.join(here, "page.html"), "utf8")));
src = src.replace("__APP__", () => JSON.stringify(fs.readFileSync(path.join(here, "app.js"), "utf8")));
src = src.replace('"__CLAIM_CODE__"', JSON.stringify(claim));
const out = process.env.OUT || path.join(here, "dist", "worker.js");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, src);
console.log("Made " + path.relative(process.cwd(), out) + " (" + Math.round(src.length / 1024) + " KB).");
console.log("Pairing code: " + claim);
