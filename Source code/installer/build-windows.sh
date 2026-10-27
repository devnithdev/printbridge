#!/bin/bash
# Builds installer/dist/PrintBridgeSetup.exe, start to finish, on Linux (or
# Windows with WSL). Run it from anywhere:
#
#   cd installer
#   ./build-windows.sh
#
# What it does, in order:
#   1. Builds the program once so pkg downloads its Windows base program.
#   2. Relabels a copy of that base program (version info + icon) with
#      desktop/tools/relabel-exe, and keeps it in a private pkg cache.
#   3. Builds desktop/dist/OfficePrinting.exe from that copy (desktop/build.sh).
#   4. Builds installer/dist/PrintBridgeSetup.exe with makensis.
#
# Needs: Node.js 16+ with npm, python3, makensis (NSIS 3), and
# agent/tools/SumatraPDF.exe (64-bit portable, from sumatrapdfreader.org).
# The first run needs internet (npm packages, pkg's base program).
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
BASE="v16.16.0-win-x64"

for tool in node npm npx python3 makensis; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing: $tool. Install it (Node.js 16+ with npm, python3, makensis from NSIS 3) and run this again." >&2; exit 1; }
done
[ -f "$ROOT/agent/tools/SumatraPDF.exe" ] || { echo "Missing agent/tools/SumatraPDF.exe: download the 64-bit portable SumatraPDF from sumatrapdfreader.org and save it there." >&2; exit 1; }

DEFAULT_CACHE="${PKG_CACHE_PATH:-$HOME/.pkg-cache}"
find_base() { find "$DEFAULT_CACHE" -name "fetched-$BASE" 2>/dev/null | head -1; }

SRC="$(find_base)"
if [ -z "$SRC" ]; then
  echo "1/4 Fetching pkg's Windows base program (first run only)..."
  "$ROOT/desktop/build.sh" >/dev/null 2>&1 || true
  SRC="$(find_base)"
  [ -n "$SRC" ] || { echo "pkg did not download its Windows base program. Check the internet and try again." >&2; exit 1; }
fi

echo "2/4 Relabelling the base program (PrintBridge, Devnith AE, icon)..."
(cd "$ROOT/desktop/tools/relabel-exe" && npm install --silent --no-audit --no-fund)
PRIVATE="$HERE/.pkg-cache"
rm -rf "$PRIVATE"
mkdir -p "$PRIVATE/$(basename "$(dirname "$SRC")")"
node "$ROOT/desktop/tools/relabel-exe/relabel-exe.js" "$SRC" \
  "$PRIVATE/$(basename "$(dirname "$SRC")")/built-$BASE" "$HERE/office-printing.ico"
chmod +x "$PRIVATE"/*/built-"$BASE"

echo "3/4 Building OfficePrinting.exe..."
PKG_CACHE_PATH="$PRIVATE" "$ROOT/desktop/build.sh"

echo "4/4 Building PrintBridgeSetup.exe..."
mkdir -p "$HERE/dist"
(cd "$HERE" && makensis -V2 OfficePrinting.nsi)

echo
echo "Done: $HERE/dist/PrintBridgeSetup.exe"
ls -la "$HERE/dist/PrintBridgeSetup.exe"
