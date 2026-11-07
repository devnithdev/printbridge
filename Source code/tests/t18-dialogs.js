//Every pop-up on the printing pages tells screen readers that it is a pop-up, and what it is called, using role="dialog" and aria-labelledby attributes.

const fs = require("fs"), path = require("path"), assert = require("assert");
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("ok -", m); }

const page = fs.readFileSync(path.join(__dirname, "..", "server", "public", "index.html"), "utf8");
const overlays = page.match(/class="modal-overlay/g) || [];
const boxes = page.match(/<div class="modal[ "][^>]*>/g) || [];
ok(boxes.length > 0 && boxes.length === overlays.length, "each of the" + overlays.length + " pop-ups has one box");
for (const box of boxes) {
    const title = (box.match(/aria-labelledby="([^"]+)"/) || [])[1];
    ok(/role="dialog"/.test(box) && /aria-modal="true"/.test(box) && title, "pop-up is marked as a dialog with title: " + title);
    ok(new RegExp('<h2 id="' + title + '"').test(page), "its title " + title + " is on the page");
}

console.log(n + " checks passed");
process.exit(0);