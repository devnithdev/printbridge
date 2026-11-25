// Builds "PrintBridge - How to build and roll out.docx": the handover note for
// making, checking, publishing and rolling out a version. node rollout-build.js [out.docx]
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, LevelFormat, Footer, PageNumber, ImageRun,
} = require("docx");

const IMG = path.join(__dirname, "guide-img");
const OUT = process.argv[2] || "PrintBridge - How to build and roll out.docx";

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

// Numbered steps: each list restarts at 1.
const LISTS = [];
function steps(items) {
  const ref = "list" + LISTS.length; LISTS.push(ref);
  return items.map((t) => typeof t === "string"
    ? new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs(t), spacing: { after: 80, line: 276 } })
    : t);
}
// A line to type in Terminal.
const code = (text) => new Paragraph({ indent: { left: 567 }, spacing: { after: 100 }, shading: { type: ShadingType.CLEAR, fill: LIGHT, color: "auto" },
  children: [new TextRun({ text, font: "Consolas", size: 19 })] });

const REPO = "~/Desktop/PrintBridge/printbridge-app";
const c = [];

// ---------- cover ----------
c.push(
  new Paragraph({ spacing: { before: 900, after: 360 }, children: [new ImageRun({ type: "png", data: fs.readFileSync(path.join(IMG, "printbridge-badge.png")), transformation: { width: 190, height: 61 }, altText: { title: "PrintBridge", description: "PrintBridge", name: "printbridge-badge" } })] }),
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "How to build and roll out", bold: true, size: 56, color: INK })] }),
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "Making a new version, checking it, publishing it, and setting up office computers", size: 26, color: GREY })] }),
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "For version 4.2.9 and later  \u00b7  written 2026-11-05", size: 22, color: GREY })] }),
  new Paragraph({ spacing: { after: 500 }, children: [new TextRun({ text: "\u2615 by @devnithdev", size: 22, color: GREEN, bold: true })] }),
  ...box("The short version", [
    "**1.**  Change the code, then raise the version: `node publish-update.js bump 4.3.0`.",
    "**2.**  Run the checks, then build: `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ./BUILD-ALL.command`.",
    "**3.**  Try it: start the printing page from the source and look at it, and install the new installer on one computer.",
    "**4.**  Commit and push, then publish: `./PUBLISH-UPDATE.command`.",
    "**5.**  Check what went live: `node check-live.js`. Every office computer then updates itself within about an hour.",
  ]),
  H2("What's in this document"),
  ...["Where everything is", "What you need on the Mac", "The update key", "Making a new version", "Checking it before it goes out", "Publishing it", "Checking what went live", "How the computers update themselves", "Setting up a new office computer", "Printing from anywhere (remote codes)", "If something goes wrong"].map((t, i) => bullet((i + 1) + ". " + t)),
);

// ---------- 1 ----------
c.push(
  H1("1. Where everything is"),
  ...table2(["Where", "What"], [
    ["`" + REPO + "`", "The source code on this Mac (a git copy of **devnithdev/printbridge**). Everything below is run from here."],
    ["`BUILD-ALL.command`", "Builds the Windows and Mac installers, start to finish."],
    ["`PUBLISH-UPDATE.command`", "Signs the version you built and puts it on GitHub, so every computer installs it by itself."],
    ["`Source code/release`", "`publish-update.js` (raise the version, sign, upload) and `check-live.js` (check what is live)."],
    ["`Source code/tests`", "The automatic checks."],
    ["`Source code/installer`", "Windows Setup, the installer's Read me, and the scripts that make the Setup Guide and Proposal (`guide-build.js`, `proposal-build.js`, and this document: `rollout-build.js`)."],
    ["`~/Desktop/PrintBridge/printbridge-updates`", "A git copy of **devnithdev/printbridge-updates**: the download page, the FAQ and `lang.js`. Edit and push it like any repository; GitHub Pages shows it within a minute."],
    ["`~/Desktop/PrintBridge/PrintBridge-Installers-<version>-<date>`", "Made by every build: the installers and a Read me. Earlier builds are never overwritten."],
  ], 3600),
  H2("Online"),
  ...table2(["Where", "What"], [
    ["github.com/devnithdev/printbridge (public, MIT)", "The source code. Its Actions tab can also build the installers (\"Build installers\", or push a tag like `v4.3.0`)."],
    ["github.com/devnithdev/printbridge-updates (public)", "The installers and the signed `latest.json`. Every office computer checks its latest release. Its website is the download page: devnithdev.github.io/printbridge-updates"],
    ["youtu.be/Cx2plyjPf7w", "The 3-minute video guide, linked from the printing page and the download page."],
    ["youtu.be/sP1R5dWC5Hw, youtu.be/5sw9WdwODrY", "The same guide in Sinhala and in Tamil; the pages play these when that language is picked."],
    ["youtu.be/R-5XXXhX6Mg, youtu.be/oU3_QhFajBc, youtu.be/4WxqC4cTjJE", "The short phone-only video in English, Sinhala and Tamil; the download page plays the one for the language picked."],
  ], 3600),
);

// ---------- 2 ----------
c.push(
  H1("2. What you need on the Mac"),
  P("All of this is already set up on this Mac. Only needed again on a new Mac."),
  ...table2(["Needed", "How to get it  \u00b7  how to check"], [
    ["Node.js 18 or newer", "nodejs.org  \u00b7  `node -v`"],
    ["Xcode Command Line Tools", "`xcode-select --install`  \u00b7  `codesign -h`"],
    ["Homebrew", "brew.sh  \u00b7  `brew -v`"],
    ["makensis (makes Windows Setup)", "`brew install makensis`  \u00b7  `makensis -VERSION`"],
    ["Rosetta (Apple Silicon Macs)", "`softwareupdate --install-rosetta --agree-to-license`"],
    ["GitHub sign-in (to publish)", "`brew install gh` then `gh auth login`, as devnithdev. Publishing also works with the Mac's saved git sign-in."],
  ], 3300),
  P("`Source code/agent/tools/SumatraPDF.exe` must be there (it is). If it ever goes missing, download the 64-bit portable SumatraPDF from sumatrapdfreader.org and save it there."),
);

// ---------- 3 ----------
c.push(
  H1("3. The update key"),
  P("Office computers only install a version signed with PrintBridge's private update key. It lives only on this Mac, here:"),
  code("~/Documents/PrintBridge update key (keep secret)/printbridge-update-key.pem"),
  P("There is a backup in your Google Drive. Its public half is built into the program (`Source code/desktop/lib/update-key.js`), so every computer trusts that key and no other."),
  bullet("Never email it, upload it, paste it anywhere, or copy it into the source folder. (`*.pem` is ignored by git, so it can't be committed by mistake.)"),
  bullet("If it is lost: computers already installed can't be updated any more. Make a new key (`node publish-update.js keygen --force`), build, and run the new Setup on every computer by hand, once."),
  bullet("If someone else might have it: do the same, straight away."),
);

// ---------- 4 ----------
c.push(
  H1("4. Making a new version"),
  ...steps([
    "Make your changes in `" + REPO + "`. Changing what people see on the printing page (`Source code/server/public`)? Look at it in a browser as in section 5.",
    "Changed `Source code/server/public/lang.js`? Copy it to `~/Desktop/PrintBridge/printbridge-updates/lang.js` too: the download page uses the same file.",
    "Raise the version number. It must be higher than the last one published (see the Releases page):",
    code("cd " + REPO + "/\"Source code\"/release"),
    code("node publish-update.js bump 4.3.0"),
    "It changes the number everywhere it is written. Don't change it by hand.",
    "Run the checks. Each one ends with \"N checks passed\":",
    code("cd " + REPO + "/\"Source code\"/tests"),
    code("for t in t1-durable t3-store t10-updates t11-fixip t12-remote t13-upload-retry t14-preview-files t15-page-view t16-other-printer t17-update-now t18-bad-messages t19-dialogs t20-printer-settings t21-bucket-expiry t22-both-sides t23-rename-remote t24-settings-survive; do node $t.js > /dev/null && echo \"ok $t\" || echo \"FAILED $t\"; done"),
    "Any FAILED: run that one on its own (`node t16-other-printer.js`) to see why, and fix it before going on. (t2, t4, t5, t6, t8 and t9 look for other computers on the network and are slower; run them before bigger changes.)",
    "Build:",
    code("cd " + REPO),
    code("LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ./BUILD-ALL.command > ~/Desktop/build.log 2>&1; echo $?"),
    "It takes a few minutes. `0` at the end means it worked; anything else, open `~/Desktop/build.log` and read the end.",
  ]),
  ...box("Why the long build command", [
    "Without `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`, a Terminal with no UTF-8 setting makes Windows Setup's builder crash (`std::bad_alloc`). Save the build output to a file as shown, and don't pipe it into `tail`: that hides a failed build.",
  ]),
  P("The installers land in a new folder in `~/Desktop/PrintBridge`, named like `PrintBridge-Installers-4.3.0-2026-11-05_1211`: `PrintBridgeSetup.exe` (Windows), `PrintBridge.pkg` and `PrintBridge-4.3.0.dmg` (Mac), and a Read me."),
);

// ---------- 5 ----------
c.push(
  H1("5. Checking it before it goes out"),
  H2("The printing page, on this Mac (2 minutes)"),
  ...steps([
    "Start the printing page from the source, on a spare port, with its own empty data folder, without looking for the office computers:",
    code("cd " + REPO + "/\"Source code\""),
    code("PORT=3955 PRINT_DATA_DIR=/tmp/pb-check NO_DISCOVERY=1 node server/server.js"),
    "Open http://localhost:3955 in a browser. Check what you changed is there, the page loads without errors, and the language picker and **Watch the full guide** button work. Then open **Printers & setup**.",
    "Press **Ctrl+C** in Terminal to stop it.",
  ]),
  H2("The installer, on one real computer (5 minutes)"),
  P("Install the new `PrintBridgeSetup.exe` (or `.pkg`) by hand on one office computer, then open **Check PrintBridge** there: it should say everything is working and show the new version. A version that doesn't start is undone by itself later, but this catches it before every computer tries."),
  H2("Save the work"),
  P("Commit as Devnith, then push:"),
  code("git add -A && git commit -m \"4.3.0: what changed\" && git push"),
);

// ---------- 6 ----------
c.push(
  H1("6. Publishing it"),
  code("cd " + REPO),
  code("./PUBLISH-UPDATE.command"),
  P("Type a one-line note of what's new (people may read it, so plain words), or press Enter. It:"),
  bullet("makes `latest.json` (the version, the note, each installer's size and SHA-256 fingerprint) and signs it with the update key, then checks its own signature;"),
  bullet("saves it all in the `Updates` folder next to the script;"),
  bullet("uploads the installers, `latest.json` and `latest.json.sig` as a new release to both **printbridge-updates** and **printbridge**."),
  P("The same thing without the questions: `node publish-update.js all --notes \"What's new\"` from `Source code/release`."),
  ...box("Never", [
    "Never edit `latest.json` on GitHub after it is signed: the computers would reject it, which is the point. Never upload installers to a release by hand without publishing them through the script.",
  ]),
);

// ---------- 7 ----------
c.push(
  H1("7. Checking what went live"),
  P("Straight after publishing, check the release on GitHub the same way the office computers will:"),
  code("cd " + REPO + "/\"Source code\"/release"),
  code("node check-live.js"),
  P("It downloads the live `latest.json`, checks its signature against the key built into the program, then downloads each installer and checks its fingerprint. You want to see:"),
  code("Version 4.3.0: signature OK  /  windows: OK  /  mac: OK  /  All good."),
  P("If anything says WRONG or DOESN'T MATCH, publish again. Then open devnithdev.github.io/printbridge-updates: the button downloads the new version (it always points at the latest release, so the page itself needs no change)."),
);

// ---------- 8 ----------
c.push(
  H1("8. How the computers update themselves"),
  bullet("Every computer on 4.1.3 or newer checks for a new version **every hour**."),
  bullet("When it finds one, it waits its turn (computers spread themselves over half an hour, so they don't all restart together), downloads it, and checks the signature and fingerprint."),
  bullet("It waits until **nothing is printing** on that computer, installs with no questions (every setting is kept), and checks the new version starts. If it doesn't, the previous version is put back by itself and it tries again a day later."),
  bullet("To update one computer straight away: **Update PrintBridge now** (Windows: Start menu; Mac: Applications > PrintBridge)."),
  H2("Watching it"),
  ...table2(["Where", "What it shows"], [
    ["**Check PrintBridge** on any computer", "\"Up to date\", \"A new version is available...\", \"Updated automatically\", or what went wrong."],
    ["**Printers & setup** on the main computer", "The Version column for every computer with a printer."],
    ["`updates.log`", "Every step in plain words. Windows: `C:\\ProgramData\\Office Printing\\logs`. Mac: `/Library/Application Support/PrintBridge/data/logs`."],
  ], 3300),
  H2("If a version turns out to be bad"),
  bullet("Fix it and publish the next version. Computers never install a lower number, so going back means publishing the old code with a higher number."),
  bullet("To hold back the computers that haven't updated yet: `node publish-update.js sign --paused`, then replace `latest.json` and `latest.json.sig` on the release with the new ones."),
  bullet("To stop updates on one computer: put a file `update-settings.json` containing `{\"automatic\": false}` in its data folder (Windows: `C:\\ProgramData\\Office Printing`; Mac: `/Library/Application Support/PrintBridge/data`). Delete it to switch them back on."),
);

// ---------- 9 ----------
c.push(
  H1("9. Setting up a new office computer"),
  P("There is one installer for every computer. Get it from **devnithdev.github.io/printbridge-updates** (it offers the right one for Windows or Mac), or from the newest Desktop build folder. The video guide shows every screen: youtu.be/Cx2plyjPf7w. Once installed, the computer keeps itself up to date."),
  H2("Windows"),
  ...steps([
    "Double-click **PrintBridgeSetup.exe**. If a blue \"Windows protected your PC\" box appears: **More info**, then **Run anyway**, and allow the changes.",
    "Choose what this computer does and give it a name people know, like \"Front desk\":",
    bullet("**This is the main computer**: only one, a computer that stays on during office hours. Tick **Make this the only main computer** and **Give this computer a fixed address** (keep the suggested one, like 192.168.1.200), so the wall sign keeps working."),
    bullet("**This computer shares a printer**: any computer with a printer plugged in. It finds the main computer by itself."),
    bullet("**This computer only prints**: to print from Excel, Word and other programs through the **PrintBridge** printer."),
    "Keep the recommended power choices (not on a laptop that travels). Press **Finish**. On the main computer the wall sign opens: print it and put it up by the printer.",
  ]),
  H2("Mac"),
  ...steps([
    "Double-click **PrintBridge.pkg** (or open the .dmg first). If macOS says it can't be opened: **Done**, then **System Settings > Privacy & Security**, scroll down, **Open Anyway**, and your password.",
    "Follow the installer. A setup page opens in the browser: choose what this Mac does, give it a name, tick the same boxes as on Windows for a main computer, and press **Set up PrintBridge**. Keep the page open until it says **All set**.",
  ]),
  H2("After setting one up"),
  bullet("A computer with a printer: its printers show on the printing page within a minute. On **Printers & setup**, check each printer's **Type** and **Colour**: they show on the printer cards, and decide which printers may stand in for each other when someone ticks **Print on another printer** (a laser printer set as inkjet won't stand in for a laser)."),
  bullet("Hide a printer nobody should use on the same page."),
  bullet("**Check PrintBridge** on the new computer should say everything is working."),
  bullet("Phones need nothing: they scan the wall sign. Order for a whole office: the main computer first, then the computers with printers, then the ones that only print."),
);

// ---------- 10 ----------
c.push(
  H1("10. Printing from anywhere (remote codes)"),
  P("Chosen people can send a file from home to an office printer. They open the online drop page, type their personal code and choose the file; the main computer collects it and prints it. Files are locked in their browser and only the main computer can unlock them."),
  ...table2(["Part", "Where"], [
    ["The drop page", "https://printbridge.adeesharajarathne.workers.dev (a Cloudflare Worker named **printbridge**, with a KV store named **printbridge** bound as `PB`)."],
    ["Pairing code", "Joins the drop page to the main computer. It was given to you in chat when the drop page was made. Keep it like a password."],
    ["Lock code", "Locks the remote printing settings on Printers & setup. It is the same as the pairing code you were given."],
  ], 2600),
  H2("Turning it on (once, not done yet)"),
  ...steps([
    "On the **main computer itself**, open the printing page, then **Printers & setup**.",
    "In **Printing from anywhere**, unlock with the lock code.",
    "Paste the drop page's address and the pairing code, and press **Connect**.",
    "Under **Add a person**: their name, how many printouts a day (0 = no limit), which printers they may use (none ticked = all), and whether their printouts wait until someone in the office presses Print. Press **Make a code** and give them the code.",
  ]),
  H2("Day to day"),
  bullet("Someone lost their code or left: remove them in **People with a code**, and make a new code if needed."),
  bullet("**Waiting for approval** and **Recent remote printouts** show what came in."),
  bullet("Cloudflare's free plan allows 1,000 writes a day for the whole account, which is why the office reports \"online\" only every 10 minutes."),
  H2("If the pairing code is lost"),
  ...steps([
    "Make a new drop page with a new code: `cd " + REPO + "/\"Source code\"/relay` then `node build.js`. It prints the new pairing code.",
    "In Cloudflare: **Workers & Pages > printbridge > Edit code**, replace everything with the contents of `relay/dist/worker.js`, and **Deploy**.",
    "On the main computer: **Disconnect the drop page**, then connect again with the new code.",
  ]),
);

// ---------- 11 ----------
c.push(
  H1("11. If something goes wrong"),
  ...table2(["What you see", "What to do"], [
    ["Build ends with `std::bad_alloc`", "Run it with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` in front (section 4)."],
    ["Build: \"Missing: makensis\"", "`brew install makensis`, then build again."],
    ["Build: \"This Mac needs Rosetta\"", "`softwareupdate --install-rosetta --agree-to-license`"],
    ["Build: \"wasn't signed by the build above\"", "Install Xcode Command Line Tools: `xcode-select --install`."],
    ["Build: \"there is no update key in this build\"", "`Source code/desktop/lib/update-key.js` lost its key. Get it back from git (`git checkout -- \"Source code/desktop/lib/update-key.js\"`)."],
    ["A check says FAILED", "Run that check on its own to see why, and fix it before building."],
    ["Publish: the version is already published", "Raise it with `bump`, build again, then publish."],
    ["Publish: the key isn't the one in update-key.js", "You're using another key file. Point to the right one with `--key`."],
    ["`check-live.js` says WRONG or DOESN'T MATCH", "Publish again. Never fix files on GitHub by hand."],
    ["Check PrintBridge: \"Couldn't check for updates\"", "That computer can't reach github.com. Printing still works; it updates once it can."],
    ["Check PrintBridge: \"This computer can't update itself\"", "Run the newest Setup on it by hand, once."],
    ["Windows: \"Windows protected your PC\"", "**More info > Run anyway**. The installer isn't code-signed yet."],
    ["Mac: \"can't be opened\"", "System Settings > Privacy & Security > **Open Anyway**."],
    ["The printing page shows an error, or phones can't reach it", "On the main computer press **Refresh address**; print a new wall sign if the address changed. A fixed address stops this."],
    ["Word, Excel or photo files won't print", "LibreOffice isn't on the main computer: run Setup again there (Mac: Reconfigure PrintBridge) and tick LibreOffice."],
  ], 3600, 20),
  H2("Still to do (for a later version)"),
  bullet("Sign the Windows installer with a code-signing certificate, so SmartScreen stops warning."),
  bullet("Sign and notarise the Mac installer (see `Source code/installer-mac/BUILD-ON-MAC.txt`)."),
  bullet("Ask for approval before a new printer computer is accepted."),
  bullet("Connect the remote drop page on the main computer and add the first people (section 10)."),
);

// ====================================================================
const doc = new Document({
  creator: "Devnith", lastModifiedBy: "Devnith",
  title: "PrintBridge - How to build and roll out",
  description: "Building, checking, signing and publishing PrintBridge, and setting up office computers",
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
      ...LISTS.map((reference) => ({ reference, levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 567, hanging: 340 } }, run: { bold: true } } },
      ] })),
    ],
  },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "PrintBridge \u00b7 how to build and roll out  \u00b7  \u2615 by @devnithdev  \u00b7  page ", color: GREY, size: 18 }), new TextRun({ children: [PageNumber.CURRENT], color: GREY, size: 18 })],
    })] }) },
    children: c,
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log("wrote", OUT, buf.length, "bytes"); });
