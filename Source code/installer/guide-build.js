// Builds "PrintBridge - Setup Guide.docx" for the one-file installer (v3).
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, LevelFormat, Footer, PageNumber, ImageRun,
} = require("docx");

const IMG = path.join(__dirname, "guide-img");
const OUT = process.argv[2] || "PrintBridge - Setup Guide.docx";

// PrintBridge colours (same as desktop/lib/brand.js)
const INK = "123F73";
const GREEN = "21A67B";
const GREY = "555555";
const LIGHT = "EAF1F8";
const LINE = "B7C9DB";
const FONT = "Calibri";
const PAGE_W = 11906, MARGIN = 1134; // A4, 2 cm margins
const TEXT_W = PAGE_W - 2 * MARGIN;

// ---------- inline text: **bold**, `typed text` ----------
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const t = m[0];
    if (t.startsWith("**")) out.push(new TextRun({ text: t.slice(2, -2), bold: true, ...base }));
    else out.push(new TextRun({ text: t.slice(1, -1), font: "Consolas", size: 20, shading: { type: ShadingType.CLEAR, fill: LIGHT, color: "auto" }, ...base }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out;
}

const P = (text, opts = {}) => new Paragraph({ children: runs(text, opts.run), spacing: { after: 120, line: 276 }, ...opts.para });
const H1 = (text, pageBreak = true) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: pageBreak, children: [new TextRun(text)] });
const H2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
const bullet = (text, level = 0) => new Paragraph({ numbering: { reference: "bullets", level }, children: runs(text), spacing: { after: 60, line: 276 } });
const numbered = (ref) => (text) => new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs(text), spacing: { after: 80, line: 276 } });

function picture(name, widthPx, caption) {
  const file = path.join(IMG, name + ".png");
  const { width, height } = pngSize(file);
  const h = Math.round((height / width) * widthPx);
  const out = [new Paragraph({
    alignment: AlignmentType.CENTER, keepNext: !!caption, spacing: { before: 80, after: caption ? 40 : 160 },
    children: [new ImageRun({ type: "png", data: fs.readFileSync(file), transformation: { width: widthPx, height: h },
      altText: { title: caption || name, description: caption || name, name } })],
  })];
  if (caption) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
    children: [new TextRun({ text: caption, italics: true, size: 18, color: GREY })] }));
  return out;
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// A numbered step: black "Step N" tab + title, then body.
function step(n, title, body) {
  return [
    new Paragraph({
      keepNext: true, spacing: { before: 280, after: 100 },
      children: [
        new TextRun({ text: " Step " + n + " ", bold: true, color: "FFFFFF", size: 22, shading: { type: ShadingType.CLEAR, fill: INK, color: "auto" } }),
        new TextRun({ text: "   " + title, bold: true, size: 26, color: INK }),
      ],
    }),
    ...body,
  ];
}

// Call-out box: grey panel with a thick black edge.
function box(label, paras) {
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  return [
    new Table({
      width: { size: TEXT_W, type: WidthType.DXA },
      columnWidths: [TEXT_W],
      rows: [new TableRow({ cantSplit: true, children: [new TableCell({
        width: { size: TEXT_W, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: LIGHT, color: "auto" },
        margins: { top: 100, bottom: 60, left: 200, right: 200 },
        borders: { top: none, bottom: none, right: none, left: { style: BorderStyle.SINGLE, size: 24, color: INK } },
        children: [
          new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: label, bold: true })] }),
          ...paras.map((p) => (typeof p === "string" ? new Paragraph({ children: runs(p), spacing: { after: 80, line: 264 } }) : p)),
        ],
      })] })],
    }),
    new Paragraph({ spacing: { after: 120 }, children: [] }),
  ];
}

// Two-column table (problem -> what to do).
function table2(header, rows, w1 = 3300, size, noSpacer) {
  const w2 = TEXT_W - w1;
  const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (content, w, head) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    borders,
    shading: head ? { type: ShadingType.CLEAR, fill: INK, color: "auto" } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: (Array.isArray(content) ? content : [content]).map((t) =>
      new Paragraph({ spacing: { after: 60, line: 264 }, children: runs(t, Object.assign(head ? { bold: true, color: "FFFFFF" } : {}, size ? { size } : {})) })),
  });
  return [
    new Table({
      width: { size: TEXT_W, type: WidthType.DXA },
      columnWidths: [w1, w2],
      rows: [
        new TableRow({ tableHeader: true, children: [cell(header[0], w1, true), cell(header[1], w2, true)] }),
        ...rows.map((r) => new TableRow({ cantSplit: true, children: [cell(r[0], w1), cell(r[1], w2)] })),
      ],
    }),
    ...(noSpacer ? [] : [new Paragraph({ spacing: { after: 120 }, children: [] })]),
  ];
}

// ====================================================================
const c = [];

// ---------- cover ----------
c.push(
  new Paragraph({ spacing: { before: 900, after: 360 }, children: [new ImageRun({ type: "png", data: fs.readFileSync(path.join(IMG, "printbridge-badge.png")), transformation: { width: 190, height: 61 }, altText: { title: "PrintBridge", description: "PrintBridge", name: "printbridge-badge" } })] }),
  new Paragraph({ spacing: { before: 0, after: 120 }, children: [new TextRun({ text: "PrintBridge", bold: true, size: 64, color: INK })] }),
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "Setup guide", size: 40, color: GREY })] }),
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "One installer for every computer  ·  version 4.1", size: 22, color: GREY })] }),
  new Paragraph({ spacing: { after: 600 }, children: [new TextRun({ text: "\u2615 by @devnithdev", size: 22, color: GREEN, bold: true })] }),
  ...box("The whole setup, in three steps (and one optional fourth)", [
    "**1.**  On the **main computer** (the one that stays on all day), double-click **PrintBridgeSetup.exe** and choose **This is the main computer**.",
    "**2.**  Print the **wall sign** it offers at the end, and put it up where people can see it.",
    "**3.**  On **each computer that has a printer**, double-click the **same file**. It finds the main computer by itself.",
    "**4.**  Optional: on any other computer where people want to print from Excel, Word and other programs, run the **same file** and choose **This computer only prints**.",
    "That's all. Anyone on the office network prints from their own phone or computer by opening the address on the sign, and on the computers from step 3 and 4, from any program by choosing the **PrintBridge** printer. No app, no account, no password.",
  ]),
  P("**Already using the older version** (the folder of files with PrintAgent.exe and .bat files)? Use this same file. Setup finds the old version, keeps your list of printers, and switches the old one off. Do the main computer first (see Step 3 of \"Setting up the main computer\")."),
  H2("What's in this guide"),
  bullet("Before you start"),
  bullet("Setting up the main computer"),
  bullet("Setting up a computer that has a printer"),
  bullet("Setting up a computer that only prints"),
  bullet("Keeping printing going after a power cut"),
  bullet("How people print"),
  bullet("Day to day: checking, restarting, changing things"),
  bullet("Removing PrintBridge"),
  bullet("When something goes wrong"),
  bullet("For whoever looks after the computers"),
);

// ---------- before you start ----------
c.push(
  H1("Before you start"),
  H2("You need"),
  bullet("The file **PrintBridgeSetup.exe** (about 19 MB). Copy it onto each computer with a USB stick, by email, or from a shared folder."),
  bullet("Computers running **Windows 10 or Windows 11** (64-bit, which almost all are)."),
  bullet("The **password of an administrator account** on each computer. Windows asks for it once, when Setup starts."),
  bullet("Every computer connected to the **office Wi-Fi or network**. All of them, and everyone's phones, must be on the same network."),
  bullet("**Internet** on the main computer, but only if you want Word, Excel and PowerPoint files to print (Setup downloads a free program called LibreOffice for that)."),
  H2("Choose the main computer"),
  P("One computer runs the printing page that everyone opens. Pick one that:"),
  bullet("is switched on for the whole working day (nobody can print while it's off);"),
  bullet("stays in the office, plugged in (a laptop is fine; its lid can be closed)."),
  P("It can have a printer of its own, and it can still be used normally for other work."),
  H2("Check each printer first"),
  P("On every computer that has a printer, make sure the printer already works from that computer: it should be installed in Windows (**Settings > Bluetooth & devices > Printers & scanners**) and able to print a test page. PrintBridge shares whatever printers Windows already has."),
  ...box("Good to know", [
    "Setup sets the main computer and computers with a printer **never to go to sleep**, so printing is always available. The screen still turns off after 10 minutes, which is fine. Computers that only print keep their usual settings. If PrintBridge is removed later, the computer's earlier power settings are put back.",
  ]),
);

// ---------- main computer ----------
c.push(
  H1("Setting up the main computer"),
  ...step(1, "Open the file", [
    P("Double-click **PrintBridgeSetup.exe**."),
    P("If a blue box says **Windows protected your PC**, click **More info**, then **Run anyway**. (Windows says this about programs that aren't from a big software company. It's expected.)"),
    P("When Windows asks **Do you want to allow this app to make changes to your device?**, click **Yes** (type the administrator password if asked)."),
    P("Setup then checks the computer for a few seconds."),
  ]),
  ...step(2, "Welcome", [
    ...picture("welcome", 400),
    P("Click **Next**."),
  ]),
  ...step(3, "Replace the older version (only if you had one)", [
    P("If this computer ran the older version, Setup says where it found it. Leave **Replace the older version** selected and click **Next**."),
    ...picture("old", 400),
    P("Your list of printers and connected computers is kept. The old version is stopped and won't start again. Its folder stays where it was, with a note inside saying it can be deleted. You can delete it whenever you like."),
  ]),
  ...step(4, "Say what this computer does", [
    ...picture("role-main", 360),
    bullet("Choose **This is the main computer**. (Setup usually picks the right answer for you.)"),
    bullet("Type a **name** for this computer, such as `Front desk`. People see it next to its printers."),
    bullet("Leave **Also install LibreOffice** ticked if you want Word, Excel and PowerPoint files to print. It needs the internet. (This box doesn't appear if LibreOffice is already installed.)"),
    P("Click **Next**."),
  ]),
  ...step(5, "Choose how this computer behaves", [
    ...picture("power", 360),
    P("The main computer must stay reachable, so Setup asks a few questions about power. The recommended answer is already picked for each one."),
    bullet("**Keep this computer awake**: leave it ticked. The screen still turns off after 10 minutes; only the computer itself stays awake."),
    bullet("**When the lid is closed**: leave **Do nothing** on a laptop that stays on the desk. Choose **Sleep** only for a laptop people carry around."),
    bullet("**On critical battery**: leave **Shut down safely**."),
    P("Click **Install**."),
  ]),
  ...step(6, "Wait", [
    ...picture("installing", 400),
    P("This usually takes a minute. With LibreOffice it can take **10 to 20 minutes** on a slow connection. Leave the window open."),
  ]),
  ...step(7, "Finish, and start PrintBridge", [
    ...picture("finish", 400),
    P("On a first install the last page says that **PrintBridge is installed**. Leave **Start PrintBridge now** ticked and click **Finish**. It starts, and on the main computer the **sign for the wall** opens in the web browser: print it and put it up. It has the address and a code that phones can scan."),
    P("Rather start it later? Just close this window instead. PrintBridge then starts by itself the next time Windows starts."),
    P("When you install over an older version, PrintBridge starts straight away and the last page shows the **address everyone will use**, like `http://192.168.1.20:3000`. Write it down."),
    P("The last page also says that the **PrintBridge** printer was added, so people at this computer can print from Excel, Word and other programs (see \"How people print\")."),
  ]),
  ...box("If LibreOffice couldn't be downloaded", [
    "The last page says so. Everything else works: PDFs and photos print. Run Setup again later, with the internet working, to try once more.",
  ]),
);

// ---------- printer computers ----------
c.push(
  H1("Setting up a computer that has a printer"),
  P("Do this on **every** computer that has a printer plugged in or installed, **after** the main computer is set up and switched on."),
  P("It's the same file and the same steps as the main computer, with one difference at the question **What does this computer do?**:"),
  ...picture("role-printer", 400),
  bullet("Choose **This computer shares a printer**. Setup usually picks this for you, and says when it has found the main computer on the network."),
  bullet("Type a **name** that tells people where the printer is, such as `Upstairs office`."),
  bullet("Leave the **address** box empty. Only if Setup can't find the main computer by itself, type the address from the wall sign, for example `192.168.1.20:3000`."),
  P("Click **Next** (a printer computer isn't asked about power; it always stays awake). The last page lists the printers now shared from this computer. They appear on everyone's printing page straight away."),
  ...box("If the last page says it hasn't reached the main computer yet", [
    "Make sure the main computer is on, and both computers are on the same network. This computer keeps looking by itself; there's nothing else to do. To see how it's going, open **Check PrintBridge** from the Start menu.",
  ]),
  H2("Updating from the older version"),
  P("Setup replaces the older version automatically on each computer (see Step 3 on the previous pages). The order:"),
  numbered("order")("Run Setup on the **main computer** first."),
  numbered("order")("Then run it on each **printer computer**, whenever it suits you. Until you do, their old version keeps working with the new main computer."),
  numbered("order")("When everything works, you can delete the old folders. Each one has a file inside called `OLD COPY - NOT USED ANY MORE.txt`."),
  P("Nobody needs to set anything up again: the printers, their names and the address all stay the same."),
);

// ---------- computers that only print ----------
c.push(
  H1("Setting up a computer that only prints"),
  P("For a computer **without a printer** (a laptop or a desk computer) where people want to print from **Excel, Word or any other program** the way they always have. Phones and tablets don't need this: they use the printing page."),
  P("Run the same **PrintBridgeSetup.exe**, and at **What does this computer do?**:"),
  ...picture("role-client", 400),
  bullet("Choose **This computer only prints**."),
  bullet("Leave the **address** box empty. Only if Setup can't find the main computer by itself, type the address from the wall sign."),
  P("Click **Next**. The last page says the computer can now print. It keeps its normal sleep settings, and it doesn't appear in the list of printers."),
  ...box("If a printer computer or the old main computer becomes one that only prints", [
    "Run Setup on it and choose **This computer only prints**. Its printers are taken off the printing page. If it was the main computer, Setup warns you first, because printing stops for everyone until another computer is the main one.",
  ]),
);

// ---------- power cuts ----------
c.push(
  H1("Keeping printing going after a power cut"),
  P("On the main computer and on computers that share a printer, PrintBridge starts by itself **as soon as Windows starts**: after a power cut it comes back when the computer is switched on, **with nobody needing to sign in**. Every computer finds the main computer by itself, even if the main computer's address changed when the power came back. Nobody needs to type the address in again."),
  H2("1. Keep the main computer's address the same (for phones and the wall sign)"),
  P("Computers find the main computer by themselves, but people's phones and the printed wall sign use its address, which can change after the Wi-Fi router restarts."),
  P("To stop it changing, ask whoever looks after the router or Wi-Fi to **reserve the main computer's address** (they'll know it as a \"DHCP reservation\"). If it has changed already, print a new sign: on the main computer, open **Check PrintBridge** and click **Print the sign for the wall**."),
  H2("2. Switching back on after a power cut (desktop computers)"),
  P("Laptops keep running on battery. Some desktop computers can be set to switch themselves back on when the power returns. The setting is inside the computer's start-up menu (BIOS), often called **Restore on AC power loss**. Ask whoever looks after your computers."),
);

// ---------- how people print ----------
c.push(
  H1("How people print"),
  H2("From Excel, Word or any other program"),
  P("On any computer with PrintBridge installed (main computer, printer computers, and computers that only print):"),
  numbered("program")("Print the way you always do (**Ctrl+P**, or **File > Print**), and choose the printer **PrintBridge**."),
  numbered("program")("Set things up in the program's own Print window as usual. It all works: **Print Selection** in Excel (select the cells first), **Landscape**, **Fit Sheet on One Page**, margins, and the program's own preview."),
  numbered("program")("Click **Print**. The printing page opens in the web browser, showing the printout:"),
  ...picture("preview", 430, "The printing page after printing from Excel. Here only pages 1 and 2 are ticked."),
  numbered("program")("Check the pages, choose which **office printer**, and press **Print**. Collect it from that printer."),
  P("Nothing is printed until **Print** is pressed on the printing page. Closing it throws the printout away."),
  H2("From a phone, tablet or any computer"),
  P("Anyone on the office network, with nothing installed:"),
  numbered("print")("Connect to the **office Wi-Fi**."),
  numbered("print")("Open the address on the **wall sign** in a web browser, or **scan the code** on the sign with the phone's camera."),
  numbered("print")("The first time, type your **name** (so you can find your pages at the printer)."),
  numbered("print")("**Drop a file** on the page, or tap to choose one. A **preview** shows every page."),
  numbered("print")("Choose the printer and press **Print**."),
  P("PDFs, photos, and (with LibreOffice) Word, Excel and PowerPoint files all work. The page shows everyone's queue, and tells you if something didn't print and why."),
  H2("Choosing pages and layout"),
  P("The same choices appear however the file arrived:"),
  bullet("**Pages**: tick pages in the preview to print only those, or type them, like `1-3` or `2,5`. Tap a page to see it bigger."),
  bullet("**Orientation**: **Automatic** turns each page to suit the paper. Choose **Portrait** or **Landscape** to force one."),
  bullet("**Size on paper**: **Fit to page** makes each page fill the paper; **Actual size** prints it at its real size (a page bigger than the paper is cut off)."),
  bullet("**More options**: copies, paper size, colour and double-sided, when the printer can do them."),
  P("The preview shows each page on a sheet of the chosen paper, so what you see is how it prints."),
  ...box("Keep in mind", [
    "Anyone connected to the office network can print, and can change the printer list on the printing page. That's right for a private office network. Don't use it on a shared or public network, such as a building's guest Wi-Fi.",
  ]),
);

// ---------- day to day ----------
c.push(
  H1("Day to day"),
  P("There is nothing to do day to day. PrintBridge runs quietly in the background, with no window to keep open."),
  H2("The Start menu"),
  P("Open the **Start** menu and type `PrintBridge`:"),
  ...table2(["Item", "What it does"], [
    ["**PrintBridge**", "Opens the printing page."],
    ["**Check PrintBridge**", "Shows whether everything on this computer is working, in plain words, and what to do if not."],
    ["**Restart PrintBridge**", "Stops and starts it again. Try this first if something seems stuck."],
    ["**Read me**", "A short summary of this guide."],
  ]),
  H2("Checking"),
  ...picture("check", 330, "Check PrintBridge opens a page like this"),
  new Paragraph({ heading: HeadingLevel.HEADING_2, pageBreakBefore: true, children: [new TextRun("Changing things")] }),
  ...table2(["To...", "Do this"], [
    ["Add a computer with a printer", "Run **PrintBridgeSetup.exe** on it and choose **This computer shares a printer**."],
    ["Let another computer print from Excel, Word and other programs", "Run **PrintBridgeSetup.exe** on it and choose **This computer only prints**."],
    ["Add a printer to a computer that's already set up", "Install it in Windows and print a test page. It appears on the printing page within 5 minutes."],
    ["Rename a computer", "Run Setup again on it and type the new name."],
    ["Hide a printer from the list", "On the printing page, open **Printers & setup** and hide it."],
    ["Make a different computer the main one", "1. Run Setup on the new computer and choose **This is the main computer**.  2. Run Setup on the old main computer and choose **This computer shares a printer**.  3. Run Setup again on each printer computer: it connects to the new main computer by itself.  4. Print the new wall sign."],
    ["Update to a newer version later", "Run the newer **PrintBridgeSetup.exe** on every computer, main computer first. Everything is kept."],
  ], 3400),
);

// ---------- removing ----------
c.push(
  H1("Removing PrintBridge"),
  numbered("remove")("Open **Settings > Apps > Installed apps** (on Windows 10: **Settings > Apps**)."),
  numbered("remove")("Find **PrintBridge**, click the **...** button (or the entry itself), then **Uninstall**, and confirm."),
  numbered("remove")("Click **Uninstall**:"),
  ...picture("uninstall", 380),
  P("That removes **everything** PrintBridge added to the computer:"),
  bullet("the program, its Start menu and desktop shortcuts, and its start-up setting;"),
  bullet("the **PrintBridge** printer;"),
  bullet("the firewall rules, and its saved information and logs;"),
  bullet("the older version's leftover files, if Setup replaced one (only files it recognises: anything else in that folder stays);"),
  bullet("**LibreOffice**, but only if PrintBridge Setup installed it. If it was on the computer before, it stays."),
  P("The computer's power settings go back to how they were before Setup. A computer that shared printers also takes them off the printing page."),
  P("Tick **Keep the saved list of printers and computers** only on the main computer, and only if PrintBridge will be installed on it again. To fix a problem there's no need to uninstall: run Setup again instead."),
  ...box("Important", [
    "Removing PrintBridge from the **main computer** stops printing for **everyone**, until another computer is set up as the main computer.",
  ]),
);

// ---------- troubleshooting ----------
c.push(
  H1("When something goes wrong"),
  P("**First, open Check PrintBridge** from the Start menu on the computer concerned. It says what's wrong in plain words. If something just seems stuck, choose **Restart PrintBridge** from the Start menu (or restart the computer). Otherwise:"),
  H2("While setting up"),
  ...table2(["What you see", "What to do"], [
    ["**Windows protected your PC**", "Click **More info**, then **Run anyway**."],
    ["**Setup couldn't check this computer**", "Security software stopped it. Ask whoever looks after the computer's antivirus to allow **PrintBridgeSetup.exe**, then run Setup again."],
    ["**Another computer on this network is already the main computer**", "There should be only one main computer. Choose **No**, then pick **This computer shares a printer**, unless you are deliberately moving the main computer (see Changing things)."],
    ["**This computer runs the printing page for the office**", "You chose another role on the main computer. Only continue if another computer is now (or will be) the main computer."],
    ["The last page says the **PrintBridge** printer couldn't be added", "Windows' own **Microsoft Print to PDF** is switched off, or security software stopped Setup. Turn on Microsoft Print to PDF in **Turn Windows features on or off**, then run Setup again. **Check PrintBridge** says what happened."],
    ["The last page says it hasn't reached the main computer", "Check the main computer is on and on the same network. It keeps trying by itself. If it never finds it, run Setup again and type the address from the wall sign."],
  ], 3300, 20),
  H2("While printing"),
  ...table2(["Problem", "What to do"], [
    ["Nobody can open the printing page", "Is the main computer on? (It needn't be signed in.) Is the phone on the office Wi-Fi (not mobile data or a guest network)? On the main computer, open **Check PrintBridge**."],
    ["It worked yesterday, not today", "The main computer's address may have changed, for example after a power cut. Open **Check PrintBridge** on the main computer to see the current address, and print a new sign. To stop it happening again, see \"Keep the main computer's address the same\"."],
    ["A printer is missing from the list", "Is that printer's computer on? (It needn't be signed in.) On that computer, open **Check PrintBridge**. Is the printer installed in Windows, and does a test page print?"],
    ["The page says a file \"didn't print\"", "The reason is shown next to it. If the printer is out of paper or jammed, fix it and send the file again."],
    ["Printing to **PrintBridge** from Excel or Word doesn't open the printing page", "A page may say it \"wasn't printed\" and why: usually the main computer is off. Print again once it's on. Otherwise open **Check PrintBridge** on that computer."],
    ["The printout is cut off or too small", "In the program's Print window, choose the orientation and scaling you want (in Excel: **Fit Sheet on One Page**). Or on the printing page choose **Landscape** and **Fit to page**. The preview shows the result before printing."],
    ["Word, Excel or PowerPoint files won't print", "LibreOffice isn't installed on the main computer. Run Setup again there with the internet working, and tick **Also install LibreOffice**. Or print a PDF instead."],
    ["Printing stopped after a power cut", "Give the computers a minute or two after they are switched back on: PrintBridge starts with Windows and the other computers find the main computer by themselves. If it still doesn't come back, open **Check PrintBridge** on the main computer, then on the computer that can't print."],
  ], 3300, 20, true),
);

// ---------- IT notes ----------
c.push(
  H1("For whoever looks after the computers"),
  P("Behind the scenes the program keeps its internal name, **Office Printing**, for its folders, start-up entry and firewall rules. So those names below are correct, and computers set up under an earlier brand name carry on working unchanged."),
  P("There are three kinds of computer: the **main computer** (runs the printing page), **printer computers** (share their printers) and **computers that only print** (share nothing; print through the others)."),
  H2("What Setup installs"),
  ...table2(["Where", "What"], [
    ["`C:\\Program Files\\Office Printing`", "`OfficePrinting.exe` (the one program, for both roles), `SumatraPDF.exe` (free PDF printing helper, GPL), the uninstaller."],
    ["`C:\\ProgramData\\Office Printing`", "`settings.json` (role, name), `website\\db.json` (list of computers and printers, main computer only), `printer\\config.json` (this computer's connection), `outbox\\` (printouts on their way to the printing page), `install-record.json` (what Setup added, so uninstalling removes exactly that), `logs\\*.log`, `power-before.json`. The Users group can modify this folder."],
    ["Printer", "A Windows printer named `PrintBridge`, using Windows' own `Microsoft Print To PDF` driver, with a Local Port that is the file `C:\\ProgramData\\Office Printing\\outbox\\printout.pdf`. It is never offered on the printing page."],
    ["Start-up", "Task Scheduler task `Office Printing` (main computer and printer computers): starts the printing website and printer sharing when Windows starts, as the SYSTEM account, before anyone signs in; restarted every minute if it ever fails, never stopped by time limits or battery. Registry value `Office Printing` under `HKLM\\...\\CurrentVersion\\Run`: at every sign-in, starts the part that opens printouts in the browser (and, if the task isn't running, everything else as before). Only one copy of each runs per computer."],
    ["Firewall (main computer)", "Inbound rules `Office Printing` (the program), `Office Printing (port 3000)` and `Office Printing (finding it)`. The printing page uses **TCP port 3000**; other computers find it by asking on **UDP port 39276**. Other computers connect out to it; they need no open ports."],
    ["Power (not on computers that only print)", "Sleep and hibernate off, screen off after 10 minutes, lid and power button do nothing, critical battery shuts down cleanly, no automatic restarts for updates while someone is signed in. The previous settings are saved and restored on uninstall."],
    ["LibreOffice (optional)", "Downloaded from The Document Foundation and installed silently, without taking over opening Office files. If that fails, `winget` is tried."],
  ], 2900),
  H2("Printing from programs"),
  P("Windows writes each printout to the outbox file. The program moves it aside the moment Windows has finished, sends it to the main computer, and opens the printing page on it in the browser. The main computer holds it (for up to 3 hours) until someone presses Print, and throws it away if the page is closed. If the main computer can't be reached, a page explains, and the printout is kept in `outbox\\not sent` for a week."),
  P("If several people are signed in to one computer at the same time, the printing page opens for the person who signed in first."),
  H2("How other computers find the main computer"),
  P("First they ask the whole network at once (a UDP broadcast on port 39276); the main computer answers with its address and a permanent id. If nothing answers (an older main computer, or a network that blocks broadcasts), they look on their own network (up to 1,022 neighbouring addresses) for port 3000 and ask whether it's the printing page. If the main computer's address changes, they find it again and reconnect, recognising it by its id, and they also try it by its computer name. Computers that only print check every minute, so they already know the new address before anyone prints. The full search becomes less frequent while the main computer can't be found, down to one every 10 to 15 minutes."),
  P("Settings, the connection and the list of printers are saved with a backup copy and flushed to disk, so a power cut in the middle of saving can't wipe them."),
  H2("Replacing the older version"),
  P("Setup acts only on folders confirmed to hold the older version's files (AutoStart-Printing.bat, Start Print Platform.bat, PrintAgent.exe with its config.json, or the old server folder). It stops their programs, removes their Startup entries, scheduled tasks and Run values, and renames `AutoStart-Printing.bat`, `Start Print Platform.bat`, `PrintAgent.exe` and `server.js` to `.old`. It copies `db.json` and `config.json` across and leaves a note in the folder. Nothing in Windows or Program Files is touched. Folders synced by OneDrive are left exactly as they are. When PrintBridge is uninstalled, it deletes the old files it recognises in that folder (and the folder, if nothing else is left in it)."),
  H2("Installing on many computers"),
  P("Setup can run silently:"),
  P("`PrintBridgeSetup.exe /S /ROLE=printer /NAME=\"Front desk\"`"),
  P("Other options: `/ROLE=main` or `/ROLE=client` (only prints), `/SERVER=192.168.1.20` (only if the main computer can't be found automatically), `/LIBREOFFICE=0`. A silent install always replaces an older version. Uninstall silently with `\"C:\\Program Files\\Office Printing\\Uninstall Office Printing.exe\" /S`, which removes everything; add `/KEEPDATA` to keep the saved information."),
  H2("Things to know"),
  bullet("The program isn't signed with a code-signing certificate, which is why Windows SmartScreen shows a warning the first time. Some antivirus products may also be cautious about it."),
  bullet("There are no accounts: anyone on the network can print and manage printers. Keep it on a private office network, never on the internet."),
  bullet("Nothing is printed or stored anywhere outside the office. Uploaded files are deleted after printing."),
  bullet("Update every computer to the same version. A computer left on an older version still prints, but may ignore newer orientation and size choices."),
);

// ====================================================================
const doc = new Document({
  creator: "Devnith AE",
  lastModifiedBy: "Devnith AE",
  title: "PrintBridge - Setup guide",
  description: "How to install PrintBridge with PrintBridgeSetup.exe",
  styles: {
    default: { document: { run: { font: FONT, size: 22, color: "222222" } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, color: INK, font: FONT },
        paragraph: { spacing: { before: 0, after: 200 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GREEN, space: 4 } } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 27, bold: true, color: INK, font: FONT },
        paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1, keepNext: true } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 567, hanging: 283 } } } },
      ] },
      ...["order", "autologin", "print", "program", "remove"].map((reference) => ({ reference, levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 567, hanging: 340 } }, run: { bold: true } } },
      ] })),
    ],
  },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "PrintBridge setup guide  \u00b7  \u2615 by @devnithdev  \u00b7  page ", color: GREY, size: 18 }), new TextRun({ children: [PageNumber.CURRENT], color: GREY, size: 18 })],
    })] }) },
    children: c,
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log("wrote", OUT, buf.length, "bytes"); });
