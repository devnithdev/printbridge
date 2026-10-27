#!/bin/bash
# Uninstall PrintBridge.command - double-click to remove PrintBridge from
# this computer. Plain dialogs, no Terminal knowledge needed; asks for an
# administrator password once, to make the changes themselves.

APP_DIR="/Library/Application Support/PrintBridge"
APP_BIN="$APP_DIR/PrintBridge"
HELPER="$APP_DIR/uninstall-helper.sh"

if [ ! -x "$APP_BIN" ]; then
  osascript -e 'display dialog "PrintBridge does not seem to be installed on this computer any more." buttons {"OK"} default button 1 with icon caution' >/dev/null 2>&1
  exit 0
fi

# One screen, one button: Uninstall removes everything except what's
# ticked on the next screen - the same shape as the Windows uninstaller.
osascript <<'APPLESCRIPT' || exit 0
display dialog "This removes PrintBridge from this computer completely: the program, the \"PrintBridge\" printer and its menu items. Power settings go back to how they were.

Printers on this computer stop being shared. If this is the main computer, printing stops for everyone until PrintBridge is set up on another main computer." with title "Remove PrintBridge" buttons {"Cancel", "Uninstall"} default button "Cancel" cancel button "Cancel" with icon caution
APPLESCRIPT

# The LibreOffice checkbox only makes sense (and is only shown, same as
# Windows) if this program's own Setup was the one that installed it.
LIBREOFFICE_BY_SETUP="$("$APP_BIN" libreoffice-by-setup 2>/dev/null || echo 0)"

if [ "$LIBREOFFICE_BY_SETUP" = "1" ]; then
  CHOICES_LINE='set theChoices to choose from list {"Keep the saved list of printers and computers", "Keep LibreOffice"} with title "Remove PrintBridge" with prompt "Anything to keep? (Only useful if PrintBridge will be installed on this computer again.)" with multiple selections allowed'
else
  CHOICES_LINE='set theChoices to choose from list {"Keep the saved list of printers and computers"} with title "Remove PrintBridge" with prompt "Anything to keep? (Only useful if PrintBridge will be installed on this computer again.)" with multiple selections allowed'
fi

CHOICES="$(osascript <<APPLESCRIPT
$CHOICES_LINE
if theChoices is false then return "CANCELLED"
set AppleScript's text item delimiters to linefeed
return theChoices as string
APPLESCRIPT
)"

if [ "$CHOICES" = "CANCELLED" ]; then
  exit 0
fi

KEEP_DATA="0"
KEEP_LO="0"
case "$CHOICES" in *"Keep the saved list of printers and computers"*) KEEP_DATA="1" ;; esac
case "$CHOICES" in *"Keep LibreOffice"*) KEEP_LO="1" ;; esac

# One elevation prompt for the whole removal; the helper script (installed
# alongside the program - see installer-mac/postinstall) does the work, so
# nothing here needs escaping a multi-line script through two shells.
RESULT="$(osascript -e "do shell script \"'$HELPER' $KEEP_DATA $KEEP_LO\" with administrator privileges with prompt \"PrintBridge needs an administrator password to finish removing itself.\"" 2>&1)"
STATUS=$?

if [ $STATUS -ne 0 ]; then
  if echo "$RESULT" | grep -qi "User canceled"; then
    exit 0
  fi
  osascript -e "display dialog \"PrintBridge couldn't be fully removed: $(echo "$RESULT" | tail -c 500 | sed 's/"/\\"/g')\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1
  exit 1
fi

osascript -e 'display dialog "PrintBridge has been removed." buttons {"OK"} default button 1 with icon note' >/dev/null 2>&1
exit 0
