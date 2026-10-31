<div align="center">

<img src="Source%20code/installer/guide-img/printbridge-badge.png" alt="PrintBridge" width="280">

### Print from any phone or computer to any printer in the office.

One main computer runs the printing page, computers with printers share them, and everyone else prints from a browser or the **PrintBridge** virtual printer. No app to install on phones, no accounts. ☕ by [@devnithdev](https://github.com/devnithdev).

<br>

[![Download PrintBridge](https://img.shields.io/badge/%E2%AC%87%20Download%20PrintBridge-Download%20Page-1E6FBF?style=for-the-badge)](https://devnithdev.github.io/printbridge-updates/)
[![Windows Installer](https://img.shields.io/badge/Windows-PrintBridgeSetup.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/devnithdev/printbridge/releases/latest/download/PrintBridgeSetup.exe)
[![Mac Installer](https://img.shields.io/badge/macOS-PrintBridge.pkg-21A67B?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/devnithdev/printbridge/releases/latest/download/PrintBridge.pkg)

</div>

---

## Screenshots

| **Print from any phone or browser** | **Preview pages & pick a printer** |
| :---: | :---: |
| <img src="Source%20code/installer/proposal-img/f-home.png" alt="PrintBridge home screen" width="360"> | <img src="Source%20code/installer/guide-img/preview.png" alt="Print preview and page selection" width="420"> |
| **Live print queue** | **Printable wall QR sign** |
| <img src="Source%20code/installer/proposal-img/f-queue.png" alt="Live print queue" width="360"> | <img src="Source%20code/installer/proposal-img/f-poster.png" alt="Wall QR sign for phones" width="360"> |
| **Simple role-based setup** | **Built-in status check** |
| <img src="Source%20code/installer/guide-img/role-main.png" alt="Setup installer role picker" width="420"> | <img src="Source%20code/installer/guide-img/check.png" alt="Check PrintBridge status page" width="420"> |

---

## Highlights

* **Zero-install mobile printing**: Scan a QR code on the office wall and print directly from Safari, Chrome, or any mobile browser on iPhone, iPad, and Android. No apps or accounts needed.
* **Google Cloud Print alternative**: Keeps all printing local to your office Wi-Fi network. No cloud subscriptions, external accounts, or documents leaving your building.
* **Cross-platform**: Seamlessly connects Windows 10/11 and macOS (Apple Silicon & Intel) machines across the local network.
* **Print from desktop apps**: Includes a native **PrintBridge** virtual printer so you can print directly from Microsoft Office, Acrobat, or any software.
* **Smart print preview & queue**: Page-by-page visual preview, printer type selection (inkjet, laser, dot matrix, thermal/receipt), live queue tracking, and automatic failover if a printer is busy.
* **Self-healing**: Resumes automatically after power cuts, automatically rediscovers network addresses, and verifies signed updates in the background.

---

## Download

Get the ready-to-run installer for Windows or Mac from the **[Download Page](https://devnithdev.github.io/printbridge-updates/)** or **[Latest Release](https://github.com/devnithdev/printbridge/releases/latest)**:

| File | For |
|---|---|
| **[`PrintBridgeSetup.exe`](https://github.com/devnithdev/printbridge/releases/latest/download/PrintBridgeSetup.exe)** | Windows 10 and 11 (64-bit). If SmartScreen appears: *More info → Run anyway*. |
| **[`PrintBridge.pkg`](https://github.com/devnithdev/printbridge/releases/latest/download/PrintBridge.pkg)** | Macs (Apple Silicon and Intel). If macOS says it can't be opened: *System Settings → Privacy & Security → Open Anyway*. |

Install the **main computer** first, then the **computers with printers**, then the ones that only print.

---

## What's here

| Folder / File | What it does |
|---|---|
| `Source code/server` | The printing website and queue (runs on the main computer) |
| `Source code/agent` | Printer sharing and print job execution |
| `Source code/desktop` | The single background program installed on every computer: supervisor, Check page, Mac setup wizard, automatic updates (`lib/updater.js`), and fixed IP setup (`lib/fixip.js`) |
| `Source code/installer` | Windows Setup installer (NSIS) |
| `Source code/installer-mac` | macOS `.pkg` and `.dmg` installer scripts |
| `Source code/relay` | Optional Cloudflare Worker drop page for remote printing ("Printing from anywhere") |
| `Source code/release/publish-update.js` | Key generation, version bumping, release signing, and publishing |
| `Source code/tests` | Automated test suites (`t1-durable.js` through `t12-remote.js`) |
| `BUILD-ALL.command` | Builds both the Windows and Mac installers from start to finish on a Mac |
| `PUBLISH-UPDATE.command` | Signs the release manifest and publishes an automatic update |

---

## Running the tests

Requires Node.js (v18 or newer):

```bash
cd "Source code/server" && npm install
cd "../agent" && npm install
cd "../tests"
node t1-durable.js
node t3-store.js
node t5-supervisor.js
node t10-updates.js
node t11-fixip.js
node t12-remote.js
node t13-upload-retry.js
node t14-preview-files.js
```

---

## Building the installers

1. **Bump the version number** (updates all package, server, agent, and installer files):
   ```bash
   cd "Source code/release" && node publish-update.js bump 4.2.3
   ```
2. **Build**:
   * **On a Mac**: run `./BUILD-ALL.command` (requires Node.js, `makensis` via Homebrew, Xcode Command Line Tools, and Rosetta on Apple Silicon).
   * **On GitHub Actions**: push a version tag (`git tag v4.2.3 && git push --tags`) or trigger **Actions → Build installers → Run workflow**, then download the installers from the run's Artifacts.
3. **Publish an update**:
   * Run `./PUBLISH-UPDATE.command`. It signs `latest.json` with your private update key (`*.pem` is gitignored and never stored in the repository) and uploads the release to both `printbridge` and `printbridge-updates`. Installed computers verify the signature and SHA-256 fingerprint before installing.

---

## Contributing

Contributions are welcome, and no printer is needed for most of them. Start with a [good first issue](https://github.com/devnithdev/printbridge/labels/good%20first%20issue) or [help wanted](https://github.com/devnithdev/printbridge/labels/help%20wanted), and see [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, test and send a change.

---

## License

Released under the [MIT License](LICENSE). Third-party components (`SumatraPDF`, `PDF.js`, `QRCode.js`) are included under their respective licenses in `Source code/installer/` and `Source code/server/public/vendor/`.
