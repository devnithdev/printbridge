// PrintBridge - proposal to management. Build: node proposal-build.js [out.docx]
// Figures come from proposal-img/ (screenshots of the website with sample data).
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, Footer, PageNumber, PageBreak, VerticalAlign, TabStopType, HeadingLevel,
} = require("docx");

const IMG = path.join(__dirname, "proposal-img") + path.sep;
const OUT = process.argv[2] || "PrintBridge-Proposal.docx";
const FONT = "Arial";
const W = 9638; // A4 text width with 2 cm margins
const BLACK = "000000", GREY = "595959", LIGHT = "EAF1F8", MID = "D9D9D9";
// PrintBridge colours (same as desktop/lib/brand.js)
const NAVY = "123F73", GREEN = "21A67B";

const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NOB = { top: none, bottom: none, left: none, right: none };
const thin = { style: BorderStyle.SINGLE, size: 4, color: "7F7F7F" };
const BOX = { top: thin, bottom: thin, left: thin, right: thin };

function runs(text, base = {}) {
  const out = []; const re = /(\*\*[^*]+\*\*|_[^_]+_)/g; let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const t = m[0];
    if (t.startsWith("**")) out.push(new TextRun({ text: t.slice(2, -2), bold: true, ...base }));
    else out.push(new TextRun({ text: t.slice(1, -1), italics: true, ...base }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out;
}
const P = (t, o = {}) => new Paragraph({ children: runs(t, o.run || {}), spacing: { after: o.after ?? 100, line: 264 }, alignment: o.align, keepNext: o.keepNext });
const small = (t, o = {}) => P(t, { ...o, run: { size: 17, color: o.color || BLACK, ...(o.run || {}) } });
const italicNote = (t) => new Paragraph({ children: runs(t, { italics: true, size: 18, color: GREY }), spacing: { after: 120 } });
const H = (t, first = false) => new Paragraph({
  keepNext: true,
  spacing: { before: first ? 0 : 240, after: 80 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: GREEN, space: 3 } },
  children: [new TextRun({ text: t, bold: true, size: 26, font: FONT, color: NAVY })],
});
const gap = (n = 80) => new Paragraph({ spacing: { after: n }, children: [] });
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });
const img = (file, w, h) => new ImageRun({ type: "png", data: fs.readFileSync(IMG + file), transformation: { width: w, height: h } });

function cell(children, w, o = {}) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders: o.borders || NOB,
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: "auto" } : undefined,
    margins: { top: o.mt ?? 80, bottom: o.mb ?? 80, left: o.ml ?? 110, right: o.mr ?? 110 },
    verticalAlign: o.valign, columnSpan: o.span,
    children: children.map((c) => (typeof c === "string" ? small(c) : c)),
  });
}
const table = (widths, rows, o = {}) => new Table({ width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths, rows, alignment: o.align });

// ---------- building blocks ----------
function statTiles(items) {
  const w = Math.floor(W / items.length);
  const sep = { style: BorderStyle.SINGLE, size: 4, color: "7F7F7F" };
  return table(items.map(() => w), [new TableRow({ children: items.map((it, i) => cell([
    new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: it[0], bold: true, size: 52, font: FONT, color: NAVY })] }),
    small(it[1], { color: GREY }),
  ], w, { borders: { top: none, bottom: { style: BorderStyle.SINGLE, size: 4, color: "7F7F7F" }, left: none, right: i < items.length - 1 ? sep : none }, ml: i ? 160 : 0 })) })]);
}

function twoByTwo(items) {
  const w = W / 2;
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push(new TableRow({ children: [0, 1].map((k) => {
      const it = items[i + k];
      return cell([
        new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: it[0], bold: true, size: 19 })] }),
        small(it[1]),
      ], w, { borders: { top: { style: BorderStyle.SINGLE, size: 4, color: "7F7F7F" }, bottom: none, left: none, right: none }, ml: k ? 160 : 0, mr: k ? 0 : 160 });
    }) }));
  }
  return table([w, w], rows);
}

function callout(title, text) {
  const border = { style: BorderStyle.SINGLE, size: 8, color: NAVY };
  return table([W], [new TableRow({ children: [cell([
    ...(title ? [new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: title, bold: true, size: 20 })] })] : []),
    small(text, { after: 20 }),
  ], W, { fill: LIGHT, borders: { top: border, bottom: border, left: border, right: border }, mt: 120, mb: 120, ml: 180, mr: 180 })] })]);
}

// Numbered steps with arrows between them.
function steps(items) {
  const arrowW = 280;
  const boxW = Math.floor((W - arrowW * (items.length - 1)) / items.length);
  const widths = []; items.forEach((_, i) => { widths.push(boxW); if (i < items.length - 1) widths.push(arrowW); });
  const border = { style: BorderStyle.SINGLE, size: 6, color: NAVY };
  const head = [], body = [];
  items.forEach((it, i) => {
    head.push(cell([new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(i + 1), bold: true, color: "FFFFFF", size: 22 })] })], boxW, { fill: NAVY, borders: { top: border, left: border, right: border, bottom: none }, mt: 40, mb: 40 }));
    body.push(cell([
      new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: it[0], bold: true, size: 18 })] }),
      small(it[1], { after: 0, run: { size: 16 } }),
    ], boxW, { borders: { top: none, left: border, right: border, bottom: border }, mt: 60 }));
    if (i < items.length - 1) {
      head.push(cell([gap(0)], arrowW, { ml: 0, mr: 0 }));
      body.push(cell([new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "→", size: 24 })] })], arrowW, { valign: VerticalAlign.CENTER, ml: 0, mr: 0 }));
    }
  });
  return table(widths, [new TableRow({ children: head }), new TableRow({ children: body })]);
}

function headedTable(headers, rows, widths, o = {}) {
  const hdr = new TableRow({ tableHeader: true, children: headers.map((h, i) => cell([new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF", size: 18 })] })], widths[i], { fill: NAVY, borders: BOX })) });
  return table(widths, [hdr, ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(Array.isArray(c) ? c : [c], widths[i], { borders: BOX, fill: o.fillCol === i ? LIGHT : undefined })) }))]);
}

function checkbox(t) {
  return new Paragraph({ spacing: { after: 90, line: 264 }, indent: { left: 400, hanging: 400 }, children: [new TextRun({ text: "☐\t", size: 22 }), ...runs(t, { size: 18 })], tabStops: [{ type: TabStopType.LEFT, position: 400 }] });
}
const bullet = (t, mark = "•") => new Paragraph({ spacing: { after: 40 }, indent: { left: 300, hanging: 240 }, children: [new TextRun({ text: mark + "\t", size: 18 }), ...runs(t, { size: 18 })], tabStops: [{ type: TabStopType.LEFT, position: 300 }] });

// ====================================================================
const c = [];

// ---------------- PAGE 1 ----------------
c.push(
  new Paragraph({ spacing: { after: 200 }, children: [img("printbridge-badge.png", 150, 48)] }),
  new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "PROPOSAL FOR MANAGEMENT   |   SEPTEMBER 2026", size: 15, color: GREY, characterSpacing: 40 })] }),
  new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: "Print from any device, in seconds", bold: true, size: 44, color: NAVY })] }),
  new Paragraph({ spacing: { after: 160 }, border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: GREEN, space: 6 } }, children: [new TextRun({ text: "Introducing PrintBridge", size: 22, color: GREY }), new TextRun({ text: "   \u00b7   \u2615 by @devnithdev", size: 18, color: GREEN, bold: true })] }),
  statTiles([
    ["0", "apps to install on phones, tablets or laptops"],
    ["0", "accounts or passwords to create or manage"],
    ["Free", "to run, using free, open-source software"],
  ]),
  H("Why we are proposing this"),
  P("Today, printing is easy only from the computer the printer is plugged into. From anywhere else, someone has to email the file to whoever sits at that computer, copy it onto a USB stick, or install printer software on their own laptop. Phones are the hardest of all, even though more and more of our documents and photos now arrive on them."),
  P("Each of those workarounds takes a few minutes and usually interrupts a colleague. PrintBridge removes them: anyone in the office can print from the device already in their hand."),
  H("What we are proposing"),
  P("A simple web page on the office Wi-Fi. A staff member scans a sign next to the printer with their phone camera, or types a short address on a laptop, picks the file, and taps Print. Nothing is installed on their device, and there is nothing to sign in to."),
  P("On office computers, people can also print from Excel, Word or any other program exactly as they do now, by choosing the **PrintBridge** printer. Either way, a preview shows every page before anything prints, so they can print just the pages they need, in portrait or landscape."),
  P("Our printers stay exactly where they are. One office computer that is normally switched on runs the page, and a small program on each computer that has a printer passes the jobs on. Everything stays inside the office network."),
  H("What each group gains"),
  twoByTwo([
    ["Staff", "Print from a phone, tablet or laptop in a few taps, including photos and WhatsApp or email attachments. They see a preview first and can print only the pages they need. They can see where their job is in the queue and cancel it if they change their mind."],
    ["Whoever sits next to the printer", "No more files forwarded by email or USB sticks handed over to print for someone else. Their computer only needs to stay switched on."],
    ["Management", "Less time lost on small printing errands. The queue shows who printed what, on which printer, so problems are easy to spot."],
    ["The company", "It uses the printers and computers we already have, costs nothing to run, and is set up to come back on its own after a power cut. Files are deleted as soon as they are printed."],
  ]),
  gap(120),
  callout("What we are asking for", "Approval to roll PrintBridge out to all staff for a one-month trial. It costs nothing to run. The seven decisions listed on page 5 are all we need to get started."),
  pageBreak(),
);

// ---------------- PAGE 2 ----------------
const shotW = 158, shotH = 269;
const figCell = (file, caption, w) => cell([
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [img(file, shotW, shotH)] }),
  new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: caption, size: 15, color: GREY })] }),
], w, { ml: 40, mr: 40 });
const q = W / 4;
c.push(
  H("How it works", true),
  P("Five steps, and nobody needs to be shown how.", { run: { size: 19 } }),
  steps([
    ["Scan the sign", "Point a phone camera at the sign by the printer, or type the address."],
    ["Say who you are", "The first time only, type a name, so people know whose printout is whose."],
    ["Choose the file", "Tap to pick a file or photo, or drag it onto the page on a laptop."],
    ["Check and print", "See a preview of every page, choose pages and layout, then tap Print."],
    ["Collect it", "The queue shows when it's done. Walk over and pick it up."],
  ]),
  italicNote("Changed your mind? Anyone can cancel their own job while it is still waiting. Nobody can cancel anyone else's."),
  new Paragraph({ keepNext: true, spacing: { before: 120, after: 80 }, children: [new TextRun({ text: "What staff see on screen", bold: true, size: 21 })] }),
  table([q, q, q, q], [new TableRow({ children: [
    figCell("f-name.png", "Figure 1. First visit only: a name, no account.", q),
    figCell("f-home.png", "Figure 2. The print page.", q),
    figCell("f-confirm.png", "Figure 3. A preview of every page, then Print.", q),
    figCell("f-queue.png", "Figure 4. Sent. The queue shows it.", q),
  ] })]),
  new Paragraph({ keepNext: true, spacing: { before: 200, after: 60 }, children: [new TextRun({ text: "What happens behind the scenes", bold: true, size: 21 })] }),
  italicNote("Staff never see this part. It is here so management can see where a file goes."),
  (() => {
    const items = [
      ["Staff member's device", "Phone, tablet or laptop, on the office Wi-Fi."],
      ["Main computer", "Runs the page. Turns Word, Excel and PowerPoint files into print-ready PDFs."],
      ["The printer's computer", "The same PrintBridge program, installed there too, hands the job to the printer."],
      ["Printer", "Prints it. The file is then deleted from both computers."],
    ];
    const arrowW = 360, boxW = Math.floor((W - arrowW * 3) / 4);
    const widths = []; items.forEach((_, i) => { widths.push(boxW); if (i < 3) widths.push(arrowW); });
    const border = { style: BorderStyle.SINGLE, size: 6, color: NAVY };
    const cells = [];
    items.forEach((it, i) => {
      cells.push(cell([
        new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: it[0], bold: true, size: 17, color: i === 1 || i === 2 ? "FFFFFF" : BLACK })] }),
        small(it[1], { after: 0, run: { size: 15, color: i === 1 || i === 2 ? "FFFFFF" : BLACK } }),
      ], boxW, { fill: i === 1 || i === 2 ? NAVY : LIGHT, borders: { top: border, bottom: border, left: border, right: border } }));
      if (i < 3) cells.push(cell([new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "→", size: 24 })] })], arrowW, { valign: VerticalAlign.CENTER, ml: 0, mr: 0 }));
    });
    return table(widths, [new TableRow({ children: cells })]);
  })(),
  gap(60),
  small("**Inside the office only.** Files travel over our own Wi-Fi and never go through the internet, so printing keeps working when the internet is down."),
  pageBreak(),
);

// ---------------- PAGE 3 ----------------
const half = W / 2;
c.push(
  H("What is saved, and what is not", true),
  P("The system keeps only what it needs to run the queue. Files are deleted as soon as they are printed.", { run: { size: 19 } }),
  headedTable(["Saved on the main computer", "Never saved"], [[
    [
      bullet("The name the person typed, shown next to their jobs"),
      bullet("The file name, which only the sender can see"),
      bullet("Which printer, the status, and when it was sent"),
      bullet("A short history of the last 200 finished jobs"),
      bullet("The list of printers and the computers they're on"),
    ],
    [
      bullet("Accounts, passwords or email addresses (there are none)", "×"),
      bullet("The printed file, once the job has finished", "×"),
      bullet("The device's network address", "×"),
      bullet("Anything on an outside server or in the cloud", "×"),
    ],
  ]], [half, half]),
  gap(40),
  small("A file waits on the main computer only until it is printed or cancelled, and is then deleted. The printer's computer deletes its copy straight after printing, and anything left over by accident is cleared out after a day."),
  H("The sign on the wall, and what the person looking after it sees"),
  table([3900, W - 3900], [new TableRow({ children: [
    cell([
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [img("f-poster.png", 200, 259)] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Figure 5. The sign, printed from the page itself and taped next to each printer.", size: 15, color: GREY })] }),
    ], 3900, { ml: 0 }),
    cell([
      small("The sign carries the page's address as a QR code and in writing, with four short steps. Anyone can print from it with no explanation, which is what makes this work with no training."),
      small("The **Printers & setup** page lists every printer, which computer it is on, and whether that computer is switched on. A broken printer can be hidden from everyone with one click, without unplugging anything."),
      new Paragraph({ spacing: { before: 80, after: 60 }, children: [img("f-manage.png", 360, 116)] }),
      new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: "Figure 6. The printer list. A filled dot means that computer is on.", size: 15, color: GREY })] }),
      small("**Check PrintBridge**, in the Start menu of any of the computers, says in plain words whether everything is working, and what to do if it isn't."),
    ], W - 3900, { ml: 200 }),
  ] })]),
  H("What can be printed"),
  small("The page takes all of these. Word, Excel and PowerPoint files are turned into PDFs automatically before printing. On office computers, anything a program can print (Excel, Word, accounting software, a web page) goes through the **PrintBridge** printer.", { after: 80 }),
  (() => {
    const tiles = ["PDF", "Word (.doc, .docx)", "Excel (.xls, .xlsx)", "PowerPoint (.ppt, .pptx)", "Photos (JPG, PNG and more)", "Text files (.txt, .rtf)", "OpenDocument files", "Several files at once"];
    const w = W / 4;
    const border = { style: BorderStyle.SINGLE, size: 6, color: NAVY };
    const mk = (t) => cell([new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: t, bold: true, size: 17 })] })], w, { borders: { top: border, bottom: border, left: border, right: border }, valign: VerticalAlign.CENTER, mt: 140, mb: 140 });
    return table([w, w, w, w], [new TableRow({ children: tiles.slice(0, 4).map(mk) }), new TableRow({ children: tiles.slice(4).map(mk) })]);
  })(),
  gap(40),
  small("Copies, paper size, colour, double-sided and page range are available under **More options**, showing only what each printer can do."),
  pageBreak(),
);

// ---------------- PAGE 4 ----------------
const gw1 = 4300, gw2 = W - gw1;
const gk = (title, text) => [new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: title, bold: true, size: 18 })] }), small(text, { after: 0, run: { size: 16, color: "404040" } })];
c.push(
  H("Good to know before we start", true),
  P("It is a simple system, and it has limits. We would rather list them now than have anyone find them later. Each point comes with what we suggest doing about it.", { run: { size: 19 } }),
  headedTable(["Good to know", "What we suggest"], [
    [gk("Anyone on our Wi-Fi can print", "There are no accounts, so anyone connected to the office Wi-Fi can use the printers, just as anyone who walks up to a printer can."), "Keep visitors on a separate guest Wi-Fi. Every job shows the sender's name in the queue, so misuse is easy to see."],
    [gk("There is no page count or limit", "The system does not count pages or stop anyone printing a lot."), "Watch paper and toner use during the trial. Page counting can be added later if it is needed."],
    [gk("The main computer must stay on", "If the computer that runs the page is off, nobody can print until it comes back."), "Setup stops it sleeping, and printing restarts by itself after a restart or power cut. A laptop's battery covers short power cuts."],
    [gk("After a power cut, the computers must be switched back on", "PrintBridge starts with Windows, with nobody needing to sign in, and every computer finds the main computer again by itself. But a desktop computer that lost power stays off until someone switches it on."), "Set desktop computers to switch themselves back on when the power returns (a BIOS setting), or make it someone's job to switch the main computer on."],
    [gk("The address can change", "When the office router restarts, it can give the main computer a new address, and the sign then points to the wrong place."), "Reserve a fixed address for that computer on the router, a five-minute job. Otherwise, reprint the sign when it happens."],
    [gk("Word and Excel layouts can shift slightly", "Office files are converted with LibreOffice, free software that can lay pages out a little differently from Microsoft Office."), "For documents where the exact layout matters, save as PDF first and print the PDF."],
    [gk("This version is new", "It has been checked carefully, including test installs, and it is built to restart by itself after a power cut. It has not yet run on our own computers."), "Treat the first month as the real test, including one planned restart of the main computer. Report anything that goes wrong with the Need help? button."],
    [gk("It depends on one person knowing it", "If the person who set it up is away, nobody else may know what to do."), "A plain-language guide already exists, with troubleshooting. Name a second person to read it."],
  ], [gw1, gw2], { fillCol: 1 }),
  H("Three house rules"),
  P("Open to everyone does not mean anything goes. We suggest sharing three simple rules with staff when we launch.", { run: { size: 19 } }),
  (() => {
    const w = Math.floor(W / 3);
    const rules = [
      ["Print for work", "The printers are for office work. Personal printing is fine only if management says so."],
      ["Take only your own pages", "Collect your printing promptly, and leave other people's pages in the tray. The queue shows whose is whose."],
      ["Something wrong? Say so", "Press Need help? on the page. Whoever is nearest sees it and sorts it out."],
    ];
    const sep = { style: BorderStyle.SINGLE, size: 4, color: "7F7F7F" };
    return table([w, w, w], [new TableRow({ children: rules.map((r, i) => cell([
      new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: String(i + 1), bold: true, size: 36, color: NAVY })] }),
      new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: r[0], bold: true, size: 18 })] }),
      small(r[1], { run: { size: 16 } }),
    ], w, { borders: { top: { style: BorderStyle.SINGLE, size: 12, color: NAVY }, bottom: none, left: none, right: i < 2 ? sep : none }, ml: i ? 140 : 0 })) })]);
  })(),
  pageBreak(),
);

// ---------------- PAGE 5 ----------------
const t3 = Math.floor(W / 3);
const sep = { style: BorderStyle.SINGLE, size: 4, color: "7F7F7F" };
const pathItems = [
  ["Before launch", "Make the decisions below and set up the computers, following the guide."],
  ["Launch", "Put up the signs. Tell staff at a short meeting and share the three rules."],
  ["Trial, 1 month", "Staff print from their own devices. Watch paper use and any problems."],
  ["Review", "Keep it, change it or stop, based on what we have learned."],
];
c.push(
  H("What it takes", true),
  table([t3, t3, W - 2 * t3], [new TableRow({ children: [
    ["Cost", "Nothing to run. The software is free and open-source, and it uses the computers and printers we already have. Paper and toner as today."],
    ["Setup", "One person runs the same Setup file on each computer that has a printer, and on any computer that should print from Excel or Word, with the written guide to hand. A few minutes per computer, plus the optional LibreOffice download on the main computer."],
    ["Upkeep", "Almost none. The main computer stays switched on. Someone opens Check PrintBridge once a month and reprints the sign if the address ever changes."],
  ].map((it, i) => cell([
    new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: it[0], bold: true, size: 19 })] }),
    small(it[1], { run: { size: 17 } }),
  ], i < 2 ? t3 : W - 2 * t3, { borders: { top: { style: BorderStyle.SINGLE, size: 8, color: NAVY }, bottom: sep, left: none, right: i < 2 ? sep : none }, ml: i ? 140 : 0 })) })]),
  H("What we ask management to decide"),
  small("Seven decisions would let us start.", { after: 100, run: { size: 18 } }),
  checkbox("Approve a trial with all staff. We suggest **one month**, followed by a review."),
  checkbox("Choose the **main computer**: one that is normally on during office hours."),
  checkbox("Name **who looks after it**, and a second person who reads the guide as a back-up."),
  checkbox("Decide **who switches the main computer back on** after a power cut, or have it set to switch itself on (see page 4)."),
  checkbox("Allow a **fixed address** for the main computer on the office router, so the signs keep working."),
  checkbox("Confirm that **visitors use a separate guest Wi-Fi**, or accept that anyone on our Wi-Fi can print."),
  checkbox("Approve the **three house rules** on page 4, and whether personal printing is allowed."),
  H("Suggested path"),
  (() => {
    const arrowW = 300, boxW = Math.floor((W - arrowW * 3) / 4);
    const widths = []; pathItems.forEach((_, i) => { widths.push(boxW); if (i < 3) widths.push(arrowW); });
    const border = { style: BorderStyle.SINGLE, size: 6, color: NAVY };
    const head = [], body = [];
    pathItems.forEach((it, i) => {
      head.push(cell([new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: it[0], bold: true, color: "FFFFFF", size: 17 })] })], boxW, { fill: NAVY, borders: { top: border, left: border, right: border, bottom: none }, mt: 50, mb: 50 }));
      body.push(cell([small(it[1], { after: 0, run: { size: 16 } })], boxW, { borders: { top: none, left: border, right: border, bottom: border } }));
      if (i < 3) {
        head.push(cell([gap(0)], arrowW, { ml: 0, mr: 0 }));
        body.push(cell([new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "→", size: 24 })] })], arrowW, { valign: VerticalAlign.CENTER, ml: 0, mr: 0 }));
      }
    });
    return table(widths, [new TableRow({ children: head }), new TableRow({ children: body })]);
  })(),
  H("Our recommendation"),
  callout("", "We recommend going ahead with the trial. It costs nothing, and it uses the printers and computers we already have. Staff can print from the phone or laptop in their hand without interrupting a colleague, and printing is set up to come back by itself after a power cut. If it does not work as hoped, stopping is as simple as switching it off."),
  gap(200),
  new Paragraph({ spacing: { after: 360 }, tabStops: [{ type: TabStopType.LEFT, position: 1400 }, { type: TabStopType.LEFT, position: 3200 }, { type: TabStopType.LEFT, position: 6200 }],
    children: [new TextRun({ text: "Decision:", bold: true, size: 18 }), new TextRun({ text: "\t☐ Approved\t☐ Approved with changes\t☐ Not approved", size: 18 })] }),
  table([3100, 300, 3100, 300, W - 6800], [new TableRow({ children: ["Name", "", "Signature", "", "Date"].map((t, i) => cell([
    new Paragraph({ children: [new TextRun({ text: t, size: 15, color: GREY })] }),
  ], [3100, 300, 3100, 300, W - 6800][i], { borders: { top: t ? { style: BorderStyle.SINGLE, size: 4, color: NAVY } : none, bottom: none, left: none, right: none }, ml: 0, mt: 40 })) })]),
);

// fix the empty-title recommendation callout: drop its empty title paragraph
// (callout("", ...) renders an empty bold line, harmless but tidy it)

const doc = new Document({
  creator: "Devnith AE", lastModifiedBy: "Devnith AE", title: "PrintBridge - Proposal to management",
  styles: { default: { document: { run: { font: FONT, size: 19 } } } },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 1000, left: 1134, right: 1134, footer: 500 } } },
    footers: { default: new Footer({ children: [new Paragraph({
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF", space: 4 } },
      tabStops: [{ type: TabStopType.RIGHT, position: W }],
      children: [
        new TextRun({ text: "PrintBridge  |  Proposal to management  |  \u2615 by @devnithdev", size: 15, color: GREY }),
        new TextRun({ text: "\tPage ", size: 15, color: GREY }),
        new TextRun({ children: [PageNumber.CURRENT], size: 15, color: GREY }),
        new TextRun({ text: " of ", size: 15, color: GREY }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 15, color: GREY }),
      ] })] }) },
    children: c,
  }],
});
Packer.toBuffer(doc).then((b) => { fs.writeFileSync(OUT, b); console.log("wrote", OUT, b.length); });
