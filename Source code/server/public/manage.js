// Printers & setup. Open to anyone on the network, by choice - the things
// it can do are the same things someone could do by walking over to the
// printer and unplugging it.

const $ = (id) => document.getElementById(id);

async function api(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (err) { data = { error: text }; }
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function setPageMessage(text, kind) {
  const box = $("pageMessage");
  if (!text) { box.hidden = true; box.textContent = ""; return; }
  box.hidden = false;
  box.className = "page-message" + (kind ? " " + kind : "");
  box.textContent = text;
}

(async function start() {
  await Promise.allSettled([loadWhere(), loadPrinters(), loadComputers()]);
  setInterval(() => {
    loadPrinters().catch(() => {});
    loadComputers().catch(() => {});
  }, 10000);
})();

async function loadWhere() {
  try {
    const where = await api("/api/where");
    const address = where.best || ("http://localhost:" + where.port);
    // The agent only needs host:port, not the http:// part.
    $("setupAddress").textContent = address.replace(/^https?:\/\//, "");
  } catch (err) {
    $("setupAddress").textContent = "(could not work it out)";
  }
}

async function loadPrinters() {
  const list = await api("/api/manage/printers");
  const body = $("printerTable").querySelector("tbody");
  body.innerHTML = "";

  for (const printer of list) {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.innerHTML =
      '<span class="dot ' + (printer.online ? "on" : "off") + '"></span>' +
      escapeHtml(printer.name);
    tr.appendChild(nameCell);

    const computerCell = document.createElement("td");
    computerCell.textContent = printer.computerName;
    tr.appendChild(computerCell);

    const showCell = document.createElement("td");
    // Says what the printer is now, and what pressing it will do.
    const state = document.createElement("span");
    state.className = "hint";
    state.style.marginRight = "10px";
    state.textContent = printer.hidden ? "Hidden" : "Shown";
    showCell.appendChild(state);
    const toggle = document.createElement("button");
    toggle.className = "secondary";
    toggle.textContent = printer.hidden ? "Show" : "Hide";
    toggle.title = printer.hidden ? "Show this printer on the print page" : "Hide this printer from the print page";
    toggle.onclick = async () => {
      toggle.disabled = true;
      try {
        await api("/api/manage/printers/" + encodeURIComponent(printer.id) + "/hidden", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: !printer.hidden }),
        });
        await loadPrinters();
      } catch (err) {
        toggle.disabled = false;
        setPageMessage(err.message, "error");
      }
    };
    showCell.appendChild(toggle);
    tr.appendChild(showCell);

    body.appendChild(tr);
  }

  $("printerHint").textContent = list.length
    ? ""
    : "No printers yet. Run PrintBridge Setup on the computer that has a printer.";
}

async function loadComputers() {
  const list = await api("/api/manage/computers");
  const body = $("computerTable").querySelector("tbody");
  body.innerHTML = "";

  for (const computer of list) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(computer.name) + "</td>" +
      '<td title="' + escapeHtml(computer.platform) + '">' + escapeHtml(systemName(computer.platform)) + "</td>" +
      // The version it reported when it last connected (automatic updates
      // bring every computer up to date by itself; an old number here is
      // one that hasn't been switched on, or can't update - Check on it says why).
      "<td>" + escapeHtml(computer.version || "Not known yet") + "</td>" +
      '<td><span class="dot ' + (computer.online ? "on" : "off") + '"></span>' +
      (computer.online ? "On" : "Off") + "</td>";

    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.onclick = async () => {
      if (!confirm(
        "Remove \"" + computer.name + "\"?\n\n" +
        "Its printers disappear from the print page. To put it back, run " +
        "PrintBridge Setup on that computer again."
      )) return;
      remove.disabled = true;
      try {
        await api("/api/manage/computers/" + computer.id, { method: "DELETE" });
        await loadComputers();
        await loadPrinters();
      } catch (err) {
        remove.disabled = false;
        setPageMessage(err.message, "error");
      }
    };
    actions.appendChild(remove);
    tr.appendChild(actions);

    body.appendChild(tr);
  }

  $("computerHint").textContent = list.length ? "" : "None connected yet.";
}

// "win32 10.0.19045" -> "Windows", "darwin 25.0.0" -> "Mac" (the full text
// stays in the tooltip, for whoever looks after this).
function systemName(platform) {
  const p = String(platform || "").toLowerCase();
  if (p.startsWith("win32")) return "Windows";
  if (p.startsWith("darwin")) return "Mac";
  if (p.startsWith("linux")) return "Linux";
  return p && p !== "unknown" ? platform : "Not known yet";
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
