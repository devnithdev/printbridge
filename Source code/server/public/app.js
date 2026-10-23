// The print page. No accounts, no sign-in: open it and print.

let printers = [];
let pendingFiles = [];      // files on the "Print this?" screen
let afterWelcome = null;    // what to do once a first-time visitor gives a name
let chosenPrinterId = null;
let maxUploadMb = 50;

const NAME_KEY = "printer-assist-name";

const $ = (id) => document.getElementById(id);

async function api(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (err) { data = { error: text }; }
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function myName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch (err) {
    return ""; // private mode, or storage blocked
  }
}

function setMyName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch (err) {
    /* they'll just be asked again next time - not worth failing over */
  }
  $("nameChip").textContent = name || "Set your name";
}

function setPageMessage(text, kind) {
  const box = $("pageMessage");
  if (!text) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.className = "page-message" + (kind ? " " + kind : "");
  box.textContent = text;
}

// A message with a link in it (built from parts, never from raw text).
function setPageMessageLink(text, kind, href, linkText) {
  setPageMessage(text, kind);
  const box = $("pageMessage");
  box.appendChild(document.createTextNode(" "));
  const a = document.createElement("a");
  a.className = "msg-link";
  a.href = href;
  a.textContent = linkText;
  box.appendChild(a);
}

// --- "Refresh address" ------------------------------------------------------
//
// If the main computer was given a new network address (after a power cut or a
// router restart), a page opened at the old address shows an error, for
// example 404 (another device now has that address) or "can't connect".
// This button looks for the main computer again:
//   1. Asks the website this page came from for its current addresses (works
//      whenever the page's own address still reaches the main computer, and
//      it makes the main computer re-announce itself to the other computers).
//   2. If that fails, tries the addresses this device remembers, including the
//      computer's name (like http://office-pc.local:3000), which does not change
//      when the number does, and offers a link to the first that answers.

const KNOWN_KEY = "printbridge-known-addresses";

// Is this page open on the main computer itself (http://localhost:3000)?
function isLocalPage() {
  return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(window.location.hostname);
}

function knownAddresses() {
  try {
    const known = JSON.parse(localStorage.getItem(KNOWN_KEY) || "{}");
    return { id: known.id || "", urls: Array.isArray(known.urls) ? known.urls : [] };
  } catch (err) {
    return { id: "", urls: [] };
  }
}

function rememberAddresses(info) {
  const urls = [];
  const add = (u) => { if (u && !urls.includes(u)) urls.push(u); };
  add(info.hostnameUrl);
  if (!isLocalPage()) add(window.location.origin); // "localhost" means nothing to another device
  for (const a of info.addresses || []) add(a);
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify({ id: info.id || "", urls: urls.slice(0, 8) }));
  } catch (err) {
    /* private mode: the button still works, it just remembers nothing */
  }
}

// Is this one of the remembered addresses, and does the printing website
// answer there? Resolves to the address, or null.
async function answersAt(url, wantedId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url + "/api/office-printing", { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return null;
    const about = await response.json();
    if (!about || about.app !== "office-printing") return null;
    if (wantedId && about.id && about.id !== wantedId) return null;
    return url;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let refreshingAddress = false;

async function refreshAddress() {
  if (refreshingAddress) return;
  refreshingAddress = true;
  const button = $("refreshAddrBtn");
  button.disabled = true;
  button.classList.add("spinning");
  setPageMessage("Looking for the main computer's address...", "warn");

  try {
    let info = null;
    try {
      info = await api("/api/refresh-address", { method: "POST" });
    } catch (err) {
      info = null; // this page's address doesn't reach the printing website any more
    }

    if (info && info.ok) {
      rememberAddresses(info);
      const here = window.location.origin;
      const current = info.addresses || [];
      if (isLocalPage()) {
        // On the main computer itself: show the address everyone else should use.
        setPageMessage(
          info.best
            ? "Refreshed. Other devices reach this computer at " + info.best + " (print a new sign for the wall if it changed)."
            : "Refreshed, but this computer isn't connected to a network right now. Connect it to the office Wi-Fi or network, then press Refresh address again.",
          info.best ? "ok" : "warn"
        );
        loadPrinters(true).catch(() => {});
        loadQueue().catch(() => {});
      } else if (current.length && !current.includes(here) && info.hostnameUrl !== here) {
        // It answered, but the number it has now is not the one in this browser's address bar.
        setPageMessageLink(
          "The main computer's address is now " + (info.best || current[0]) + ".",
          "ok", (info.best || current[0]) + "/", "Open the new address"
        );
      } else {
        setPageMessage("Connected. The main computer's address is " + (info.best || here) + ".", "ok");
        loadPrinters(true).catch(() => {});
        loadQueue().catch(() => {});
        // A page that had lost its live connection (the usual 404) starts fresh.
        if (liveUpdatesBroken) setTimeout(() => window.location.reload(), 1200);
      }
      return;
    }

    // Not reachable from here: try what this device remembers.
    const known = knownAddresses();
    const tried = known.urls.filter((u) => u !== window.location.origin && !/\/\/(localhost|127\.)/.test(u));
    const answers = await Promise.all(tried.map((u) => answersAt(u, known.id)));
    const found = answers.find((u) => u);
    if (found) {
      setPageMessageLink("The main computer answers at a different address.", "ok", found + "/", "Open " + found);
    } else {
      setPageMessage(
        "Couldn't find the main computer from this address. Make sure it is switched on and " +
        "on the same Wi-Fi or network. On the main computer, open PrintBridge and press " +
        "\"Refresh address\" there to see its current address (it is also on the sign for the wall).",
        "error"
      );
    }
  } finally {
    refreshingAddress = false;
    button.disabled = false;
    button.classList.remove("spinning");
  }
}

// --- start ----------------------------------------------------------------

(async function start() {
  // Wire everything up first, so the page still works if a request fails.
  setupDropzone();
  setupPrintModal();
  setupNameModal();
  setupHelpModal();
  setupEscapeToClose();
  $("refreshAddrBtn").addEventListener("click", refreshAddress);

  $("nameChip").textContent = myName() || "Set your name";

  try {
    const hello = await api("/api/hello");
    printers = hello.printers || [];
    maxUploadMb = hello.maxUploadMb || 50;
    for (const alert of hello.openHelp || []) showAlertBanner(alert, true);
  } catch (err) {
    setPageMessage(
      "Could not reach the printing website. It may have been closed on the computer running it, " +
      "or the main computer may have a new address. Press \"Refresh address\" (top of the page) to look for it.",
      "error"
    );
  }
  // Remember where the main computer is, for the "Refresh address" button on a day this address stops working.
  api("/api/where").then(rememberAddressesFromWhere).catch(() => {});

  await loadQueue().catch(() => {});
  listenForLiveUpdates();

  // A printout from another program on a computer ("PrintBridge"
  // printer) opens the page with ?upload=<id>. Take it out of the address
  // so reloading the page doesn't open it again.
  const params = new URLSearchParams(window.location.search);
  const incoming = params.get("upload");
  if (incoming) {
    try { history.replaceState(null, "", window.location.pathname); } catch (err) { /* old browser */ }
  }

  // First time on this device: ask what to call them.
  if (!myName()) {
    afterWelcome = incoming ? () => openPrintModalWithUpload(incoming) : null;
    $("welcomeModal").hidden = false;
    setTimeout(() => $("welcomeName").focus(), 100);
  } else if (incoming) {
    openPrintModalWithUpload(incoming);
  }

  setInterval(() => { loadPrinters().catch(() => {}); }, 15000);
})();

// --- the drop zone --------------------------------------------------------

function setupDropzone() {
  const zone = $("dropzone");
  const input = $("fileInput");

  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });

  // Dropping anywhere on the page works, not just on the box - people aim
  // roughly, and a file dropped elsewhere would otherwise open in the
  // browser and lose their work.
  ["dragenter", "dragover"].forEach((name) => {
    document.addEventListener(name, (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      zone.classList.add("dragging");
    });
  });

  document.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) zone.classList.remove("dragging");
  });

  document.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    zone.classList.remove("dragging");
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) openPrintModalWith(files);
  });

  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    if (files.length) openPrintModalWith(files);
    input.value = "";
  });
}

function hasFiles(event) {
  const dt = event.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.prototype.indexOf.call(dt.types, "Files") !== -1) return true;
  return !!(dt.files && dt.files.length);
}

// --- the "Print this?" screen ------------------------------------------------
//
// Each file is uploaded as soon as it is chosen. The website turns Word,
// Excel and other files into a PDF, and the page shows that PDF, so the
// preview is exactly what will print. Nothing prints until Print is pressed.
// A printout sent to the "PrintBridge" printer from Excel, Word or any
// other program arrives the same way, already uploaded (see ?upload= below).

const PAPER_MM = {
  a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148],
  letter: [215.9, 279.4], legal: [215.9, 355.6], tabloid: [279.4, 431.8],
  executive: [184.2, 266.7], statement: [139.7, 215.9],
};
const MAX_THUMBS = 60;          // pages previewed; more can still be printed
const layout = { orientation: "auto", scaling: "fit" };
let activeIndex = 0;
let viewPage = 0;               // page shown large (1-based), 0 = closed
let uploadCounter = 0;

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.js";
}

function openPrintModalWith(files) {
  const tooBig = files.filter((f) => f.size > maxUploadMb * 1024 * 1024);
  const fitting = files.filter((f) => f.size <= maxUploadMb * 1024 * 1024);

  if (!fitting.length) {
    setPageMessage(
      (files.length > 1 ? "Those files are each bigger than " : "That file is bigger than ") +
        maxUploadMb + " MB, which is the limit here.",
      "error"
    );
    return;
  }

  discardPending();
  pendingFiles = fitting.map((file) => newEntry({ name: file.name, size: file.size, file }));
  showPrintModal(tooBig.length ? tooBig.length + " file(s) were too big and have been left out." : "");
  for (const entry of pendingFiles) uploadEntry(entry);
}

// A printout from another program, already on the website.
async function openPrintModalWithUpload(id) {
  let info;
  try {
    info = await api("/api/uploads/" + encodeURIComponent(id));
  } catch (err) {
    setPageMessage(err.message, "error");
    return;
  }
  discardPending();
  const entry = newEntry({ name: info.fileName, size: info.size, file: null });
  entry.uploadId = info.id;
  entry.fileUrl = info.fileUrl;
  entry.status = "ready";
  entry.fromPrinter = info.source === "printer";
  pendingFiles = [entry];
  showPrintModal("");
  loadPreview(entry);
}

function newEntry(fields) {
  return Object.assign({
    key: ++uploadCounter,
    status: "uploading",   // uploading | preparing | ready | error
    progress: 0,
    error: "",
    uploadId: null,
    fileUrl: null,
    pdf: null,
    pageCount: 0,
    pageSizes: [],         // [width, height] in points, as the page is shown
    chosen: new Set(),     // empty = every page
    canvases: new Map(),   // page number -> rendered canvas
    previewError: "",
  }, fields);
}

async function showPrintModal(message) {
  activeIndex = 0;
  $("printMessage").className = "modal-message" + (message ? " warn" : "");
  $("printMessage").textContent = message || "";
  $("optionsFold").open = false;
  if (!printers.length) {
    try { await loadPrinters(true); } catch (err) { /* shown below as "no printers" */ }
  }
  renderPrinterPick();
  renderOptions();
  renderSegments();
  renderPrintModal();
  $("printModal").hidden = false;
}

function closePrintModal() {
  closePageView();
  $("printModal").hidden = true;
  discardPending();
}

// Anything uploaded but not printed is thrown away on the website too.
function discardPending() {
  for (const entry of pendingFiles) {
    entry.cancelled = true;
    if (entry.xhr) { try { entry.xhr.abort(); } catch (err) { /* already done */ } }
    if (entry.pdf) { try { entry.pdf.destroy(); } catch (err) { /* already gone */ } }
    if (entry.uploadId && !entry.printed) {
      fetch("/api/uploads/" + encodeURIComponent(entry.uploadId), { method: "DELETE" }).catch(() => {});
    }
  }
  pendingFiles = [];
}

function uploadEntry(entry) {
  const form = new FormData();
  form.append("file", entry.file);
  const xhr = new XMLHttpRequest();
  entry.xhr = xhr;
  xhr.open("POST", "/api/uploads");
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    entry.progress = Math.round((event.loaded / event.total) * 100);
    if (entry.progress >= 100) entry.status = "preparing";
    renderFileList();
    if (pendingFiles[activeIndex] === entry) renderPreview();
  };
  xhr.onload = () => {
    entry.xhr = null;
    let data = {};
    try { data = JSON.parse(xhr.responseText || "{}"); } catch (err) { data = {}; }
    if (entry.cancelled) {
      // Closed before it was ready: throw it away on the website too.
      if (data.upload) fetch("/api/uploads/" + encodeURIComponent(data.upload.id), { method: "DELETE" }).catch(() => {});
      return;
    }
    if (xhr.status >= 200 && xhr.status < 300 && data.upload) {
      entry.uploadId = data.upload.id;
      entry.fileUrl = data.upload.fileUrl;
      entry.status = "ready";
      loadPreview(entry);
    } else {
      entry.status = "error";
      entry.error = data.error || "It couldn't be prepared for printing.";
    }
    renderPrintModal();
  };
  xhr.onerror = () => {
    entry.xhr = null;
    if (entry.cancelled) return;
    entry.status = "error";
    entry.error = "It didn't reach the printing website. Check the Wi-Fi and try again.";
    renderPrintModal();
  };
  xhr.send(form);
}

async function loadPreview(entry) {
  if (!window.pdfjsLib) {
    entry.previewError = "A preview can't be shown on this device, but it will still print.";
    renderPrintModal();
    return;
  }
  try {
    const pdf = await window.pdfjsLib.getDocument({
      url: entry.fileUrl,
      isEvalSupported: false, // never run code found inside a PDF
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    }).promise;
    if (entry.cancelled) { pdf.destroy(); return; }
    entry.pdf = pdf;
    entry.pageCount = pdf.numPages;
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_THUMBS); n++) {
      const page = await pdf.getPage(n);
      const view = page.getViewport({ scale: 1 });
      entry.pageSizes[n] = [view.width, view.height];
    }
  } catch (err) {
    entry.previewError = "The preview couldn't be shown, but the file can still be printed.";
  }
  renderPrintModal();
}

function renderPrintModal() {
  const count = pendingFiles.length;
  $("printModalTitle").textContent = count > 1 ? "Print these " + count + " files?" : "Print this?";
  renderFileList();
  renderPreview();
  renderRangesField();
  updatePrintButton();
}

function renderFileList() {
  const box = $("fileList");
  box.innerHTML = "";

  pendingFiles.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "file-chip" + (index === activeIndex && pendingFiles.length > 1 ? " active" : "") +
      (entry.status === "error" ? " failed" : "");
    if (pendingFiles.length > 1) {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.onclick = () => { activeIndex = index; renderPrintModal(); };
      row.onkeydown = (event) => { if (event.key === "Enter") row.onclick(); };
    }

    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = entry.name;
    row.appendChild(name);

    const size = document.createElement("span");
    size.className = "fsize";
    size.textContent =
      entry.status === "uploading" ? "Sending " + entry.progress + "%" :
      entry.status === "preparing" ? "Getting it ready..." :
      entry.status === "error" ? "Can't print" :
      entry.pageCount ? entry.pageCount + (entry.pageCount === 1 ? " page" : " pages") :
      formatSize(entry.size);
    row.appendChild(size);

    if (pendingFiles.length > 1) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.innerHTML = "&times;";
      remove.title = "Leave this one out";
      remove.setAttribute("aria-label", "Leave out " + entry.name);
      remove.onclick = (event) => {
        event.stopPropagation();
        const [gone] = pendingFiles.splice(index, 1);
        const rest = pendingFiles;
        pendingFiles = [gone];
        discardPending();
        pendingFiles = rest;
        if (!pendingFiles.length) { closePrintModal(); return; }
        activeIndex = Math.min(activeIndex, pendingFiles.length - 1);
        renderPrintModal();
      };
      row.appendChild(remove);
    }

    box.appendChild(row);
  });
}

function activeEntry() {
  return pendingFiles[activeIndex] || null;
}

function renderPreview() {
  const entry = activeEntry();
  const status = $("previewStatus");
  const thumbs = $("thumbs");
  const hint = $("previewHint");
  thumbs.innerHTML = "";
  hint.hidden = true;
  status.className = "preview-status";
  if (!entry) return;

  if (entry.status === "uploading" || entry.status === "preparing") {
    status.innerHTML = '<span class="spinner" aria-hidden="true"></span>' +
      (entry.status === "uploading" ? "Sending the file..." : "Getting it ready to print. Word and Excel files take a few seconds...");
    return;
  }
  if (entry.status === "error") {
    status.className = "preview-status error";
    status.textContent = entry.error;
    return;
  }
  if (entry.previewError) {
    status.textContent = entry.previewError;
    return;
  }
  if (!entry.pdf) {
    status.innerHTML = '<span class="spinner" aria-hidden="true"></span>Making the preview...';
    return;
  }
  status.textContent = entry.fromPrinter ? "Sent from another program on a computer. Check it, then press Print." : "";

  const shown = Math.min(entry.pageCount, MAX_THUMBS);
  for (let n = 1; n <= shown; n++) thumbs.appendChild(makeThumb(entry, n));
  if (entry.pageCount > shown) {
    const more = document.createElement("div");
    more.className = "thumbs-more";
    more.textContent = "and " + (entry.pageCount - shown) + " more pages. Type page numbers in Pages to choose from those.";
    thumbs.appendChild(more);
  }
  hint.hidden = entry.pageCount < 2;
  hint.innerHTML = entry.chosen.size
    ? "Printing only the ticked pages. <button type=\"button\" class=\"linklike\" id=\"allPages\">Print all pages</button>"
    : "Tick pages to print just those. Tap a page to see it bigger.";
  const all = $("allPages");
  if (all) all.onclick = () => { entry.chosen.clear(); entry.rangesBad = false; renderPrintModal(); };
}

// Where the page sits on the sheet of paper, as fractions of the paper, for
// the chosen paper size, orientation and scaling. Mirrors what the printer
// computer does (SumatraPDF / CUPS): "automatic" turns the paper to suit
// the page; "fit" leaves a small margin, as printers can't print to the edge.
function placeOnPaper(pageW, pageH) {
  const paperName = ($("optPaper") ? $("optPaper").value : "") || "A4";
  const mm = PAPER_MM[String(paperName).toLowerCase()] || PAPER_MM.a4;
  let paperW = (mm[0] * 72) / 25.4;
  let paperH = (mm[1] * 72) / 25.4;
  const landscape = layout.orientation === "landscape" || (layout.orientation === "auto" && pageW > pageH);
  if (landscape) { const t = paperW; paperW = paperH; paperH = t; }
  const margin = 12; // points, about 4 mm
  const scale = layout.scaling === "actual"
    ? 1
    : Math.min((paperW - 2 * margin) / pageW, (paperH - 2 * margin) / pageH);
  const w = pageW * scale;
  const h = pageH * scale;
  return {
    ratio: paperW / paperH,
    left: ((paperW - w) / 2) / paperW,
    top: ((paperH - h) / 2) / paperH,
    width: w / paperW,
    height: h / paperH,
    clipped: w > paperW + 1 || h > paperH + 1,
  };
}

// The sheet's shape. aspect-ratio where the browser has it (sizes
// correctly inside scrolling rows); a padding trick for older browsers.
const HAS_ASPECT = !!(window.CSS && CSS.supports && CSS.supports("aspect-ratio", "1 / 1"));
function setPaperShape(el, ratio) {
  if (HAS_ASPECT) {
    el.style.aspectRatio = String(ratio);
    el.style.height = "auto";
  } else {
    el.style.paddingTop = (100 / ratio) + "%";
  }
}

function makeThumb(entry, n) {
  const size = entry.pageSizes[n] || [595, 842];
  const place = placeOnPaper(size[0], size[1]);
  const chosen = entry.chosen.has(n);
  const dimmed = entry.chosen.size && !chosen;

  const card = document.createElement("div");
  card.className = "thumb" + (chosen ? " chosen" : "") + (dimmed ? " dimmed" : "");

  const paper = document.createElement("button");
  paper.type = "button";
  paper.className = "paper";
  setPaperShape(paper, place.ratio);
  paper.title = "See page " + n + " bigger";
  paper.onclick = () => openPageView(n);

  const holder = document.createElement("div");
  holder.className = "page-img";
  holder.style.left = place.left * 100 + "%";
  holder.style.top = place.top * 100 + "%";
  holder.style.width = place.width * 100 + "%";
  holder.style.height = place.height * 100 + "%";
  paper.appendChild(holder);
  drawPageInto(entry, n, holder, 260);
  card.appendChild(paper);

  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "tick";
  tick.setAttribute("aria-pressed", chosen ? "true" : "false");
  tick.setAttribute("aria-label", (chosen ? "Unchoose page " : "Choose page ") + n);
  tick.title = chosen ? "Chosen: this page prints" : "Choose this page";
  tick.innerHTML = chosen ? "&#10003;" : "";
  tick.onclick = () => togglePage(entry, n);
  card.appendChild(tick);

  const label = document.createElement("div");
  label.className = "thumb-label";
  label.textContent = String(n) + (place.clipped ? " (cut off)" : "");
  card.appendChild(label);
  return card;
}

// Renders a page once per size and reuses the picture after that.
async function drawPageInto(entry, n, holder, cssWidth) {
  // Let the caller put the holder on the page first (it is still being
  // built when this is called).
  await null;
  const key = n + "@" + cssWidth;
  let canvas = entry.canvases.get(key);
  if (!canvas) {
    try {
      const page = await entry.pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (cssWidth * ratio) / base.width });
      canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      entry.canvases.set(key, canvas);
    } catch (err) {
      return;
    }
  }
  if (!holder.isConnected) return;
  const img = document.createElement("img");
  img.alt = "Page " + n;
  img.src = canvas.toDataURL("image/png");
  holder.innerHTML = "";
  holder.appendChild(img);
}

function togglePage(entry, n) {
  // Picking pages by tapping replaces whatever was typed.
  entry.rangesBad = false;
  if (entry.chosen.has(n)) entry.chosen.delete(n);
  else entry.chosen.add(n);
  renderPrintModal();
  if (viewPage) renderPageView();
}

// {1,2,3,5} -> "1-3,5"
function rangesText(set) {
  const pages = [...set].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(j > i ? pages[i] + "-" + pages[j] : String(pages[i]));
    i = j;
  }
  return parts.join(",");
}

// "1-3, 5" -> {1,2,3,5}; null if it can't be understood.
function parseRanges(text, pageCount) {
  const clean = String(text || "").replace(/\s+/g, "");
  const out = new Set();
  if (!clean) return out;
  if (!/^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/.test(clean)) return null;
  for (const part of clean.split(",")) {
    const [a, b] = part.split("-").map((x) => parseInt(x, 10));
    const from = Math.min(a, b || a);
    const to = Math.max(a, b || a);
    if (from < 1 || (pageCount && to > pageCount)) return null;
    for (let n = from; n <= to && out.size <= 5000; n++) out.add(n);
  }
  return out;
}

function renderRangesField() {
  const entry = activeEntry();
  const input = $("optRanges");
  const note = $("rangesNote");
  $("optRangesLabel").textContent =
    pendingFiles.length > 1 && entry ? "Pages of " + entry.name : "Pages";
  // Something typed that can't be understood stays as typed, with its
  // warning, rather than quietly turning back into the last good choice -
  // that choice could be just the first page of what was being typed
  // ("1" on the way to "12"), and Print would then print only that.
  if (entry && entry.rangesBad) {
    if (document.activeElement !== input) input.value = entry.rangesTyped || "";
    note.className = "field-note error";
    note.textContent = entry.pageCount
      ? "Use page numbers from 1 to " + entry.pageCount + ", like 1-3 or 2,5."
      : "Use page numbers like 1-3 or 2,5.";
    input.disabled = entry.status === "error";
    return;
  }
  if (document.activeElement !== input) input.value = entry ? rangesText(entry.chosen) : "";
  note.className = "field-note";
  note.textContent = entry && entry.pageCount ? "This file has " + entry.pageCount + (entry.pageCount === 1 ? " page." : " pages.") : "";
  input.disabled = !entry || entry.status === "error";
}

function onRangesTyped() {
  const entry = activeEntry();
  if (!entry) return;
  const parsed = parseRanges($("optRanges").value, entry.pageCount);
  const note = $("rangesNote");
  entry.rangesBad = parsed === null;
  entry.rangesTyped = $("optRanges").value;
  if (parsed === null) {
    note.className = "field-note error";
    note.textContent = entry.pageCount
      ? "Use page numbers from 1 to " + entry.pageCount + ", like 1-3 or 2,5."
      : "Use page numbers like 1-3 or 2,5.";
    return;
  }
  entry.chosen = parsed;
  renderFileList();
  renderPreview();
  note.className = "field-note";
  note.textContent = entry.pageCount ? "This file has " + entry.pageCount + (entry.pageCount === 1 ? " page." : " pages.") : "";
}

function renderSegments() {
  for (const [id, key] of [["segOrientation", "orientation"], ["segScaling", "scaling"]]) {
    for (const button of $(id).querySelectorAll("button")) {
      const on = button.dataset.value === layout[key];
      button.classList.toggle("on", on);
      button.setAttribute("aria-checked", on ? "true" : "false");
    }
  }
}

function setupSegments() {
  for (const [id, key] of [["segOrientation", "orientation"], ["segScaling", "scaling"]]) {
    for (const button of $(id).querySelectorAll("button")) {
      button.addEventListener("click", () => {
        layout[key] = button.dataset.value;
        renderSegments();
        renderPreview();
        if (viewPage) renderPageView();
      });
    }
  }
}

function updatePrintButton() {
  const button = $("printButton");
  const ready = pendingFiles.filter((e) => e.status === "ready");
  const waiting = pendingFiles.some((e) => e.status === "uploading" || e.status === "preparing");
  button.disabled = !selectedPrinter() || waiting || !ready.length;
  button.textContent = waiting ? "Getting it ready..." : ready.length > 1 ? "Print " + ready.length + " files" : "Print";
}

// --- one page, large -----------------------------------------------------------

function openPageView(n) {
  viewPage = n;
  $("pageView").hidden = false;
  renderPageView();
}

function closePageView() {
  viewPage = 0;
  $("pageView").hidden = true;
}

function renderPageView() {
  const entry = activeEntry();
  if (!entry || !entry.pdf || !viewPage) return;
  const shown = Math.min(entry.pageCount, MAX_THUMBS);
  $("pvTitle").textContent = "Page " + viewPage + " of " + entry.pageCount;
  const size = entry.pageSizes[viewPage] || [595, 842];
  const place = placeOnPaper(size[0], size[1]);
  const stage = $("pvStage");
  stage.innerHTML = "";
  const paper = document.createElement("div");
  paper.className = "paper big";
  const maxW = Math.min(stage.clientWidth || 600, 900) - 8;
  const maxH = Math.max(window.innerHeight - 190, 240);
  const width = Math.min(maxW, maxH * place.ratio);
  paper.style.width = width + "px";
  paper.style.height = width / place.ratio + "px";
  const holder = document.createElement("div");
  holder.className = "page-img";
  holder.style.left = place.left * 100 + "%";
  holder.style.top = place.top * 100 + "%";
  holder.style.width = place.width * 100 + "%";
  holder.style.height = place.height * 100 + "%";
  paper.appendChild(holder);
  stage.appendChild(paper);
  // Rendered in steps of 100 px so a few sizes are reused as it's resized.
  drawPageInto(entry, viewPage, holder, Math.max(200, Math.ceil((width * place.width) / 100) * 100));

  const chosen = entry.chosen.has(viewPage);
  const choose = $("pvChoose");
  choose.className = "pv-choose" + (chosen ? " on" : "");
  choose.innerHTML = chosen ? "&#10003; Chosen" : "Choose this page";
  choose.hidden = entry.pageCount < 2;
  $("pvPrev").disabled = viewPage <= 1;
  $("pvNext").disabled = viewPage >= shown;
}

function setupPageView() {
  $("pvClose").onclick = closePageView;
  $("pageView").addEventListener("click", (event) => {
    if (event.target.id === "pageView") closePageView();
  });
  $("pvPrev").onclick = () => { if (viewPage > 1) { viewPage--; renderPageView(); } };
  $("pvNext").onclick = () => { viewPage++; renderPageView(); };
  $("pvChoose").onclick = () => { const e = activeEntry(); if (e) togglePage(e, viewPage); };
  document.addEventListener("keydown", (event) => {
    if (!viewPage) return;
    if (event.key === "ArrowLeft") $("pvPrev").click();
    if (event.key === "ArrowRight" && !$("pvNext").disabled) $("pvNext").click();
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// --- choosing a printer ----------------------------------------------------

function renderPrinterPick() {
  const box = $("printerPick");
  box.innerHTML = "";

  const usable = printers.filter((p) => p.online);
  const list = usable.length ? usable : printers;

  if (!list.length) {
    box.innerHTML =
      '<div class="page-message warn" style="margin:0">No printers are set up yet. ' +
      "Run <strong>PrintBridge Setup</strong> on the computer the printer is plugged into " +
      "and choose &ldquo;This computer shares a printer&rdquo;. Its printers then appear here by themselves.</div>";
    chosenPrinterId = null;
    updatePrintButton();
    return;
  }

  // Keep the previous choice if it's still there, else use the first one.
  if (!chosenPrinterId || !list.some((p) => p.id === chosenPrinterId)) {
    chosenPrinterId = list[0].id;
  }

  // One printer: don't make them choose. Just say where it's going.
  if (list.length === 1) {
    const only = list[0];
    const div = document.createElement("div");
    div.className = "going-to";
    div.innerHTML =
      "Going to <strong>" + escapeHtml(only.name) + "</strong>" +
      (only.online ? "" : ' <span class="offline-note">(it\'s off right now &mdash; this will wait)</span>');
    box.appendChild(div);
    updatePrintButton();
    return;
  }

  const label = document.createElement("label");
  label.textContent = "Which printer?";
  box.appendChild(label);

  const pick = document.createElement("div");
  pick.className = "printer-pick";

  for (const printer of list) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "printer-option" + (printer.id === chosenPrinterId ? " selected" : "");
    option.innerHTML =
      '<span class="dot ' + (printer.online ? "on" : "off") + '"></span>' +
      '<span class="grow"><span class="pname">' + escapeHtml(printer.name) + "</span>" +
      '<br><span class="pmeta">' + escapeHtml(printer.computerName) +
      (printer.online ? "" : " &mdash; off right now") + "</span></span>";
    option.onclick = () => {
      chosenPrinterId = printer.id;
      renderPrinterPick();
      renderOptions();
      renderPreview();
    };
    pick.appendChild(option);
  }

  box.appendChild(pick);
  updatePrintButton();
}

function selectedPrinter() {
  return printers.find((p) => p.id === chosenPrinterId) || null;
}

// Show only the settings this printer actually supports.
function renderOptions() {
  const box = $("options");
  const printer = selectedPrinter();
  box.innerHTML = "";
  if (!printer) return;

  const caps = printer.capabilities || {};
  const papers = Array.isArray(caps.paperSizes) ? caps.paperSizes : [];
  const maxCopies = Number(caps.maxCopies) || 99;

  const copies = document.createElement("input");
  copies.type = "number";
  copies.id = "optCopies";
  copies.min = "1";
  copies.max = String(maxCopies);
  copies.value = "1";
  box.appendChild(field("Copies", copies));

  if (papers.length > 0) {
    const preferred = caps.defaultPaper || (papers.includes("A4") ? "A4" : papers[0]);
    const paper = selectEl("optPaper", papers.map((p) => [p, p]), preferred);
    paper.addEventListener("change", () => { renderPreview(); if (viewPage) renderPageView(); });
    box.appendChild(field("Paper size", paper));
  }

  if (caps.color === true) {
    box.appendChild(field("Colour", selectEl("optColor", [
      ["monochrome", "Black and white"],
      ["color", "Colour"],
    ], "monochrome")));
  }

  if (caps.duplex === true) {
    box.appendChild(field("Sides", selectEl("optSides", [
      ["one-sided", "Single-sided"],
      ["two-sided-long-edge", "Double-sided (flip on long edge)"],
      ["two-sided-short-edge", "Double-sided (flip on short edge)"],
    ], "one-sided")));
  }

  $("layoutOpts").querySelector("#optRanges").closest(".field").hidden = caps.pageRanges === false;
}

function field(labelText, control) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  label.setAttribute("for", control.id);
  wrap.appendChild(label);
  wrap.appendChild(control);
  return wrap;
}

function selectEl(id, pairs, selected) {
  const select = document.createElement("select");
  select.id = id;
  for (const [value, label] of pairs) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (value === selected) option.selected = true;
    select.appendChild(option);
  }
  return select;
}

async function loadPrinters(force) {
  // Never rebuild the form underneath someone who is filling it in.
  if (!force && !$("printModal").hidden) return;
  printers = await api("/api/printers");
}

// --- sending the job -------------------------------------------------------

function setupPrintModal() {
  $("closePrintModal").onclick = closePrintModal;
  $("printModal").addEventListener("click", (event) => {
    if (event.target.id === "printModal") closePrintModal();
  });
  $("printButton").addEventListener("click", submitPrint);
  $("optRanges").addEventListener("input", onRangesTyped);
  $("optRanges").addEventListener("blur", renderRangesField);
  setupSegments();
  setupPageView();
}

async function submitPrint() {
  const button = $("printButton");
  const box = $("printMessage");
  box.className = "modal-message";
  box.textContent = "";

  const printer = selectedPrinter();
  const ready = pendingFiles.filter((e) => e.status === "ready");
  const unclear = ready.find((e) => e.rangesBad);
  if (unclear) {
    box.className = "modal-message error";
    box.textContent = "Check the pages to print" + (ready.length > 1 ? " for " + unclear.name : "") +
      ": use page numbers from 1 to " + (unclear.pageCount || "the last page") + ", like 1-3 or 2,5.";
    return;
  }
  if (!printer || !ready.length) {
    box.className = "modal-message error";
    box.textContent = printer ? "There's nothing ready to print yet." : "Pick a printer first.";
    return;
  }

  const common = {
    paper: $("optPaper") ? $("optPaper").value : null,
    color: $("optColor") ? $("optColor").value : "monochrome",
    sides: $("optSides") ? $("optSides").value : "one-sided",
    copies: $("optCopies") ? $("optCopies").value : 1,
    orientation: layout.orientation,
    scaling: layout.scaling,
  };

  button.disabled = true;
  button.textContent = "Sending...";

  const label = myName() || "Someone";
  const failed = [];
  let sent = 0;

  for (const entry of ready) {
    try {
      await api("/api/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId: entry.uploadId,
          printerId: printer.id,
          options: Object.assign({}, common, { pageRanges: rangesText(entry.chosen) }),
          allowFailover: $("failover").checked ? "true" : "false",
          label,
        }),
      });
      entry.printed = true;
      sent += 1;
    } catch (err) {
      failed.push(entry.name + ": " + err.message);
    }
  }
  const skipped = pendingFiles.filter((e) => e.status === "error").map((e) => e.name + ": " + e.error);

  button.disabled = false;
  updatePrintButton();

  if (failed.length && !sent) {
    box.className = "modal-message error";
    box.textContent = failed.join(" / ");
    return;
  }

  closePrintModal();
  await loadQueue().catch(() => {});

  const problems = failed.concat(skipped);
  if (problems.length) {
    setPageMessage("Sent " + sent + ", but some didn't go: " + problems.join(" / "), "warn");
  } else {
    setPageMessage(
      sent > 1
        ? "Sent " + sent + " files to " + printer.name + "."
        : "Sent to " + printer.name + ". Go and collect it.",
      "ok"
    );
    setTimeout(() => setPageMessage(null), 6000);
  }
}

// --- your name -------------------------------------------------------------

function setupNameModal() {
  $("welcomeSave").onclick = () => {
    const name = $("welcomeName").value.trim() || "Someone";
    setMyName(name);
    $("welcomeModal").hidden = true;
    if (afterWelcome) { const next = afterWelcome; afterWelcome = null; next(); }
  };
  $("welcomeName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("welcomeSave").click();
  });

  $("nameChip").onclick = () => {
    $("nameInput").value = myName();
    $("nameModal").hidden = false;
    setTimeout(() => $("nameInput").focus(), 80);
  };
  $("closeName").onclick = () => { $("nameModal").hidden = true; };
  $("nameModal").addEventListener("click", (event) => {
    if (event.target.id === "nameModal") $("nameModal").hidden = true;
  });
  $("nameSave").onclick = () => {
    setMyName($("nameInput").value.trim() || "Someone");
    $("nameModal").hidden = true;
  };
  $("nameInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("nameSave").click();
  });
}

function setupEscapeToClose() {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("pageView").hidden) { closePageView(); return; }
    if (!$("printModal").hidden) { closePrintModal(); return; }
    if (!$("nameModal").hidden) { $("nameModal").hidden = true; return; }
    if (!$("helpModal").hidden) { $("helpModal").hidden = true; }
    // The welcome prompt deliberately has no escape - it's one box, and
    // the page needs a name before anything is worth doing.
  });
}

// --- help -------------------------------------------------------------------

let helpCooldownUntil = 0;

function setupHelpModal() {
  $("helpBtn").onclick = () => {
    $("helpFormMessage").className = "modal-message";
    $("helpFormMessage").textContent = "";
    $("helpMessage").value = "";
    $("helpModal").hidden = false;
  };
  $("closeHelp").onclick = () => { $("helpModal").hidden = true; };
  $("helpModal").addEventListener("click", (event) => {
    if (event.target.id === "helpModal") $("helpModal").hidden = true;
  });
  $("sendHelp").onclick = sendHelpRequest;
}

async function sendHelpRequest() {
  const button = $("sendHelp");
  const box = $("helpFormMessage");
  button.disabled = true;

  try {
    await api("/api/help", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: $("helpMessage").value, label: myName() || "Someone" }),
    });
    box.className = "modal-message ok";
    box.textContent = "Asked. Someone should be over shortly.";
    helpCooldownUntil = Date.now() + 60000;
    setTimeout(() => { $("helpModal").hidden = true; }, 1300);
    startHelpCooldown();
  } catch (err) {
    box.className = "modal-message error";
    box.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

function startHelpCooldown() {
  const button = $("helpBtn");
  const tick = () => {
    const secondsLeft = Math.ceil((helpCooldownUntil - Date.now()) / 1000);
    if (secondsLeft <= 0) {
      button.disabled = false;
      button.textContent = "Need help?";
      return;
    }
    button.disabled = true;
    button.textContent = "Asked (" + secondsLeft + "s)";
    setTimeout(tick, 1000);
  };
  tick();
}

// --- the shared queue --------------------------------------------------------

// Starts with the brand's own two colours (desktop/lib/brand.js), then
// fills out with others that read clearly against them, so a queue list
// never looks like it belongs to a different product.
const QUEUE_COLORS = ["#1E6FBF", "#21A67B", "#7c3aed", "#db2777", "#4f46e5", "#0891b2", "#b45309"];

function colorForPrinter(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return QUEUE_COLORS[hash % QUEUE_COLORS.length];
}

// The website's own words for a job's state, as people should read them.
const STATUS_LABELS = {
  queued: "Waiting",
  sent: "Sending",
  accepted: "Sending",
  downloading: "Sending",
  printing: "Printing",
  retrying: "Trying another printer",
  done: "Printed",
  failed: "Didn't print",
  cancelled: "Cancelled",
};

function formatEta(seconds) {
  if (seconds === null || seconds === undefined) return "until the printer is back on";
  if (seconds < 60) return "any moment";
  const minutes = Math.round(seconds / 60);
  return "about " + minutes + (minutes === 1 ? " minute" : " minutes");
}

async function loadQueue() {
  renderQueue(await api("/api/queue"));
}

// Finished jobs drop out of the queue. If one of yours dropped out because
// it failed, say so and why - otherwise it would just silently disappear.
let myActiveJobIds = null; // null until the first queue arrives
let failureTimer = null;

function noticeMyFinishedJobs(list) {
  const nowMine = new Set(list.filter((job) => job.isMine).map((job) => job.id));
  const gone = myActiveJobIds ? [...myActiveJobIds].filter((id) => !nowMine.has(id)) : [];
  myActiveJobIds = nowMine;
  if (!gone.length) return;

  api("/api/my-jobs")
    .then((mine) => {
      const failed = mine.filter((job) => gone.includes(job.id) && job.status === "failed");
      if (!failed.length) return;
      setPageMessage(
        failed
          .map((job) => "Didn't print: " + job.fileName + " - " + (job.statusMessage || "the printer reported a problem."))
          .join(" / "),
        "error"
      );
      clearTimeout(failureTimer);
      failureTimer = setTimeout(() => setPageMessage(null), 30000);
    })
    .catch(() => {});
}

function renderQueue(list) {
  noticeMyFinishedJobs(list);
  const body = $("queueTable").querySelector("tbody");
  body.innerHTML = "";

  for (const job of list) {
    const tr = document.createElement("tr");
    if (job.isMine) tr.className = "mine";

    const posCell = document.createElement("td");
    posCell.textContent = String(job.position);
    tr.appendChild(posCell);

    const whoCell = document.createElement("td");
    whoCell.innerHTML = job.isMine
      ? '<span class="you-tag">You</span>'
      : escapeHtml(job.label || "Someone");
    tr.appendChild(whoCell);

    const printerCell = document.createElement("td");
    printerCell.innerHTML =
      '<span class="printer-tag" style="background:' + colorForPrinter(job.printerName) + '"></span>' +
      escapeHtml(job.printerName) +
      (job.printerOnline ? "" : ' <span class="offline-note">(off)</span>');
    tr.appendChild(printerCell);

    // Your own jobs show the file name and, under it, what is happening to
    // it ("Waiting for ... to come online", "trying ... instead"); everyone
    // else's show only the rough wait.
    const statusCell = document.createElement("td");
    const fileLine = job.isMine && job.fileName ? '<div class="hint job-file">' + escapeHtml(job.fileName) + "</div>" : "";
    const detail = (job.isMine && job.statusMessage) || formatEta(job.etaSeconds);
    statusCell.innerHTML =
      '<span class="status ' + escapeHtml(job.status) + '">' + escapeHtml(STATUS_LABELS[job.status] || job.status) + "</span>" +
      fileLine +
      '<div class="hint">' + escapeHtml(detail) + "</div>";
    tr.appendChild(statusCell);

    const actions = document.createElement("td");
    if (job.isMine && job.status === "queued") {
      const cancel = document.createElement("button");
      cancel.className = "danger";
      cancel.textContent = "Cancel";
      cancel.onclick = async () => {
        cancel.disabled = true;
        try {
          await api("/api/jobs/" + job.id + "/cancel", { method: "POST" });
          // Normally the live updates remove the row; this also covers a
          // page whose live connection has dropped.
          loadQueue().catch(() => {});
        } catch (err) {
          setPageMessage(err.message, "warn");
          cancel.disabled = false;
          loadQueue().catch(() => {});
        }
      };
      actions.appendChild(cancel);
    }
    tr.appendChild(actions);

    body.appendChild(tr);
  }

  $("queueHint").textContent = list.length ? "" : "Nothing printing right now.";
}

// --- help alerts, shown to everyone ------------------------------------------

const openAlerts = new Map();

function showAlertBanner(alert, quiet) {
  if (openAlerts.has(alert.id)) return;

  const el = document.createElement("div");
  el.className = "alert-banner";
  el.innerHTML =
    '<div class="alert-banner-text"><strong>' + escapeHtml(alert.label || "Someone") +
    "</strong> needs help at a printer" +
    (alert.message ? '<div class="hint">' + escapeHtml(alert.message) + "</div>" : "") +
    "</div>";

  const done = document.createElement("button");
  done.className = "secondary";
  done.textContent = "I've got it";
  done.onclick = async () => {
    done.disabled = true;
    try {
      await api("/api/help/" + alert.id + "/resolve", { method: "POST" });
    } catch (err) {
      /* already handled by someone else - clearing it either way */
    }
    removeAlertBanner(alert.id);
  };
  el.appendChild(done);

  $("alertBanners").appendChild(el);
  openAlerts.set(alert.id, el);
  if (!quiet) playAlertSound();
}

function removeAlertBanner(id) {
  const el = openAlerts.get(id);
  if (el) {
    el.remove();
    openAlerts.delete(id);
  }
}

let audioContext = null;

function playAlertSound() {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = audioContext;
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  } catch (err) {
    /* browsers block audio until the page has been clicked - not worth chasing */
  }
}

// --- live updates -------------------------------------------------------------

let liveUpdatesBroken = false;

function rememberAddressesFromWhere(where) {
  api("/api/office-printing").then((about) => {
    rememberAddresses(Object.assign({}, where, { id: about.id || "" }));
  }).catch(() => rememberAddresses(where));
}

function listenForLiveUpdates() {
  const source = new EventSource("/api/stream");
  let wasBroken = false;

  source.onopen = () => {
    liveUpdatesBroken = false;
    if (!wasBroken) return;
    wasBroken = false;
    setPageMessage(null);
    loadQueue().catch(() => {});
    loadPrinters().catch(() => {});
  };

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      // A browser gives up for good on an error such as 404 - which is what
      // happens when another device has taken over the main computer's old address.
      liveUpdatesBroken = true;
      setPageMessage("Lost the connection to the printing website. Press \"Refresh address\" (top of the page) to look for the main computer again.", "error");
      return;
    }
    wasBroken = true;
    setPageMessage("Reconnecting...", "warn");
  };

  source.addEventListener("queue", (event) => {
    try { renderQueue(JSON.parse(event.data)); } catch (err) { /* ignore */ }
  });

  source.addEventListener("help", (event) => {
    try { showAlertBanner(JSON.parse(event.data)); } catch (err) { /* ignore */ }
  });

  source.addEventListener("help-resolved", (event) => {
    try { removeAlertBanner(JSON.parse(event.data).id); } catch (err) { /* ignore */ }
  });
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
