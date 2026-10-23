#!/bin/bash
# Publishes the version you just built, so every computer with PrintBridge
# 4.1.3 or newer installs it by itself (automatic updates).
#
# The order, every time:
#   1. Raise the version number:   cd "Source code/release"  then
#                                  node publish-update.js bump 4.1.4
#   2. Build:                      ./BUILD-ALL.command
#   3. Try the new installers on one computer.
#   4. Publish:                    ./PUBLISH-UPDATE.command
#
# It signs latest.json with your private key (kept in
# ~/Documents/PrintBridge update key (keep secret)/ - never in this folder),
# saves everything in the "Updates" folder next to this file, and puts it on
# GitHub as a new release if the "gh" tool is installed and signed in
# (brew install gh, then gh auth login). Without gh it tells you which files
# to drag onto the GitHub release page instead.
#
# Run it from Terminal:   cd to this folder, then   ./PUBLISH-UPDATE.command
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/Source code/release"

KEY="$HOME/Documents/PrintBridge update key (keep secret)/printbridge-update-key.pem"
if [ ! -f "$KEY" ]; then
  echo "There is no signing key yet, so making one now."
  node publish-update.js keygen
  echo
  echo "Now build (./BUILD-ALL.command) so the installers know this key, install those"
  echo "on every computer once, and from then on run this after each build to publish it."
  exit 0
fi

VERSION="$(sed -n 's/.*VERSION: "\([^"]*\)".*/\1/p' "$ROOT/Source code/desktop/lib/version.js")"
echo "Publishing PrintBridge $VERSION."
read -r -p "What's new in it (one line; press Enter to skip): " NOTES
node publish-update.js all --notes "$NOTES"
