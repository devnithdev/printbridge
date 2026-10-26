// "Printing from anywhere" on the Printers & setup page (see lib/remote.js).
// Uses api(), $(), escapeHtml() and setPageMessage() from manage.js.

(function () {
  let last = null;
  const RESULT = {
    printing: "Printing", done: "Printed", failed: "Not printed", rejected: "Not printed (refused)",
    held: "Waiting for approval", received: "Received",
  };

  function when(ms) {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return (sameDay ? "" : d.toLocaleDateString() + " ") + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  async function post(url, body, method) {
    return api(url, { method: method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  function showCode(person, code) {
    const box = $("rmNewCode");
    box.hidden = false;
    box.className = "page-message warn";
    box.innerHTML = "";
    const p1 = document.createElement("div");
    p1.innerHTML = "Code for <strong>" + escapeHtml(person.name) + "</strong>:";
    const c = document.createElement("div");
    c.textContent = code;
    c.style.cssText = "font:600 22px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em;margin:8px 0";
    const p2 = document.createElement("div");
    p2.textContent = "Give it to them with the drop page's address (" + (last && last.relayUrl) + "). It is shown only now - this computer keeps only a fingerprint of it.";
    const copy = document.createElement("button");
    copy.className = "secondary";
    copy.style.marginTop = "8px";
    copy.textContent = "Copy code and address";
    copy.onclick = () => {
      const text = "PrintBridge - print to the office from anywhere\n" + (last && last.relayUrl) + "\nYour code: " + code;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
        () => { copy.textContent = "Copied"; },
        () => { copy.textContent = "Select the code above and copy it"; }
      );
    };
    box.append(p1, c, p2, copy);
  }

  function printerBoxes(names) {
    const box = $("rmPrinters");
    const ticked = new Set([...box.querySelectorAll("input:checked")].map((i) => i.value));
    box.innerHTML = "";
    for (const n of names) {
      const l = document.createElement("label");
      l.style.cssText = "display:flex;gap:6px;align-items:center";
      const i = document.createElement("input");
      i.type = "checkbox"; i.value = n; i.checked = ticked.has(n);
      l.append(i, document.createTextNode(n));
      box.appendChild(l);
    }
    if (!names.length) box.textContent = "No printers yet.";
  }

  function peopleTable(s) {
    const body = $("rmPeople").querySelector("tbody");
    body.innerHTML = "";
    for (const p of s.people) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHtml(p.name) + "</td>" +
        "<td><code>…" + escapeHtml(p.hint) + "</code></td>" +
        "<td>" + escapeHtml(p.printers.length ? p.printers.join(", ") : "All") + "</td>" +
        "<td>" + (p.dailyLimit || "No limit") + "</td>" +
        "<td>" + (p.hold ? "Asks first" : "Prints at once") + "</td>" +
        '<td><span class="dot ' + (p.active ? "on" : "off") + '"></span>' + (p.active ? "On" : "Off") + "</td>";
      const actions = document.createElement("td");
      const row = document.createElement("div");
      row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;min-width:180px";
      actions.appendChild(row);
      const mk = (label, cls, fn) => {
        const b = document.createElement("button");
        b.className = cls; b.textContent = label;
        b.onclick = async () => {
          b.disabled = true;
          try { await fn(); await refresh(); } catch (err) { setPageMessage(err.message, "error"); }
          b.disabled = false;
        };
        return b;
      };
      row.append(
        mk(p.active ? "Switch off" : "Switch on", "secondary", () => post("/api/remote/people/" + p.id, { active: !p.active })),
        mk(p.hold ? "Print at once" : "Ask first", "secondary", () => post("/api/remote/people/" + p.id, { hold: !p.hold })),
        mk("New code", "secondary", async () => {
          if (!confirm("Make a new code for " + p.name + "? Their old code stops working straight away.")) return;
          const r = await post("/api/remote/people/" + p.id + "/new-code");
          showCode(r.person, r.code);
        }),
        mk("Remove", "danger", async () => {
          if (!confirm("Remove " + p.name + "? Their code stops working straight away.")) return;
          await api("/api/remote/people/" + p.id, { method: "DELETE" });
        })
      );
      tr.appendChild(actions);
      body.appendChild(tr);
    }
    $("rmPeopleHint").textContent = s.people.length ? "" : "Nobody yet. Add someone above.";
  }

  function pendingTable(s) {
    $("rmPendingBox").hidden = !s.pending.length;
    const body = $("rmPending").querySelector("tbody");
    body.innerHTML = "";
    for (const e of s.pending) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + escapeHtml(e.person) + "<div class=\"hint\" style=\"margin:0\">" + escapeHtml(when(e.at)) + "</div></td><td>" +
        escapeHtml(e.fileName) + "</td>";
      const pc = document.createElement("td");
      const sel = document.createElement("select");
      for (const n of s.printers) { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); }
      sel.value = e.printer;
      pc.appendChild(sel);
      tr.appendChild(pc);
      const cc = document.createElement("td"); cc.textContent = e.copies; tr.appendChild(cc);
      const ac = document.createElement("td"); ac.style.whiteSpace = "nowrap";
      const ok = document.createElement("button"); ok.textContent = "Print"; ok.style.marginRight = "6px";
      ok.onclick = async () => { ok.disabled = true; try { await post("/api/remote/pending/" + e.id + "/approve", { printer: sel.value }); await refresh(); } catch (err) { ok.disabled = false; setPageMessage(err.message, "error"); } };
      const no = document.createElement("button"); no.className = "danger"; no.textContent = "Don't print";
      no.onclick = async () => { if (!confirm("Don't print " + e.fileName + "? " + e.person + " will see it was refused.")) return; await post("/api/remote/pending/" + e.id + "/reject"); await refresh(); };
      ac.append(ok, no);
      tr.appendChild(ac);
      body.appendChild(tr);
    }
  }

  function logTable(s) {
    $("rmLogBox").hidden = !s.local || s.locked || !s.connected;
    const body = $("rmLog").querySelector("tbody");
    body.innerHTML = "";
    for (const e of s.log || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + escapeHtml(when(e.at)) + "</td><td>" + escapeHtml(e.person) + "</td><td>" + escapeHtml(e.fileName) +
        "</td><td>" + escapeHtml(e.printer) + "</td><td>" + escapeHtml(RESULT[e.result] || e.result) +
        (e.message ? '<div class="hint" style="margin:0">' + escapeHtml(e.message) + "</div>" : "") + "</td>";
      body.appendChild(tr);
    }
    if (!(s.log || []).length) body.innerHTML = '<tr><td colspan="5" class="hint">None yet.</td></tr>';
  }

  async function refresh() {
    let s;
    try { s = await api("/api/remote"); } catch (err) { return; }
    last = s;
    const open = s.local && !s.locked;
    $("rmElsewhere").hidden = s.local;
    $("rmLocked").hidden = !s.local || !s.locked;
    $("rmLockBar").hidden = !open;
    if (open) $("rmLockNote").textContent = "Unlocked. It locks again by itself at " + new Date(s.unlockedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ".";
    $("rmSetup").hidden = !open || s.connected;
    $("rmOn").hidden = !open || !s.connected;
    if (!open) $("rmNewCode").hidden = true;
    if (open && s.connected) {
      $("rmDot").className = "dot " + (s.online ? "on" : "off");
      $("rmState").textContent = s.online ? "Connected: collecting printouts" : (s.lastError ? "Can't reach the drop page: " + s.lastError : "Connecting...");
      $("rmLink").textContent = s.relayUrl; $("rmLink").href = s.relayUrl;
      printerBoxes(s.printers);
      peopleTable(s);
    }
    pendingTable(s);
    logTable(s);
  }

  async function doUnlock() {
    const b = $("rmUnlock");
    b.disabled = true;
    try {
      await post("/api/remote/unlock", { code: $("rmUnlockCode").value });
      $("rmUnlockCode").value = "";
      setPageMessage("", "");
      await refresh();
    } catch (err) { setPageMessage(err.message, "error"); }
    b.disabled = false;
  }
  $("rmUnlock").onclick = doUnlock;
  $("rmUnlockCode").addEventListener("keydown", (e) => { if (e.key === "Enter") doUnlock(); });
  $("rmLock").onclick = async () => { await post("/api/remote/lock"); await refresh(); };

  $("rmConnect").onclick = async () => {
    const b = $("rmConnect");
    b.disabled = true; b.textContent = "Connecting...";
    try {
      await post("/api/remote/connect", { relayUrl: $("rmUrl").value, claim: $("rmClaim").value });
      $("rmClaim").value = "";
      setPageMessage("The drop page is connected. Now add the people who may use it.", "");
      await refresh();
    } catch (err) {
      setPageMessage(err.message, "error");
    }
    b.disabled = false; b.textContent = "Connect";
  };

  $("rmAdd").onclick = async () => {
    const name = $("rmName").value.trim();
    if (!name) { setPageMessage("Type the person's name first.", "error"); return; }
    const printers = [...$("rmPrinters").querySelectorAll("input:checked")].map((i) => i.value);
    try {
      const r = await post("/api/remote/people", { name, printers, dailyLimit: $("rmLimit").value, hold: $("rmHold").checked });
      $("rmName").value = "";
      showCode(r.person, r.code);
      await refresh();
    } catch (err) { setPageMessage(err.message, "error"); }
  };

  $("rmDisconnect").onclick = async () => {
    if (!confirm("Disconnect the drop page? Nobody can print from outside until it is connected again (the people and their codes are kept).")) return;
    await post("/api/remote/disconnect");
    await refresh();
  };

  refresh();
  setInterval(refresh, 10000);
})();
