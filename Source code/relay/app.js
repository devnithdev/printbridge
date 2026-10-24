// The drop page's script. The file is locked (encrypted) here in the browser
// with a key only the office's main computer can unlock, before it is sent.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  // --- light / dark -----------------------------------------------------------
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function applyTheme(t) {
    if (t) root.setAttribute("data-theme", t); else root.removeAttribute("data-theme");
    var dark = t ? t === "dark" : !!(media && media.matches);
    if (dark) root.setAttribute("data-dark", ""); else root.removeAttribute("data-dark");
  }
  applyTheme(store("pb-theme"));
  if (media && media.addEventListener) media.addEventListener("change", function () { applyTheme(store("pb-theme")); });
  $("theme").addEventListener("click", function () {
    var next = root.hasAttribute("data-dark") ? "light" : "dark";
    store("pb-theme", next); applyTheme(next);
  });
  var egg = $("egg"), eggT = null;
  egg.addEventListener("click", function () { egg.classList.add("on"); clearTimeout(eggT); eggT = setTimeout(function () { egg.classList.remove("on"); }, 3200); });

  // --- talking to this page's server --------------------------------------------
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); });
  }
  function show(id) { ["step-code", "step-send", "step-done"].forEach(function (s) { $(s).hidden = s !== id; }); }
  function say(el, text) { el.textContent = text || ""; el.hidden = !text; }

  var session = null; // { code, name, printers, publicKey, left, online }

  // --- 1. the code ----------------------------------------------------------------
  function prettyCode(v) {
    var c = String(v || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (c.indexOf("PB") === 0) c = c.slice(2);
    var parts = c.match(/.{1,4}/g) || [];
    return parts.length ? "PB-" + parts.join("-") : "";
  }
  $("code").addEventListener("blur", function () { if (this.value) this.value = prettyCode(this.value); });

  function useCode(code, quiet) {
    $("codeGo").disabled = true;
    return post("/api/code", { code: code }).then(function (r) {
      $("codeGo").disabled = false;
      if (r._status !== 200) {
        if (!quiet) say($("codeMsg"), r.error || "That didn't work. Try again.");
        if (r._status === 403) store("pb-code", null);
        show("step-code");
        return;
      }
      say($("codeMsg"), "");
      session = { code: code, name: r.name, printers: r.printers || [], publicKey: r.publicKey, left: r.left, online: r.online };
      if ($("remember").checked) store("pb-code", code);
      fillSend();
      show("step-send");
    }).catch(function () {
      $("codeGo").disabled = false;
      say($("codeMsg"), "Couldn't reach the page. Check the internet and try again.");
    });
  }

  $("step-code").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = prettyCode($("code").value);
    $("code").value = code;
    if (code.replace(/[^0-9A-Z]/g, "").length < 14) { say($("codeMsg"), "Type the whole code, like PB-7K3F-92QD-H4MT."); return; }
    useCode(code);
  });

  // --- 2. the file ------------------------------------------------------------------
  function fillSend() {
    $("who").textContent = session.name || "there";
    var sel = $("printer");
    sel.innerHTML = "";
    session.printers.forEach(function (p) { var o = document.createElement("option"); o.value = p; o.textContent = p; sel.appendChild(o); });
    var last = store("pb-printer");
    if (last && session.printers.indexOf(last) !== -1) sel.value = last;
    $("sendGo").disabled = !session.printers.length;
    say($("sendMsg"), session.printers.length ? "" : "No printer is shared with you yet. Ask the office.");
    $("dot").className = "dot" + (session.online ? " on" : "");
    $("online").textContent = session.online ? "Office online" : "Office offline";
    $("offline").hidden = !!session.online;
    $("left").textContent = session.left == null ? "" : (session.left === 1 ? "1 printout left today." : session.left + " printouts left today.");
  }

  var chosen = null;
  function choose(f) {
    chosen = f || null;
    $("dropText").innerHTML = "";
    if (chosen) {
      var b = document.createElement("b"); b.textContent = chosen.name;
      var s = document.createElement("small"); s.textContent = (chosen.size < 1048576 ? Math.max(1, Math.round(chosen.size / 1024)) + " KB" : (chosen.size / 1048576).toFixed(1) + " MB") + " - tap to change";
      $("dropText").appendChild(b); $("dropText").appendChild(s);
    } else {
      $("dropText").innerHTML = "Choose a file, or drop it here<br><small>PDF, Word, Excel, PowerPoint, text or a picture, up to 20 MB</small>";
    }
  }
  $("file").addEventListener("change", function () { choose(this.files[0]); });
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files[0]) choose(e.dataTransfer.files[0]); });

  $("notMe").addEventListener("click", function () {
    store("pb-code", null); session = null; $("code").value = ""; show("step-code"); $("code").focus();
  });

  // Base64 helpers.
  function toB64(buf) { var s = "", b = new Uint8Array(buf); for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function fromB64(t) { var s = atob(t), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; }

  // Locks the file: a new AES-256-GCM key for this file, itself locked with
  // the office's RSA public key. Only the office's main computer can unlock it.
  function lockFile(file, publicKey) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle) return Promise.reject(new Error("This browser can't lock the file. Use an up-to-date browser."));
    return Promise.all([
      subtle.importKey("spki", fromB64(publicKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]),
      subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]),
      file.arrayBuffer(),
    ]).then(function (r) {
      var pub = r[0], aes = r[1], data = new Uint8Array(r[2]);
      var header = new TextEncoder().encode(JSON.stringify({ name: file.name, type: file.type || "", size: file.size }));
      var plain = new Uint8Array(4 + header.length + data.length);
      new DataView(plain.buffer).setUint32(0, header.length);
      plain.set(header, 4); plain.set(data, 4 + header.length);
      var iv = window.crypto.getRandomValues(new Uint8Array(12));
      return subtle.exportKey("raw", aes).then(function (raw) {
        return Promise.all([
          subtle.encrypt({ name: "RSA-OAEP" }, pub, raw),
          subtle.encrypt({ name: "AES-GCM", iv: iv }, aes, plain),
        ]);
      }).then(function (x) { return { key: toB64(x[0]), iv: toB64(iv), data: x[1] }; });
    });
  }

  var ALLOWED = /\.(pdf|docx?|xlsx?|xlsm|pptx?|odt|ods|odp|rtf|txt|csv|png|jpe?g|gif|bmp|tiff?|webp)$/i;

  $("step-send").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!chosen) { say($("sendMsg"), "Choose a file first."); return; }
    if (!ALLOWED.test(chosen.name)) { say($("sendMsg"), "Send a PDF, Word, Excel, PowerPoint, text or picture file."); return; }
    if (chosen.size > 20 * 1024 * 1024) { say($("sendMsg"), "That file is too big (20 MB at most)."); return; }
    say($("sendMsg"), "");
    $("sendGo").disabled = true;
    $("sendGo").textContent = "Locking and sending...";
    store("pb-printer", $("printer").value);
    lockFile(chosen, session.publicKey).then(function (locked) {
      var form = new FormData();
      form.append("code", session.code);
      form.append("printer", $("printer").value);
      form.append("copies", String(Math.min(Math.max(parseInt($("copies").value, 10) || 1, 1), 20)));
      form.append("color", $("color").value);
      form.append("sides", $("duplex").checked ? "two-sided-long-edge" : "one-sided");
      form.append("name", chosen.name);
      form.append("iv", locked.iv);
      form.append("key", locked.key);
      form.append("file", new Blob([locked.data], { type: "application/octet-stream" }), "locked.bin");
      return fetch("/api/send", { method: "POST", body: form }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; });
      });
    }).then(function (r) {
      $("sendGo").disabled = false;
      $("sendGo").textContent = "Send to the printer";
      if (r._status !== 200) { say($("sendMsg"), r.error || "That didn't work. Try again."); return; }
      if (session.left != null) session.left = Math.max(0, session.left - 1);
      choose(null); $("file").value = "";
      show("step-done");
      track(r.id, r.online);
    }).catch(function (err) {
      $("sendGo").disabled = false;
      $("sendGo").textContent = "Send to the printer";
      say($("sendMsg"), (err && err.message) || "Couldn't send. Check the internet and try again.");
    });
  });

  // --- 3. what happened -------------------------------------------------------------
  var timer = null;
  var STATES = {
    waiting: ["📨", "Sent", "Waiting for the office computer to collect it."],
    received: ["📥", "At the office", "It's being got ready for the printer."],
    held: ["✋", "Waiting for approval", "Someone at the office will check it and press Print."],
    printing: ["🖨️", "Printing", "It's on its way to the printer."],
    done: ["✅", "Printed", "Collect it from the printer."],
    failed: ["⚠️", "Not printed", ""],
    rejected: ["🚫", "Not printed", "The office decided not to print this one."],
  };
  function paint(st, online, message) {
    var s = STATES[st] || STATES.waiting;
    $("stIcon").textContent = s[0];
    $("stTitle").textContent = s[1];
    var text = message || s[2];
    if (st === "waiting" && !online) text = "The office computer is switched off right now. It prints as soon as it's back on - you can close this page.";
    $("stText").textContent = text;
  }
  function track(id, online) {
    clearTimeout(timer);
    paint("waiting", online);
    var tries = 0;
    (function tick() {
      post("/api/status", { id: id, code: session.code }).then(function (r) {
        if (r._status === 200) {
          paint(r.status, r.online, r.message);
          if (["done", "failed", "rejected"].indexOf(r.status) !== -1) return;
        }
        tries++;
        timer = setTimeout(tick, tries < 60 ? 5000 : 30000);
      }).catch(function () { timer = setTimeout(tick, 15000); });
    })();
  }
  $("again").addEventListener("click", function () { clearTimeout(timer); fillSend(); show("step-send"); });

  // --- start ------------------------------------------------------------------------
  var saved = store("pb-code");
  if (saved) { $("remember").checked = true; $("code").value = saved; useCode(saved, true); }
})();
