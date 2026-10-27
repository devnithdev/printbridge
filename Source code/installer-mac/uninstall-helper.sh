#!/bin/bash
# The actual removal, run as root (via "do shell script ... with
# administrator privileges" from Uninstall PrintBridge.command, which only
# asks the questions - this is what acts on the answers).
#
# Arguments: KEEP_DATA (1 or 0) KEEP_LO (1 or 0)
#
# Unlike Windows, a running script here can delete the very folder it's
# running from - the file stays open (and this script keeps running to the
# end) even after "rm -rf" removes its directory entry - so there's no need
# for Windows' own careful "delete, retry, leave it for next boot" dance.

set -e

APP_DIR="/Library/Application Support/PrintBridge"
APP_BIN="$APP_DIR/PrintBridge"
LABEL="com.printbridge.service"
KEEP_DATA="${1:-0}"
KEEP_LO="${2:-0}"

# Its own "stop" first (it knows every part it started), then the
# LaunchDaemon, so nothing brings it back mid-uninstall.
"$APP_BIN" stop >/dev/null 2>&1 || true
launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
rm -f "/Library/LaunchDaemons/$LABEL.plist"
# The one-off job automatic updates use (see desktop/lib/updater.js).
launchctl bootout "system/com.printbridge.update" >/dev/null 2>&1 || true
rm -f "/Library/LaunchDaemons/com.printbridge.update.plist"

# Power settings back the way they were.
"$APP_BIN" restore-power >/dev/null 2>&1 || true

# The printer, LibreOffice (unless kept), and a goodbye to the main
# computer from a printer or client computer - see uninstall.js.
"$APP_BIN" before-uninstall "$KEEP_LO" || true

# The menu items (Open, Check, Restart, Reconfigure, Uninstall - see
# postinstall). Not "saved data" - always removed.
rm -rf "/Applications/PrintBridge"

if [ "$KEEP_DATA" = "1" ]; then
  echo "Kept the saved list of printers and computers in $APP_DIR/data."
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} + 2>/dev/null || true
else
  rm -rf "$APP_DIR"
  echo "Deleted the saved information and logs."
fi

# Forget the installer receipt, so a later install is treated as a fresh one.
pkgutil --forget com.printbridge.pkg >/dev/null 2>&1 || true

echo "PrintBridge has been removed."
exit 0
