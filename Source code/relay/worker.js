// PrintBridge remote printing: the online drop page (a Cloudflare Worker).
//
// A few chosen people, each with a personal code (like PB-7K3F-92QD-H4MT),
// can send a file to the office printers from anywhere: they open this page,
// type their code, pick a printer and a file, and press Send. The office's
// main computer collects waiting files every few seconds (it reaches out to
// this page; nothing reaches into the office) and prints them.
//
// What is kept here (Cloudflare KV, binding "PB"):
//   office      who may collect jobs: the SHA-256 of the office's secret
//   config      the people (only the SHA-256 of each code, never the code),
//               which printers each may use, daily limits, the printers'
//               names, the office's public key, its name
//   seen        when the office last collected (shown as online/offline)
//   queue       the ids of jobs waiting to be collected
//   job:<id>    one job: who sent it, printer, copies, the wrapped file key
//   blob:<id>   the file, ENCRYPTED in the sender's browser with a key only
//               the office's main computer can unwrap (RSA-OAEP + AES-GCM)
//   st:<id>     what happened to a job, for the sender (kept a week)
//   n:<code hash>:<day>   jobs sent today, for the daily limit
//   rl:<ip>     wrong codes from one address (locked for 15 minutes after 10)
//
// So neither Cloudflare nor anyone who got into this account can read a
// document, and codes can't be read back from it either.
//
// Pairing: CLAIM_CODE below is filled in with a random code when this is
// set up; PrintBridge on the main computer sends it once, with a secret of
// its own, and from then on only that secret can collect jobs or change
// the people. (Setting it up again needs a new CLAIM_CODE.)
//
// Free plan limits that matter here (Workers KV): 1,000 writes and 1,000
// deletes a day for the whole account (shared with any other Workers) - each
// printout takes about 6, the office saying "online" 144 - and 25 MB per value (files are
// limited to 20 MB).

const CLAIM_CODE = "__CLAIM_CODE__";
const MAX_FILE = 20 * 1024 * 1024; // before encryption
const MAX_UPLOAD = MAX_FILE + 64 * 1024; // the encrypted file and its header
const LOCK_AFTER = 10; // wrong codes from one address...
const LOCK_SECONDS = 15 * 60; // ...lock it for this long
const STATUS_TTL = 7 * 24 * 3600;
const OFFLINE_AFTER_MS = 25 * 60 * 1000; // the office collects every ~20 s and says so every 10 minutes (KV writes are scarce)
const ALLOWED = /\.(pdf|docx?|xlsx?|xlsm|pptx?|odt|ods|odp|rtf|txt|csv|png|jpe?g|gif|bmp|tiff?|webp)$/i;

// --- small helpers -------------------------------------------------------------

const enc = new TextEncoder();
async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function sameText(a, b) {
  // Constant-time comparison of two strings of hex.
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
};
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, SECURITY),
  });
}
const fail = (message, status) => json({ error: message }, status || 400);
const today = () => new Date().toISOString().slice(0, 10);
// Codes are typed by people: ignore case, spaces and dashes.
const normalCode = (c) => String(c || "").toUpperCase().replace(/[^0-9A-Z]/g, "");

async function getJson(env, key) {
  const v = await env.PB.get(key, "json");
  return v || null;
}
async function config(env) {
  return (await getJson(env, "config")) || { people: [], printers: [], publicKey: "", name: "" };
}

// --- people and their codes ------------------------------------------------------

function clientIp(req) {
  return req.headers.get("CF-Connecting-IP") || "unknown";
}

async function locked(env, req) {
  const r = await getJson(env, "rl:" + clientIp(req));
  return !!(r && r.n >= LOCK_AFTER);
}

async function wrongCode(env, req) {
  const key = "rl:" + clientIp(req);
  const r = (await getJson(env, key)) || { n: 0 };
  r.n += 1;
  await env.PB.put(key, JSON.stringify(r), { expirationTtl: LOCK_SECONDS });
}

// The person a code belongs to, or null. Checked against the SHA-256 of the
// code, so the codes themselves are never stored here.
async function personFor(env, code) {
  const c = normalCode(code);
  if (c.length < 12) return null;
  const hash = await sha256hex(c);
  const cfg = await config(env);
  const p = cfg.people.find((x) => sameText(x.hash, hash));
  return p && p.active !== false ? { person: p, hash, cfg } : null;
}

function printersFor(p, cfg) {
  const all = cfg.printers || [];
  return Array.isArray(p.printers) && p.printers.length ? all.filter((n) => p.printers.includes(n)) : all;
}

async function sentToday(env, hash) {
  return parseInt((await env.PB.get("n:" + hash + ":" + today())) || "0", 10) || 0;
}

// --- the queue ----------------------------------------------------------------

async function queue(env) {
  return (await getJson(env, "queue")) || [];
}
async function addToQueue(env, id) {
  const q = await queue(env);
  if (!q.includes(id)) q.push(id);
  await env.PB.put("queue", JSON.stringify(q.slice(-500)));
}
async function removeFromQueue(env, ids) {
  const q = await queue(env);
  const left = q.filter((x) => !ids.includes(x));
  if (left.length !== q.length) await env.PB.put("queue", JSON.stringify(left));
}

async function officeOnline(env) {
  const seen = parseInt((await env.PB.get("seen")) || "0", 10) || 0;
  return Date.now() - seen < OFFLINE_AFTER_MS;
}

// --- the office (PrintBridge on the main computer) -------------------------------

async function isOffice(env, req) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token.length < 32) return false;
  const office = await getJson(env, "office");
  return !!(office && sameText(office.hash, await sha256hex(token)));
}

async function officeApi(req, env, url) {
  const path = url.pathname;

  // First contact: the pairing code proves this is the right office; from
  // then on only its secret works.
  if (path === "/office/claim" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const already = await getJson(env, "office");
    if (already && !(await isOffice(env, req))) return fail("This page is already connected to an office.", 409);
    if (!already && (CLAIM_CODE.startsWith("__") || !sameText(normalCode(body.claim), normalCode(CLAIM_CODE)))) {
      return fail("Wrong pairing code.", 403);
    }
    const token = String(body.token || "");
    if (token.length < 32) return fail("The office secret is too short.");
    await env.PB.put("office", JSON.stringify({ hash: await sha256hex(token), at: Date.now() }));
    return json({ ok: true });
  }

  if (!(await isOffice(env, req))) return fail("Not allowed.", 401);

  // The people, printers and public key, sent whenever they change.
  if (path === "/office/config" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.people)) return fail("Not understood.");
    const people = body.people.slice(0, 200).map((p) => ({
      id: String(p.id || "").slice(0, 40),
      hash: String(p.hash || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 64),
      name: String(p.name || "").slice(0, 60),
      printers: Array.isArray(p.printers) ? p.printers.map((n) => String(n).slice(0, 120)).slice(0, 50) : null,
      dailyLimit: Math.max(0, Math.min(500, parseInt(p.dailyLimit, 10) || 0)),
      active: p.active !== false,
    })).filter((p) => p.hash.length === 64);
    const cfg = {
      people,
      printers: (Array.isArray(body.printers) ? body.printers : []).map((n) => String(n).slice(0, 120)).slice(0, 100),
      publicKey: String(body.publicKey || "").slice(0, 2000),
      name: String(body.name || "").slice(0, 80),
      updatedAt: Date.now(),
    };
    await env.PB.put("config", JSON.stringify(cfg));
    await env.PB.put("seen", String(Date.now()));
    return json({ ok: true, people: people.length });
  }

  // Jobs waiting. The office says it is online at most every 10 minutes
  // (one write), so polling costs only reads.
  if (path === "/office/queue" && req.method === "GET") {
    if (url.searchParams.get("alive") === "1") await env.PB.put("seen", String(Date.now()));
    const ids = await queue(env);
    // Once in a while the office also asks for every job key, in case two
    // senders at the same moment overwrote each other's queue entry.
    if (url.searchParams.get("full") === "1") {
      const listed = await env.PB.list({ prefix: "job:" });
      for (const k of listed.keys) {
        const id = k.name.slice(4);
        if (!ids.includes(id)) ids.push(id);
      }
    }
    const jobs = [];
    for (const id of ids.slice(0, 50)) {
      const j = await getJson(env, "job:" + id);
      if (j) jobs.push(j);
    }
    return json({ jobs });
  }

  const m = /^\/office\/jobs\/([0-9a-f]{24})(\/file|\/status)$/.exec(path);
  if (m && m[2] === "/file" && req.method === "GET") {
    const blob = await env.PB.get("blob:" + m[1], "arrayBuffer");
    if (!blob) return fail("Gone.", 404);
    return new Response(blob, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
  }
  if (m && m[2] === "/status" && req.method === "POST") {
    const id = m[1];
    const body = await req.json().catch(() => ({}));
    const status = String(body.status || "");
    if (!["received", "held", "printing", "done", "failed", "rejected"].includes(status)) return fail("Unknown status.");
    const job = await getJson(env, "job:" + id);
    const st = { status, message: String(body.message || "").slice(0, 300), at: Date.now(), hash: job ? job.hash : body.hash || "" };
    if (!job && !(await env.PB.get("st:" + id))) return fail("Gone.", 404);
    if (!st.hash) {
      const old = await getJson(env, "st:" + id);
      st.hash = old ? old.hash : "";
    }
    await env.PB.put("st:" + id, JSON.stringify(st), { expirationTtl: STATUS_TTL });
    // Collected: the file and the job are no longer kept here.
    if (body.collected) {
      await env.PB.delete("blob:" + id);
      await env.PB.delete("job:" + id);
      await removeFromQueue(env, [id]);
    }
    return json({ ok: true });
  }

  return fail("Not found.", 404);
}

// --- the senders -----------------------------------------------------------------

async function senderApi(req, env, url) {
  const path = url.pathname;

  if (path === "/api/info" && req.method === "GET") {
    const cfg = await config(env);
    return json({ ready: !!cfg.publicKey, online: await officeOnline(env), name: cfg.name || "" });
  }

  if (path === "/api/code" && req.method === "POST") {
    if (await locked(env, req)) return fail("Too many wrong codes. Try again in 15 minutes.", 429);
    const body = await req.json().catch(() => ({}));
    const found = await personFor(env, body.code);
    if (!found) {
      await wrongCode(env, req);
      return fail("That code isn't right, or has been switched off.", 403);
    }
    const { person, hash, cfg } = found;
    const used = person.dailyLimit ? await sentToday(env, hash) : 0;
    return json({
      name: person.name,
      printers: printersFor(person, cfg),
      publicKey: cfg.publicKey,
      left: person.dailyLimit ? Math.max(0, person.dailyLimit - used) : null,
      online: await officeOnline(env),
      office: cfg.name || "",
    });
  }

  if (path === "/api/send" && req.method === "POST") {
    if (await locked(env, req)) return fail("Too many wrong codes. Try again in 15 minutes.", 429);
    const length = parseInt(req.headers.get("Content-Length") || "0", 10);
    if (length > MAX_UPLOAD + 16 * 1024) return fail("That file is too big (20 MB at most).", 413);
    let form;
    try { form = await req.formData(); } catch (e) { return fail("The file didn't arrive. Try again."); }
    const found = await personFor(env, form.get("code"));
    if (!found) {
      await wrongCode(env, req);
      return fail("That code isn't right, or has been switched off.", 403);
    }
    const { person, hash, cfg } = found;
    if (!cfg.publicKey) return fail("Remote printing isn't set up at the office yet.", 503);
    const printer = String(form.get("printer") || "");
    if (!printersFor(person, cfg).includes(printer)) return fail("That printer isn't available to you.");
    const name = String(form.get("name") || "").slice(0, 200);
    if (!ALLOWED.test(name)) return fail("Send a PDF, Word, Excel, PowerPoint, text or picture file.");
    const iv = String(form.get("iv") || "");
    const key = String(form.get("key") || "");
    if (!/^[A-Za-z0-9+/=]{16,24}$/.test(iv) || !/^[A-Za-z0-9+/=]{300,800}$/.test(key)) return fail("The file wasn't locked properly. Reload the page and try again.");
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") return fail("No file arrived.");
    if (file.size > MAX_UPLOAD) return fail("That file is too big (20 MB at most).", 413);
    if (person.dailyLimit) {
      const used = await sentToday(env, hash);
      if (used >= person.dailyLimit) return fail("You've reached today's limit of " + person.dailyLimit + " printouts.", 429);
      await env.PB.put("n:" + hash + ":" + today(), String(used + 1), { expirationTtl: 2 * 24 * 3600 });
    }
    const copies = Math.min(Math.max(parseInt(form.get("copies"), 10) || 1, 1), 20);
    const id = randomId();
    await env.PB.put("blob:" + id, await file.arrayBuffer(), { expirationTtl: 14 * 24 * 3600 });
    const job = {
      id, hash, personId: person.id, person: person.name, printer, copies,
      color: form.get("color") === "color" ? "color" : "monochrome",
      sides: form.get("sides") === "two-sided-long-edge" ? "two-sided-long-edge" : "one-sided",
      name, iv, key, size: file.size, at: Date.now(),
    };
    await env.PB.put("job:" + id, JSON.stringify(job), { expirationTtl: 14 * 24 * 3600 });
    await env.PB.put("st:" + id, JSON.stringify({ status: "waiting", message: "", at: Date.now(), hash }), { expirationTtl: STATUS_TTL });
    await addToQueue(env, id);
    return json({ ok: true, id, online: await officeOnline(env) });
  }

  if (path === "/api/status" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "");
    if (!/^[0-9a-f]{24}$/.test(id)) return fail("Not found.", 404);
    const hash = await sha256hex(normalCode(body.code));
    const st = await getJson(env, "st:" + id);
    if (!st || !sameText(st.hash, hash)) return fail("Not found.", 404);
    return json({ status: st.status, message: st.message, at: st.at, online: await officeOnline(env) });
  }

  return fail("Not found.", 404);
}

// --- the page ------------------------------------------------------------------------

// Filled in by build.js from page.html and app.js (one file to paste into
// Cloudflare's editor).
const PAGE = __PAGE__;
const APP = __APP__;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "connect-src 'self'",
  "img-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/office/")) return await officeApi(req, env, url);
      if (url.pathname.startsWith("/api/")) return await senderApi(req, env, url);
      if (url.pathname === "/app.js") {
        return new Response(APP, { headers: Object.assign({ "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" }, SECURITY) });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(PAGE, {
          headers: Object.assign({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "Content-Security-Policy": CSP }, SECURITY),
        });
      }
      if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
      return new Response("Not found", { status: 404, headers: SECURITY });
    } catch (err) {
      return fail("Something went wrong here. Try again in a minute.", 500);
    }
  },
};
