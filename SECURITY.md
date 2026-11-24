# Security

PrintBridge runs on office computers and installs its own updates, so security problems matter.

## Reporting a problem

Please **don't** put the details in a public issue. [Report it privately](https://github.com/devnithdev/printbridge/security/advisories/new) instead. Only the maintainer can see it.

Helpful to include:
- what someone could do, and from where (the office network, the internet, another account on the same computer)
- the steps to show it
- the PrintBridge version ("Check PrintBridge" shows it) and Windows or Mac

You'll get an answer as soon as possible, and credit in the release notes if you'd like it.

## Which versions get fixes

Only the latest version. Installed computers update themselves within about an hour of a new release, so a fix reaches every office without anyone doing anything.

## How updates are protected

Each update's `latest.json` is signed with a private key that never leaves the maintainer's computer, and every installer is checked against its SHA-256 fingerprint before it runs. A computer refuses an update that doesn't match. See `Source code/desktop/lib/updater.js`.
