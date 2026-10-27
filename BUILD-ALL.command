#!/bin/bash
# Builds PrintBridge for Windows and Mac, start to finish.
#
# At the end the finished installers (PrintBridgeSetup.exe, PrintBridge.pkg and
# PrintBridge-<version>.dmg) are saved in a BRAND NEW folder on your Desktop, named
# with the date and time of the build, so an earlier build is never overwritten.
# A copy also stays in the "Installers" folder next to this file.
#
# The version number comes from Source code/desktop/lib/version.js (raise it
# with:  cd "Source code/release"  then  node publish-update.js bump 4.1.4).
# To send a build to every computer as an automatic update afterwards, run
# ./PUBLISH-UPDATE.command.
#
# Run it from Terminal:   cd to this folder, then   ./BUILD-ALL.command
# Needs: Node.js, makensis (brew install makensis), Xcode command line tools,
# and Rosetta on an Apple Silicon Mac. It prints "Done" at the end.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/Source code"
VERSION="$(sed -n 's/.*VERSION: "\([^"]*\)".*/\1/p' "$SRC/desktop/lib/version.js")"
[ -n "$VERSION" ] || { echo "Couldn't read the version from Source code/desktop/lib/version.js." >&2; exit 1; }
OUT="$ROOT/Installers"
FINAL="$HOME/Desktop/PrintBridge-Installers-$VERSION-$(date +%Y-%m-%d_%H%M)"
mkdir -p "$OUT"

echo "Building PrintBridge $VERSION."
if ! grep -q '"[A-Za-z0-9+/=]\{40,\}"' "$SRC/desktop/lib/update-key.js"; then
  echo "NOTE: there is no update key in this build, so these installers can't update themselves later."
  echo "      Run ./PUBLISH-UPDATE.command once first (it makes the key), then build again."
fi

echo "=== 1/2  Windows installer ==="
(cd "$SRC/installer" && chmod +x build-windows.sh ../desktop/build.sh && ./build-windows.sh)

echo "=== 2/2  Mac installer ==="
(cd "$SRC/installer-mac" && chmod +x build-pkg.sh ../desktop/build.sh preinstall postinstall uninstall-helper.sh Uninstall-PrintBridge.command && ./build-pkg.sh)

# Only copy what was just built; stop if any of the three is missing.
for f in "$SRC/installer/dist/PrintBridgeSetup.exe" "$SRC/installer-mac/dist/PrintBridge.pkg" "$SRC/installer-mac/dist/PrintBridge-$VERSION.dmg"; do
  [ -s "$f" ] || { echo "Missing or empty: $f - the build did not finish." >&2; exit 1; }
done

cp -f "$SRC/installer/dist/PrintBridgeSetup.exe" "$OUT/"
cp -f "$SRC/installer-mac/dist/PrintBridge.pkg" "$OUT/"
cp -f "$SRC/installer-mac/dist/PrintBridge-$VERSION.dmg" "$OUT/"

mkdir -p "$FINAL"
cp -f "$OUT/PrintBridgeSetup.exe" "$OUT/PrintBridge.pkg" "$OUT/PrintBridge-$VERSION.dmg" "$FINAL/"
cat > "$FINAL/READ ME.txt" <<TXT
PrintBridge $VERSION  -  by @devnithdev
Built $(date "+%Y-%m-%d %H:%M")

PrintBridgeSetup.exe       For Windows computers. Copy it to each PC (USB stick) and run it.
                           Windows SmartScreen: More info, then Run anyway.
PrintBridge-$VERSION.dmg   For Macs. Open it, then double-click PrintBridge.pkg.
PrintBridge.pkg            The same Mac installer, without the disk image.
                           macOS: if it won't open, click Done, then System Settings >
                           Privacy & Security > "Open Anyway" (right-click > Open no longer
                           works on macOS 15 and later).

Install the main computer first, then the others. Installing over an older version keeps its settings.
Computers with 4.1.3 or newer update themselves once a version is published (PUBLISH-UPDATE.command).
TXT

echo
echo "Done. The finished installers are saved in this new folder on your Desktop:"
echo "  $FINAL"
ls -la "$FINAL"
open "$FINAL" 2>/dev/null || true
