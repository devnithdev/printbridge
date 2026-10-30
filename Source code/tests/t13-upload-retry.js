// The "Print this?" screen must not stay on "Getting it ready..." forever when
// the connection goes quiet: it sends the file again, then shows an error.
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };

const src = fs.readFileSync(path.join(__dirname, "../server/public/app.js"), "utf8");
const code = src.slice(src.indexOf("const UPLOAD_TRIES"), src.indexOf("async function loadPreview"));

function setup() {
  const sent = [], timers = new Map(); let nextTimer = 1;
  class XHR {
    constructor() { this.upload = {}; sent.push(this); }
    open() {} send() {}
    abort() { this.aborted = true; if (this.onloadend) this.onloadend(); }
  }
  const box = {
    FormData: class { append() {} }, XMLHttpRequest: XHR, fetch: () => Promise.resolve(),
    setTimeout: (fn, ms) => { timers.set(nextTimer, { fn, ms }); return nextTimer++; },
    clearTimeout: (id) => timers.delete(id),
    renderPrintModal() {}, renderFileList() {}, renderPreview() {}, loadPreview() {},
    pendingFiles: [], activeIndex: 0,
  };
  vm.runInNewContext(code + "\nthis.uploadEntry = uploadEntry;", box);
  const quiet = () => { const [[id, t]] = timers; timers.delete(id); t.fn(); return t.ms; };
  return { box, sent, timers, quiet };
}
const entry = (name) => ({ name, file: {}, status: "uploading", progress: 0 });
const finish = (x) => { x.upload.onprogress({ lengthComputable: true, loaded: 1, total: 1 }); };
const answer = (x) => { x.status = 200; x.responseText = JSON.stringify({ upload: { id: "u1", fileUrl: "/f" } }); x.onload(); x.onloadend(); };

{ // stuck after the file was sent, then the second try works
  const { box, sent, timers, quiet } = setup(); const e = entry("a.pdf");
  box.uploadEntry(e); finish(sent[0]);
  ok(e.status === "preparing", "shows getting it ready once the file is sent");
  ok(quiet() === 20000, "a PDF is given up on after 20 seconds of quiet");
  ok(sent[0].aborted && sent.length === 2 && e.status === "uploading" && e.progress === 0, "the stuck try is dropped and the file is sent again");
  finish(sent[1]); answer(sent[1]);
  ok(e.status === "ready" && e.uploadId === "u1", "the second try makes it ready");
  ok(timers.size === 0, "nothing left waiting afterwards");
}
{ // never gets through: an error, not a spinner
  const { box, sent, timers, quiet } = setup(); const e = entry("a.PDF");
  box.uploadEntry(e); quiet(); quiet(); quiet();
  ok(sent.length === 3, "tries 3 times in all");
  ok(e.status === "error" && /Wi-Fi/.test(e.error), "then shows an error the person can act on");
  ok(timers.size === 0, "and stops trying");
}
{ // network error
  const { box, sent } = setup(); const e = entry("a.pdf");
  box.uploadEntry(e); sent[0].onerror(); sent[0].onloadend();
  ok(sent.length === 2, "a network error sends the file again too");
}
{ // Word files take a long time on the website and must not be cut off
  const { box, sent, quiet } = setup(); const e = entry("a.docx");
  box.uploadEntry(e); finish(sent[0]);
  ok(quiet() >= 120000, "a Word file gets longer than the 2 minute conversion limit");
}
{ // closed while waiting
  const { box, sent, timers } = setup(); const e = entry("a.pdf");
  box.uploadEntry(e); e.cancelled = true; sent[0].abort();
  ok(timers.size === 0 && sent.length === 1, "closing the screen stops it without sending again");
}
console.log(n + " checks passed");
