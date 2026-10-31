# Contributing to PrintBridge

Thanks for helping. PrintBridge lets anyone in an office print from a phone or computer to any printer, with no app and no accounts. It runs on real office computers and updates itself, so small, well-tested changes are the most welcome kind.

## Find something to do

- **[Good first issues](https://github.com/devnithdev/printbridge/labels/good%20first%20issue)** are small and explain where to look.
- **[Help wanted](https://github.com/devnithdev/printbridge/labels/help%20wanted)** issues are bigger, or need something like an old phone to test on.
- Found a bug? Open an issue with what you did, what happened, your operating system and your PrintBridge version.
- Planning a large change or a new feature? Open an issue first, so nobody spends time on something that can't be merged.

Comment on an issue to claim it, so two people don't do the same work.

## Set it up

You need [Node.js](https://nodejs.org) 18 or newer. No printer is needed for most work.

```bash
git clone https://github.com/YOUR-USERNAME/printbridge.git
cd printbridge/"Source code/server" && npm ci
cd ../agent && npm ci
```

Or press **Code > Codespaces > Create codespace** on GitHub, which installs all of this for you.

## Run the printing page

```bash
cd "Source code/server"
NO_DISCOVERY=1 npm start
```

Then open <http://localhost:3000>. `NO_DISCOVERY=1` stops it from looking for other PrintBridge computers on your network, which matters if your network already has one. Its data goes in `server/data/`, which git ignores.

There's nothing to compile: reload the page after changing anything in `server/public/`, and restart after changing `server.js` or `server/lib/`.

To try the page on a phone, connect the phone to the same Wi-Fi and open `http://YOUR-COMPUTER'S-ADDRESS:3000`. Browsers can slow a page down to phone speed in their developer tools, which is worth doing for anything on the "Print this?" screen, because many people use it on old phones.

## Run the tests

```bash
cd "Source code/tests"
node t1-durable.js
```

Each test prints what it checked and ends with "N checks passed". [tests/README.md](Source%20code/tests/README.md) lists them all. Pull requests run the main ones automatically, but please run the ones near your change yourself. `t4`, `t5` and `t6` need a real network card, so they can fail in a container or some virtual machines for that reason alone.

New behaviour should come with a test. The existing tests are plain Node.js scripts with no test framework, and a new one can follow the same style.

## Where things are

| Folder in `Source code/` | What it is |
|---|---|
| `server/` | The printing website and queue, run by the main computer. The page itself is in `server/public/`. |
| `agent/` | Shares a computer's printers and carries out print jobs. |
| `desktop/` | The background program on every computer: startup, status page, Mac setup and automatic updates. |
| `installer/`, `installer-mac/` | The Windows and Mac installers. |
| `relay/` | Optional Cloudflare Worker for printing from outside the office. |
| `release/` | Version numbers, signing and publishing. |
| `tests/` | The automated tests. |

## Send a pull request

1. Make a branch from `main` in your fork.
2. Keep to one change, and match the code around it. Comments and on-screen wording use plain words, because the people printing aren't technical.
3. Avoid adding packages. Every package ends up inside the installers, so a few lines of code is usually the better choice.
4. Run the tests, and say in the pull request how you checked your change. A screenshot helps for anything on screen.
5. Don't change the version number. It is raised when a release is made.

If you can't test on Windows or a Mac, that's fine: say so in the pull request, and the check will be done before release.

## How releases work

Merging a pull request doesn't send anything to anyone's computer. Installed computers only accept an update signed with a private key that is never stored in this repository, so releases are built, signed and published separately by the maintainer.

Never add keys, passwords, tokens or `.pem` files to a pull request.

If you find a security problem, please don't put the details in a public issue. [Report it privately](https://github.com/devnithdev/printbridge/security/advisories/new) instead.

## Licence

By contributing, you agree that your work is released under the [MIT License](LICENSE), like the rest of the project.
