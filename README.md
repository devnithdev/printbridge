# PrintBridge

Print from any phone or computer to any printer in the office: one main computer runs the printing page, computers with printers share them, and everyone else prints from a browser or the **PrintBridge** virtual printer. No app to install on phones, no accounts. ☕ by [@devnithdev](https://github.com/devnithdev).

## Download

Ready-to-run installers for Windows and Mac, along with the user guide and FAQ, are published in **[devnithdev/printbridge-updates](https://github.com/devnithdev/printbridge-updates)**:

* **[Latest Release (Windows `.exe` & Mac `.dmg` / `.pkg`)](https://github.com/devnithdev/printbridge-updates/releases/latest)**

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
   * Run `./PUBLISH-UPDATE.command`. It signs `latest.json` with your private update key (`*.pem` is gitignored and never stored in the repository) and uploads the release to `printbridge-updates`. Installed computers verify the signature and SHA-256 fingerprint before installing.

---

## License

Released under the [MIT License](LICENSE). Third-party components (`SumatraPDF`, `PDF.js`, `QRCode.js`) are included under their respective licenses in `Source code/installer/` and `Source code/server/public/vendor/`.
