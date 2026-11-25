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
    // Not while someone is using a control in the tables: rebuilding would close it.
    const active = document.activeElement;
    if (active && active.closest && active.closest("#printerTable, #computerTable")) return;
    if (document.querySelector(".name-edit")) return; // a name being typed must not be wiped by a refresh
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

// The printer's name, with a Rename button. People are shown the name given
// here; the name its computer gave it stays underneath (it is how the printer
// is found, and still tells which Windows printer this is).
function nameView(printer, cell) {
  const box = document.createElement("div");
  box.className = "name-view";
  const dot = document.createElement("span");
  dot.className = "dot " + (printer.online ? "on" : "off");
  box.appendChild(dot);
  const text = document.createElement("span");
  text.className = "pname-text";
  text.textContent = printer.label;
  box.appendChild(text);
  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "secondary rename-btn";
  rename.textContent = "Rename";
  rename.title = "Choose the name people see for this printer";
  rename.setAttribute("aria-label", "Rename " + printer.label);
  rename.onclick = () => { cell.innerHTML = ""; cell.appendChild(nameEdit(printer, cell)); cell.querySelector("input").focus(); cell.querySelector("input").select(); };
  box.appendChild(rename);
  if (printer.displayName) {
    const real = document.createElement("div");
    real.className = "real-name hint";
    real.textContent = printer.name;
    box.appendChild(real);
  }
  return box;
}

function nameEdit(printer, cell) {
  const form = document.createElement("div");
  form.className = "name-edit";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 60;
  input.value = printer.label;
  input.setAttribute("aria-label", "Name shown to people for " + printer.name);
  form.appendChild(input);
  const send = async (value) => {
    for (const b of form.querySelectorAll("button")) b.disabled = true;
    try {
      await api("/api/manage/printers/" + encodeURIComponent(printer.id) + "/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: value }),
      });
      await loadPrinters();
    } catch (err) {
      for (const b of form.querySelectorAll("button")) b.disabled = false;
      setPageMessage(err.message, "error");
      input.focus();
    }
  };
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  save.onclick = () => send(input.value);
  form.appendChild(save);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  cancel.onclick = () => { cell.innerHTML = ""; cell.appendChild(nameView(printer, cell)); };
  form.appendChild(cancel);
  if (printer.displayName) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "secondary";
    reset.textContent = "Use original name";
    reset.onclick = () => send("");
    form.appendChild(reset);
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); save.click(); }
    else if (event.key === "Escape") { event.preventDefault(); cancel.click(); }
  });
  return form;
}

async function loadPrinters() {
  const list = await api("/api/manage/printers");
  const body = $("printerTable").querySelector("tbody");
  body.innerHTML = "";
  fillClearPick(list);

  for (const printer of list) {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.className = "name-cell";
    nameCell.appendChild(nameView(printer, nameCell));
    tr.appendChild(nameCell);

    const computerCell = document.createElement("td");
    computerCell.textContent = printer.computerName;
    tr.appendChild(computerCell);

    tr.appendChild(typeCell(printer));
    tr.appendChild(colorCell(printer));
    tr.appendChild(duplexCell(printer));

    const showCell = document.createElement("td");
    showCell.className = "show-cell";
    // Says what the printer is now, and what pressing it will do. Green
    // Show and amber Hide, so the two can't be mixed up at a glance.
    const state = document.createElement("span");
    state.className = "show-state " + (printer.hidden ? "is-hidden" : "is-shown");
    state.textContent = printer.hidden ? "Hidden" : "Shown";
    showCell.appendChild(state);
    const toggle = document.createElement("button");
    toggle.className = printer.hidden ? "show-btn" : "hide-btn";
    toggle.textContent = printer.hidden ? "Show" : "Hide";
    toggle.title = printer.hidden ? "Show this printer on the print page" : "Hide this printer from the print page";
    toggle.setAttribute("aria-label", toggle.textContent + " " + printer.label);
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
    // A shown printer can be marked out of order: still listed on the print
    // page, but nothing is sent to it.
    if (!printer.hidden) {
      if (printer.broken) {
        const mark = document.createElement("span");
        mark.className = "show-state is-broken";
        mark.textContent = "Out of order";
        showCell.appendChild(mark);
      }
      const broken = document.createElement("button");
      broken.className = printer.broken ? "show-btn" : "danger";
      broken.textContent = printer.broken ? "Mark working" : "Mark out of order";
      broken.title = printer.broken ? "People can print on it again" : "It stays on the print page, marked out of order, and nothing is sent to it";
      broken.setAttribute("aria-label", broken.textContent + ": " + printer.label);
      broken.onclick = async () => {
        broken.disabled = true;
        try {
          await api("/api/manage/printers/" + encodeURIComponent(printer.id) + "/broken", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ broken: !printer.broken }),
          });
          await loadPrinters();
        } catch (err) {
          broken.disabled = false;
          setPageMessage(err.message, "error");
        }
      };
      showCell.appendChild(broken);
    }
    tr.appendChild(showCell);

    body.appendChild(tr);
  }

  $("printerHint").textContent = list.length
    ? ""
    : "No printers yet. Run PrintBridge Setup on the computer that has a printer.";
}

// Printer type choices.
const TYPE_CHOICES = [
  ["auto", "Automatic"],
  ["inkjet", "Inkjet"],
  ["laser", "Laser"],
  ["dotmatrix", "Dot matrix"],
  ["thermal", "Receipt (thermal)"],
];

function typeCell(printer) {
  const cell = document.createElement("td");
  const sel = document.createElement("select");
  sel.className = "type-select";
  sel.setAttribute("aria-label", "Type of " + printer.label);
  const current = printer.printerType || "auto";
  for (const [val, label] of TYPE_CHOICES) {
    const opt = document.createElement("option");
    opt.value = val;
    // "Automatic" says what it guessed from the name, so a wrong guess shows.
    const guessed = TYPE_CHOICES.find(([v]) => v === printer.kind);
    opt.textContent = val === "auto" ? (guessed ? "Automatic (" + guessed[1] + ")" : "Automatic (can't tell)") : label;
    if (val === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = async () => {
    sel.disabled = true;
    try {
      await api("/api/manage/printers/" + encodeURIComponent(printer.id) + "/type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: sel.value }),
      });
      await loadPrinters();
    } catch (err) {
      sel.disabled = false;
      setPageMessage(err.message, "error");
    }
  };
  cell.appendChild(sel);
  // Set by hand to something its name doesn't look like (a laser set as
  // inkjet, say): point it out, since it decides which printers stand in.
  const guessed = TYPE_CHOICES.find(([v]) => v === printer.kind);
  if (current !== "auto" && guessed && guessed[0] !== current) {
    const warn = document.createElement("span");
    warn.className = "type-warn";
    warn.textContent = "Its name looks like a " + guessed[1].toLowerCase() + " printer. Check this is right.";
    cell.appendChild(warn);
  }
  return cell;
}

// Colour or black and white, and both sides or not. "Automatic" goes by
// what the printer's computer says; the others overrule it when that is wrong.
const COLOR_CHOICES = [["auto", "Automatic"], ["color", "Colour"], ["mono", "Black & white"]];
const DUPLEX_CHOICES = [["auto", "Automatic"], ["yes", "Yes, by itself"], ["hand", "By hand"], ["no", "No"]];

function colorCell(printer) {
  const found = printer.reportedColor === true ? "colour"
    : printer.reportedColor === false ? "black & white" : "not known";
  return choiceCell(printer, COLOR_CHOICES, printer.colorMode, "color", "Colour for ", found);
}

function duplexCell(printer) {
  const found = printer.reportedDuplex === true ? "it can"
    : printer.reportedDuplex === false ? "it can't" : "not known";
  return choiceCell(printer, DUPLEX_CHOICES, printer.duplexMode || "auto", "duplex", "Both sides for ", found);
}

function choiceCell(printer, choices, current, endpoint, groupLabel, found) {
  const cell = document.createElement("td");
  const seg = document.createElement("div");
  seg.className = "seg color-seg";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", groupLabel + printer.label);
  for (const [mode, label] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (mode === "hand") button.title = "It can't turn the paper over itself: people turn the printed pages over, then the backs print";
    if (current === mode) button.className = "on";
    button.setAttribute("aria-pressed", String(current === mode));
    button.onclick = async () => {
      if (current === mode) return;
      for (const b of seg.querySelectorAll("button")) b.disabled = true;
      try {
        await api("/api/manage/printers/" + encodeURIComponent(printer.id) + "/" + endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        await loadPrinters();
      } catch (err) {
        for (const b of seg.querySelectorAll("button")) b.disabled = false;
        setPageMessage(err.message, "error");
      }
    };
    seg.appendChild(button);
  }
  cell.appendChild(seg);

  const note = document.createElement("div");
  note.className = "hint";
  note.style.marginTop = "4px";
  note.textContent = current === "auto"
    ? "The computer says: " + found
    : "Set by hand (the computer says: " + found + ")";
  cell.appendChild(note);
  return cell;
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
    remove.setAttribute("aria-label", "Remove " + computer.name);
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

// --- Printer tools: clear a printer's queue (tucked away in a <details>) ----

function fillClearPick(list) {
  const pick = $("clearPick");
  if (!pick || document.activeElement === pick) return;
  const was = pick.value;
  pick.innerHTML = "";
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label + " (" + p.computerName + ")";
    pick.appendChild(o);
  }
  if (list.some((p) => p.id === was)) pick.value = was;
  $("clearQueue").disabled = !list.length;
}

$("clearQueue").onclick = async () => {
  const pick = $("clearPick");
  const name = pick.selectedOptions[0] ? pick.selectedOptions[0].textContent : "";
  if (!pick.value || !confirm("Clear the queue of " + name + "?\n\nEverything waiting for it is thrown away and won't print. People will need to send theirs again.")) return;
  $("clearQueue").disabled = true;
  try {
    const r = await api("/api/manage/printers/" + encodeURIComponent(pick.value) + "/clear-queue", { method: "POST" });
    setPageMessage("Cleared. " + (r.cancelled === 1 ? "1 printout" : r.cancelled + " printouts") + " from PrintBridge cancelled" +
      (r.computerOnline ? ", and the printer's own queue on its computer emptied." : ". Its computer is off right now: once it is back on, clear its queue here again."), "ok");
  } catch (err) {
    setPageMessage(err.message, "error");
  } finally {
    $("clearQueue").disabled = false;
  }
};
