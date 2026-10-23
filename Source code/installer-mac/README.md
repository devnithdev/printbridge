# PrintBridge for Mac

Two programs (Intel and Apple Silicon; the installer keeps the one that fits the Mac) plus a `.pkg`
installer - the mac equivalent of `installer/OfficePrinting.nsi` on
Windows, doing the same job with the tools macOS actually offers.

## Building it

Everything except the very last step can be done anywhere (Linux, this
included - it's how this was built and checked):

```
cd desktop
./build.sh --mac --no-windows     # dist/PrintBridge-x64 and dist/PrintBridge-arm64
```

This needs `npx pkg` (installed automatically). The two builds are
deliberately NOT merged with `lipo` into one universal file: pkg locates its
own contents by absolute file position, which a merged file shifts, so the
merged program can't start. `postinstall` picks the right one by CPU type.

**The one step that can only be done on an actual Mac** is turning those
binaries into `PrintBridge.pkg` and a `.dmg` - `pkgbuild`, `productbuild`,
`hdiutil` and a working `codesign` are all Apple's own tools, with nothing
that reimplements them elsewhere:

```
cd installer-mac
./build-pkg.sh                    # dist/PrintBridge.pkg and dist/PrintBridge-<version>.dmg
```

With `APP_SIGN_ID`, `PKG_SIGN_ID` and `NOTARY_PROFILE` set (a paid Apple
Developer account), it also signs with the hardened runtime
(`entitlements.plist`) and notarises, so the installer opens with no
warning. Step-by-step, in plain language: `BUILD-ON-MAC.txt`.

This calls `desktop/build.sh --mac` itself, so running it is the only
command needed on the Mac. It ad-hoc-signs the binary (`codesign --sign -`)
along the way - required for Apple Silicon to run it at all - and fails
loudly if that didn't happen, rather than shipping something that would
just be killed on launch.

## What's in this folder

- `com.printbridge.service.plist` - the LaunchDaemon that runs the
  background program (the website and/or printer sharing) - starts at
  boot, before anyone signs in, and keeps running whoever if anyone is
  signed in. The mac equivalent of the Run-key entry Windows Setup adds.
- `preinstall` / `postinstall` - run by Installer.app (as root). Together
  they: stop whatever's currently running, put the files and the
  LaunchDaemon in place with the ownership launchd insists on, add a
  "PrintBridge" folder to Applications (Open / Check / Restart /
  Update now / Reconfigure / Uninstall - the mac equivalent of the Start
  Menu folder), set this computer up, and start it. See the comments in
  each file for the reasoning behind the order. During an automatic update
  (see `desktop/lib/updater.js`) the same package is installed with
  `installer -pkg` by a one-off LaunchDaemon (`com.printbridge.update`);
  `finish-install` then keeps every setting and opens no wizard.
- `uninstall-helper.sh` / `Uninstall-PrintBridge.command` - the
  uninstaller. The `.command` file is what someone double-clicks; it asks
  the questions (with plain AppleScript dialogs - what Windows' uninstall
  page asks: keep the saved list of printers/computers? keep LibreOffice,
  if this install put it there?) and then runs the helper script, once,
  elevated, to make the actual changes.
- `build-pkg.sh` - builds `dist/PrintBridge.pkg` and the `.dmg` from all of the above; `resources/` holds the installer's welcome and finish screens.
- `entitlements.plist` - what the hardened runtime needs to allow, when signing.
- `BUILD-ON-MAC.txt` - plain-language build, test and signing steps.

## How setup works, without Windows' installer pages

Apple's own installer UI (`pkgbuild`/`productbuild`/Installer.app) can't
draw custom pages the way NSIS can - there's no equivalent of the "what
does this computer do?" / "how should it behave?" pages. Instead,
`postinstall` starts the program itself with a `finish-install` command
(`desktop/lib/setup-web.js`): a small local web page, on `127.0.0.1` only,
asking exactly what the Windows pages ask, in the same order, with the
same recommended defaults. If someone is signed in, it opens in their
browser and waits (up to 15 minutes) for them to finish it; if nobody's
there to answer - an unattended install, or nobody finishes in time - the
recommended settings are used instead, so the computer is always left
working either way. The same wizard is reachable afterwards too, from
"Reconfigure PrintBridge" in the Applications folder, for changing
anything later - the mac equivalent of "run Setup again."

## The two things macOS genuinely can't do that Windows can

Said here plainly, and in `finish-install`'s own wizard page, rather than
faked:

1. **What happens when the lid closes** is a straight two-way choice here
   (keep working, or let it sleep as usual) - there's no macOS setting a
   program can turn on for "shut down when the lid closes" the way
   `powercfg`'s `LIDACTION` can on Windows.
2. **Critical battery behaviour** isn't offered at all - macOS handles a
   critically low battery itself, in the OS, with nothing a program can
   redirect. What's offered instead, automatically, on the main and
   printer-sharing roles: Low Power Mode switches on by itself while
   running on battery, to stay reachable for longer (macOS 12 Monterey or
   later - older macOS skips this setting quietly, since it doesn't exist
   there to turn on).

Everything else - the role/name/address choices, the "PrintBridge" printer
that captures Office/Excel/Word printouts as a PDF, printer sharing,
keeping the computer awake, LibreOffice, keeping the saved list of
printers when reinstalling, taking over a previous install as an update -
carries over.

## Why there's no `oldsetup.js`-style search for a previous install

Windows' `oldsetup.js` hunts through Startup folders, Task Scheduler and
the registry because Office Printing existed there for a while, by hand,
before this installer did. There's no such history here - this is the
first Mac release - so the only "previous install" that can ever exist is
an earlier `PrintBridge.pkg`, and a LaunchDaemon with one fixed, known
label (`com.printbridge.service`) is all that needs taking over. That's
what `preinstall` does, unconditionally, before the new files go in.
