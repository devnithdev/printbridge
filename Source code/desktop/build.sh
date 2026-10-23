#!/bin/bash
# Builds the program from the website, the agent and this folder.
#   ./build.sh                     Windows only: dist/OfficePrinting.exe
#   ./build.sh --mac               also dist/PrintBridge-x64 and
#                                   dist/PrintBridge-arm64 (Intel and Apple
#                                   Silicon - see installer-mac/)
#   ./build.sh --linux             also dist/office-printing-linux (testing only)
#   ./build.sh --mac --no-windows  macOS only, skips the Windows build
set -e
# Apple Silicon Macs need Rosetta: pkg runs an Intel (x64) base program while it
# builds, and without Rosetta that stops with "spawn Unknown system error -86".
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] && ! /usr/bin/arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
  echo "This Mac needs Rosetta to build. Install it once with:" >&2
  echo "    softwareupdate --install-rosetta --agree-to-license" >&2
  echo "then run this again." >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

WANT_MAC=0
WANT_LINUX=0
WANT_WINDOWS=1
for arg in "$@"; do
  case "$arg" in
    --mac) WANT_MAC=1 ;;
    --linux) WANT_LINUX=1 ;;
    --no-windows) WANT_WINDOWS=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

for pkgdir in "$ROOT/server" "$ROOT/agent"; do
  if [ ! -d "$pkgdir/node_modules" ]; then
    echo "Installing dependencies in $pkgdir (first time only)..."
    (cd "$pkgdir" && npm install --omit=dev)
  fi
done

mkdir -p "$STAGE/desktop" "$STAGE/server" "$STAGE/agent/node_modules" "$HERE/dist"
cp "$HERE/package.json" "$STAGE/package.json"
cp -r "$HERE/main.js" "$HERE/lib" "$STAGE/desktop/"
cp -r "$ROOT/server/server.js" "$ROOT/server/lib" "$ROOT/server/public" "$ROOT/server/package.json" "$ROOT/server/node_modules" "$STAGE/server/"
cp -r "$ROOT/agent/agent.js" "$ROOT/agent/lib" "$ROOT/agent/package.json" "$STAGE/agent/"
cp -r "$ROOT/agent/node_modules/ws" "$STAGE/agent/node_modules/"

cd "$STAGE"

if [ "$WANT_WINDOWS" = "1" ]; then
  npx --yes pkg@5.8.1 . --targets node16-win-x64 --output "$HERE/dist/OfficePrinting.exe"
  # Make the Windows program a "windowed" program rather than a console
  # one, so no black window ever appears. (Node.js supports this: with no
  # console its output simply goes nowhere, and here it goes to log files
  # anyway.)
  python3 "$HERE/set-windowed.py" "$HERE/dist/OfficePrinting.exe"
fi

if [ "$WANT_LINUX" = "1" ]; then
  npx --yes pkg@5.8.1 . --targets node16-linux-x64 --output "$HERE/dist/office-printing-linux"
fi

if [ "$WANT_MAC" = "1" ]; then
  # node18, not node16 like Windows above: pkg 5.8.1's node16 build doesn't
  # offer an Apple Silicon target, and node18 works fine on both.
  npx --yes pkg@5.8.1 . --targets node18-macos-x64 --output "$HERE/dist/PrintBridge-x64"
  npx --yes pkg@5.8.1 . --targets node18-macos-arm64 --output "$HERE/dist/PrintBridge-arm64"

  # NOT merged into one "universal" file with lipo: pkg finds the program
  # inside its own binary by absolute file position, and lipo moves each
  # half to a different position in the merged file, so the merged program
  # can't find itself and fails as soon as it starts. Two separate
  # single-architecture files always work; installer-mac/postinstall puts
  # the right one in place for the Mac it is installing on.
  chmod +x "$HERE/dist/PrintBridge-x64" "$HERE/dist/PrintBridge-arm64"

  # Apple Silicon refuses to run a wholly unsigned arm64 binary at all - an
  # ad-hoc signature is the minimum that satisfies that. codesign is only
  # on macOS itself; installer-mac/build-pkg.sh signs as part of packaging.
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$HERE/dist/PrintBridge-x64"
    codesign --force --sign - "$HERE/dist/PrintBridge-arm64"
  else
    echo "NOTE: codesign isn't available here (this isn't a Mac), so the Mac programs aren't signed yet." >&2
    echo "      installer-mac/build-pkg.sh signs them as part of building the installer, on an actual Mac." >&2
  fi
fi

ls -la "$HERE/dist"
