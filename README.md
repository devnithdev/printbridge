# PrintBridge

Print from any phone or computer to any printer in the office: one main computer runs the printing page, computers with printers share them, and everyone else prints from a browser or the "PrintBridge" printer. No app, no accounts. By @devnithdev.

This repository is **private**: it holds the source code. The installers and signed update files are published separately, in the public repository [devnithdev/printbridge-updates](https://github.com/devnithdev/printbridge-updates), which every installed computer checks for new versions.

## What's here

| | |
|---|---|
| `Source code/server` | The printing website (main computer) |
| `Source code/agent` | Printer sharing |
| `Source code/desktop` | The one program installed everywhere: background program, Check page, Mac setup page, automatic updates (`lib/updater.js`), fixed address (`lib/fixip.js`) |
| `Source code/installer`, `installer-mac` | Windows Setup (NSIS) and the Mac installer |
| `Source code/release/publish-update.js` | Signing key, version numbers, signing and publishing releases |
| `Source code/tests` | Automatic checks (`node t1-durable.js` ... `node t11-fixip.js`) |
| `BUILD-ALL.command`, `PUBLISH-UPDATE.command` | Build both installers / publish an update, on the Mac |
| `PrintBridge - How to build and roll out.docx` | The step-by-step guide |

## Making a new version

1. `cd "Source code/release" && node publish-update.js bump 4.1.4`
2. Build: on the Mac with `./BUILD-ALL.command`, **or** online: push a tag (`git tag v4.1.4 && git push --tags`) or run **Actions → Build installers → Run workflow**, then download the installers from the run's Artifacts.
3. Try the new installer on one computer.
4. Publish: `./PUBLISH-UPDATE.command` on the Mac. It signs `latest.json` with the private key (kept in `~/Documents/PrintBridge update key (keep secret)/`, never in this repository) and creates the release in `printbridge-updates`. Every computer then updates itself within about 6 hours.

The private signing key must never be committed or uploaded (`*.pem` is ignored).
