#!/bin/bash
# Builds PrintBridge.pkg - the macOS installer. Run this ON AN ACTUAL MAC
# (or a macOS CI runner): pkgbuild, productbuild and a working codesign are
# all Apple's own tools, with no equivalent anywhere else, so this is the
# one step in building PrintBridge that can't be done from Linux or
# Windows - everything else (the Intel and Apple Silicon programs included)
# can be, and was, built and checked without one.
#
#   cd installer-mac
#   ./build-pkg.sh
#
# Needs Xcode Command Line Tools (for codesign; install with
# "xcode-select --install" if `codesign -h` doesn't work) and Node.js (to
# run desktop/build.sh, which uses `npx pkg` to build the program itself).
#
# Optional, for an installer that opens without any Apple warning (needs a paid
# Apple Developer account; see BUILD-ON-MAC.txt). Set these before running:
#   APP_SIGN_ID="Developer ID Application: Your Name (TEAMID)"
#   PKG_SIGN_ID="Developer ID Installer: Your Name (TEAMID)"
#   NOTARY_PROFILE="printbridge"      (made once with: xcrun notarytool store-credentials)
# Without them the installer is still built, but unsigned.

set -e
# Files downloaded from the internet carry hidden labels that pkgbuild would
# otherwise copy into the installer as stray "._" files.
export COPYFILE_DISABLE=1
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/desktop/package.json" | head -1)"
IDENTIFIER="com.printbridge.pkg"
OUT="$HERE/dist"

if ! command -v pkgbuild >/dev/null 2>&1; then
  echo "pkgbuild wasn't found - this has to be run on a Mac (it comes with Xcode Command Line Tools)." >&2
  exit 1
fi

xattr -cr "$ROOT" >/dev/null 2>&1 || true

echo "Building the Intel and Apple Silicon programs..."
"$ROOT/desktop/build.sh" --mac --no-windows

ARCHS="x64 arm64"
# With a Developer ID, sign the programs properly (hardened runtime, timestamp)
# instead of the ad-hoc signature desktop/build.sh made.
if [ -n "$APP_SIGN_ID" ]; then
  echo "Signing the programs with your Developer ID..."
  for a in $ARCHS; do
    codesign --force --options runtime --timestamp --entitlements "$HERE/entitlements.plist" \
      --sign "$APP_SIGN_ID" "$ROOT/desktop/dist/PrintBridge-$a"
  done
fi

for a in $ARCHS; do
  if ! codesign -dv "$ROOT/desktop/dist/PrintBridge-$a" >/dev/null 2>&1; then
    echo "dist/PrintBridge-$a wasn't signed by the build above - Apple Silicon would refuse to run it. Stopping." >&2
    exit 1
  fi
done

echo "Staging the files exactly as they'll be installed..."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PAYLOAD="$STAGE/payload/Library/Application Support/PrintBridge"
mkdir -p "$PAYLOAD"
# Both go in; postinstall keeps the one that fits this Mac, as "PrintBridge".
for a in $ARCHS; do
  cp "$ROOT/desktop/dist/PrintBridge-$a" "$PAYLOAD/PrintBridge-$a"
  chmod +x "$PAYLOAD/PrintBridge-$a"
done

# pkgbuild's --scripts bundles the WHOLE directory it's pointed at into the
# package, not just preinstall/postinstall - so pointing it straight at
# $HERE also swept up $OUT ("installer-mac/dist"), including any earlier
# PrintBridge.pkg already sitting there from a previous run of this same
# script, into the new one, growing forever. Copying only the scripts
# actually needed into their own empty staging folder avoids that, however
# many times this is run.
SCRIPTS="$STAGE/scripts"
mkdir -p "$SCRIPTS"
cp "$HERE/preinstall" "$SCRIPTS/preinstall"
cp "$HERE/postinstall" "$SCRIPTS/postinstall"
cp "$HERE/com.printbridge.service.plist" "$SCRIPTS/com.printbridge.service.plist"
cp "$HERE/uninstall-helper.sh" "$SCRIPTS/uninstall-helper.sh"
cp "$HERE/Uninstall-PrintBridge.command" "$SCRIPTS/Uninstall-PrintBridge.command"
chmod +x "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"

mkdir -p "$OUT"
rm -f "$OUT"/*.pkg "$OUT"/*.dmg

echo "Building the package..."
pkgbuild \
  --root "$STAGE/payload" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location "/" \
  --scripts "$SCRIPTS" \
  "$STAGE/PrintBridge-component.pkg"

# Wrap it so the installer shows a welcome and a finish screen.
cat > "$STAGE/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>PrintBridge</title>
  <organization>com.printbridge</organization>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="x86_64,arm64"/>
  <domains enable_localSystem="true"/>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default" title="PrintBridge"><pkg-ref id="$IDENTIFIER"/></choice>
  <pkg-ref id="$IDENTIFIER" version="$VERSION" onConclusion="none">PrintBridge-component.pkg</pkg-ref>
</installer-gui-script>
XML

PRODUCT_ARGS=()
if [ -n "$PKG_SIGN_ID" ]; then PRODUCT_ARGS=(--sign "$PKG_SIGN_ID" --timestamp); fi
productbuild \
  --distribution "$STAGE/distribution.xml" \
  --resources "$HERE/resources" \
  --package-path "$STAGE" \
  ${PRODUCT_ARGS[@]+"${PRODUCT_ARGS[@]}"} \
  "$OUT/PrintBridge.pkg"

# Apple's check for malicious software; after this the installer opens without warnings.
if [ -n "$PKG_SIGN_ID" ] && [ -n "$NOTARY_PROFILE" ]; then
  echo "Sending to Apple for notarisation (usually a few minutes)..."
  xcrun notarytool submit "$OUT/PrintBridge.pkg" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUT/PrintBridge.pkg"
  NOTARISED=1
fi

# A disk image with the installer inside, the usual thing to download.
DMG_DIR="$STAGE/dmg"
mkdir -p "$DMG_DIR"
cp "$OUT/PrintBridge.pkg" "$DMG_DIR/"
hdiutil create -volname "PrintBridge" -srcfolder "$DMG_DIR" -ov -format UDZO "$OUT/PrintBridge-$VERSION.dmg" >/dev/null
if [ -n "$PKG_SIGN_ID" ] && [ -n "$NOTARY_PROFILE" ]; then
  codesign --force --timestamp --sign "${APP_SIGN_ID:-$PKG_SIGN_ID}" "$OUT/PrintBridge-$VERSION.dmg" 2>/dev/null || true
fi

echo
echo "Done:"
echo "  $OUT/PrintBridge.pkg"
echo "  $OUT/PrintBridge-$VERSION.dmg"
if [ -z "$PKG_SIGN_ID" ]; then
  echo "Not signed: on other Macs, open it once, then System Settings > Privacy & Security > Open Anyway."
elif [ -z "$NOTARISED" ]; then
  echo "Signed but not notarised (NOTARY_PROFILE not set)."
fi
