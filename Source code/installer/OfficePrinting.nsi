; PrintBridge (internally "Office Printing") - the one Setup for every computer.
; Print from any computer to any printer in the office.
; By @devnithdev (the coffee cup mark, shown on every page of Setup).
;
; Run the same PrintBridgeSetup.exe on the main computer, on every
; computer with a printer, and on any other computer that should print from
; Excel, Word and other programs. It asks one question (what does this
; computer do?), replaces any older version it finds - including one
; installed under an earlier name, or a half-finished one - and takes over cleanly,
; adds the "PrintBridge" printer, and starts printing.
;
; Build (on Linux):  makensis -V2 OfficePrinting.nsi
; Needs, next to this file:  ..\desktop\dist\OfficePrinting.exe,
;   ..\agent\tools\SumatraPDF.exe, SumatraPDF-LICENCE.txt,
;   office-printing.ico, side.bmp, README.txt
;
; Silent install, for anyone setting up many computers:
;   PrintBridgeSetup.exe /S /ROLE=main|printer|client /NAME="Front desk"
;                        /SERVER=192.168.1.20 /LIBREOFFICE=0|1
;                        /KEEPAWAKE=0|1 /LIDACTION=0|1|3 /BATACTION=0|1|2|3
;                        /TAKEOVER=1  (main computer: make it the only one -
;                        every other main computer switches over to it)
;                        /FIXADDRESS=1 or /FIXADDRESS=192.168.1.200
;                        (main computer: give it a fixed network address -
;                        1 = a free one Setup picks; see desktop/lib/fixip.js)
;   PrintBridgeSetup.exe /S /UPDATE=1
;                        an automatic update (see desktop/lib/updater.js):
;                        keeps everything exactly as it is - role, name,
;                        address, power settings - and installs no
;                        LibreOffice; only the program is replaced
; An older version is always replaced in a silent install. /KEEPAWAKE,
; /LIDACTION and /BATACTION only matter on the main computer (a printer
; computer always keeps the recommended choices); see the "how should this
; computer behave?" page for what each value means.
;
; Silent uninstall removes everything; add /KEEPDATA to keep the saved
; list of printers and computers, and /KEEPLIBREOFFICE to leave LibreOffice
; installed even if this Setup put it there:
;   "C:\Program Files\Office Printing\Uninstall Office Printing.exe" /S [/KEEPDATA] [/KEEPLIBREOFFICE]

Unicode true
ManifestDPIAware true
RequestExecutionLevel admin
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!define APP "Office Printing"     ; internal name: folders, Run key, firewall rules (unchanged -
                                   ; this is what lets Setup always install itself over an older
                                   ; version, whatever brand name that version used, as an update)
!define BRAND "PrintBridge"        ; name people see: Setup, shortcuts, Settings > Apps
!define TAGLINE "Print from any computer to any printer in the office."
!define COMPANY "Devnith AE"
!define CREDIT "${U+2615} by @devnithdev"
!define VERSION "4.2.5"
!define EXE "OfficePrinting.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OfficePrinting"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"

!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!include x64.nsh
!include FileFunc.nsh
!include WinMessages.nsh

Name "${BRAND}"
OutFile "dist\PrintBridgeSetup.exe"
InstallDir "$PROGRAMFILES64\${APP}"
BrandingText "${BRAND} ${VERSION}   ${CREDIT}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${BRAND}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "FileDescription" "${BRAND} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 ${COMPANY}"

; --- what the person chose, and what Setup found -----------------------------

Var Role            ; main | printer | client
Var PcName          ; name shown next to this computer's printers
Var ServerTyped     ; address typed by hand (printer computers only)
Var WantLO          ; 1 = also install LibreOffice
Var HasLO           ; 1 = LibreOffice already installed
Var OldFound
Var OldWhere
Var OldWebsite
Var OldComputers
Var OldPrinter
Var OldName
Var Replace         ; 1 = replace the older version
Var FoundCount
Var FoundAddress
Var FoundId
Var WasConfigured
Var PrevRole        ; what this computer was, if Setup ran here before
Var PrevBrand       ; the brand name an earlier install here used, if it differs from now
Var FinishText
Var FinishLink
Var FreshInstall   ; 1 = first install on this computer: Setup leaves it for the person to start (or not) on the last page
Var TakeOver       ; 1 = make this the only main computer (others on the network switch over to it)
Var OldMainCount   ; main computers found that are too old to switch themselves off
Var ClaimedBy      ; the name of a main computer already set as the only one, if any
Var MainList       ; the main computers found, one per line, for the page below
Var hTakeOver
Var hTakeIntro
Var hTakeList
Var Update         ; 1 = an automatic update (/UPDATE=1): change nothing but the program
Var FixAddr        ; 1 = give this computer a fixed network address (main computer)
Var FixAddress     ; that address (empty = let the program pick a free one)
Var NetChecked     ; 1 = the network has been looked at (once, when the page is first shown)
Var NetFound
Var NetWifi
Var NetAddress
Var NetDhcp
Var NetOurs        ; 1 = the current fixed address is one Setup set
Var hFix
Var hFixAddr

; how the main computer should behave; a printer computer always gets the
; recommended values below without asking (see PowerPageShow)
Var KeepAwake       ; 1 = never sleep while switched on (recommended)
Var LidAction       ; 0 do nothing (recommended) | 1 sleep | 3 shut down
Var BattAction      ; 3 shut down (recommended) | 2 hibernate | 1 sleep | 0 do nothing

; page controls
Var hReplace
Var hKeep
Var hMain
Var hPrinter
Var hClient
Var hNameLabel
Var hName
Var hServer
Var hServerLabel
Var hFoundLabel     ; the line under "shares a printer" (says whether the main computer was found)
Var hSearch         ; the "Find again" button
Var hLO
Var hKeepAwake
Var hLidAction
Var hBattAction
Var KeepData        ; uninstall: 1 = keep the saved information
Var hKeepData
Var LOBySetup       ; uninstall: 1 = this Setup was the one that installed LibreOffice
Var KeepLO          ; uninstall: 1 = keep LibreOffice instead of removing it
Var hKeepLO

; --- look and pages ----------------------------------------------------------

!define MUI_ICON "office-printing.ico"
!define MUI_UNICON "office-printing.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "side.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "side.bmp"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Stop setting up ${BRAND}? Nothing has been changed yet."

!define MUI_WELCOMEPAGE_TITLE "Set up ${BRAND}"
!define MUI_WELCOMEPAGE_TEXT "${TAGLINE}$\r$\n$\r$\nThis sets up ${BRAND} on this computer, so everyone in the office can print from their own phone or computer. Nobody needs an app or an account.$\r$\n$\r$\nRun this same Setup on every computer that has a printer, and on any other computer that should print from Excel, Word and other programs. Start with the main computer: the one that stays on during office hours.$\r$\n$\r$\nIt takes about a minute. Click Next to begin.$\r$\n$\r$\n${BRAND}  -  ${CREDIT}"
!insertmacro MUI_PAGE_WELCOME
Page custom OldPageShow OldPageLeave
Page custom RolePageShow RolePageLeave
Page custom TakeOverPageShow TakeOverPageLeave
Page custom AddressPageShow AddressPageLeave
Page custom PowerPageShow PowerPageLeave
!define MUI_PAGE_CUSTOMFUNCTION_SHOW InstPageShow
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "${BRAND} is installed"
!define MUI_FINISHPAGE_TEXT "$FinishText"
!define MUI_FINISHPAGE_TEXT_LARGE
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "$FinishLink"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenAfterSetup
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishPageShow
!insertmacro MUI_PAGE_FINISH

UninstPage custom un.ConfirmShow un.ConfirmLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; --- helpers -----------------------------------------------------------------

; Runs OfficePrinting.exe with the given arguments, output to the details list.
!macro OP ARGS
  nsExec::ExecToLog '"$INSTDIR\${EXE}" ${ARGS}'
  Pop $0
!macroend

; Runs a Windows command quietly (nothing shown), ignoring its result.
!macro QUIET CMD
  nsExec::Exec `${CMD}`
  Pop $0
!macroend

; --- before any page: look at this computer -------------------------------------

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "${BRAND} needs 64-bit Windows 10 or 11." /SD IDOK
    ; A silent install has nobody to read that, so the exit code is how it
    ; says so: without this, a script installing onto a hundred computers
    ; records every failure as a success.
    SetErrorLevel 2
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
  InitPluginsDir

  StrCpy $Replace "1"
  StrCpy $WantLO "1"
  StrCpy $TakeOver "0"
  StrCpy $Update "0"
  StrCpy $FixAddr "0"
  StrCpy $FixAddress ""
  StrCpy $NetChecked "0"
  StrCpy $NetOurs "0"
  StrCpy $ServerTyped ""
  ; Recommended power behaviour, used as-is on a printer computer and
  ; offered as choices (with these as the recommended picks) on the main
  ; computer - see PowerPageShow.
  StrCpy $KeepAwake "1"
  StrCpy $LidAction "0"
  StrCpy $BattAction "3"

  ; A copy of the program, to look around with before anything is installed.
  SetOutPath "$PLUGINSDIR"
  File "/oname=$PLUGINSDIR\op.exe" "..\desktop\dist\${EXE}"

  ${IfNot} ${Silent}
    Banner::show "Checking this computer - this takes a few seconds..."
  ${EndIf}
  nsExec::Exec /TIMEOUT=180000 '"$PLUGINSDIR\op.exe" status "$PLUGINSDIR\status.ini"'
  Pop $0
  nsExec::Exec /TIMEOUT=180000 '"$PLUGINSDIR\op.exe" detect-old "$PLUGINSDIR\old.ini"'
  Pop $0
  ; An automatic update (/UPDATE=1) keeps this computer connected exactly as
  ; it is, so it doesn't look for the main computer (which could point it at
  ; a different one).
  ${GetParameters} $R0
  Call SplitArgs
  StrCpy $R1 "/UPDATE="
  Call GetOpt
  ${IfNot} ${Errors}
  ${AndIf} $R1 == "1"
    StrCpy $Update "1"
  ${EndIf}
  ${If} $Update != "1"
    Call RunFindServer
  ${EndIf}
  ${IfNot} ${Silent}
    Banner::destroy
  ${EndIf}

  ; If the checks couldn't run, the answers below would be guesses - and a
  ; wrong guess could make this a second main computer. This almost always
  ; means security software stopped the program.
  ${IfNot} ${FileExists} "$PLUGINSDIR\status.ini"
  ${OrIfNot} ${FileExists} "$PLUGINSDIR\old.ini"
    MessageBox MB_OK|MB_ICONSTOP "Setup couldn't check this computer, so nothing has been changed.$\r$\n$\r$\nThis is usually antivirus or other security software stopping ${BRAND} from running. Ask whoever looks after this computer to allow PrintBridgeSetup.exe, then run Setup again." /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}

  ReadINIStr $WasConfigured "$PLUGINSDIR\status.ini" "status" "configured"
  ReadINIStr $Role "$PLUGINSDIR\status.ini" "status" "role"
  StrCpy $PrevRole ""
  ${If} $WasConfigured == "1"
    StrCpy $PrevRole $Role
  ${EndIf}
  ReadINIStr $PcName "$PLUGINSDIR\status.ini" "status" "name"
  ; The main computer's address typed in last time is kept when Setup is run
  ; again (an update), instead of the box coming up empty and the address
  ; being forgotten.
  ${If} $WasConfigured == "1"
    ReadINIStr $ServerTyped "$PLUGINSDIR\status.ini" "status" "server"
  ${EndIf}
  ReadINIStr $HasLO "$PLUGINSDIR\status.ini" "status" "libreoffice"
  ReadINIStr $OldFound "$PLUGINSDIR\old.ini" "old" "found"
  ReadINIStr $OldWhere "$PLUGINSDIR\old.ini" "old" "where"
  ReadINIStr $OldWebsite "$PLUGINSDIR\old.ini" "old" "website"
  ReadINIStr $OldComputers "$PLUGINSDIR\old.ini" "old" "computers"
  ReadINIStr $OldPrinter "$PLUGINSDIR\old.ini" "old" "printer"
  ReadINIStr $OldName "$PLUGINSDIR\old.ini" "old" "name"
  ; A first install: nothing set up here before and no older version found.
  ; Then nothing needs to be started for anyone's sake, so the last page asks.
  ; (An update or a replaced older version is started straight away, as
  ; before, so a working office is never left stopped.)
  StrCpy $FreshInstall "0"
  ${If} $WasConfigured != "1"
  ${AndIf} $OldFound != "1"
    StrCpy $FreshInstall "1"
  ${EndIf}
  ; A silent install (a script, IT) has nobody to answer the last page, so it
  ; starts everything itself, as it always did.
  ${If} ${Silent}
    StrCpy $FreshInstall "0"
  ${EndIf}
  ReadINIStr $FoundCount "$PLUGINSDIR\found.ini" "found" "count"
  ReadINIStr $FoundAddress "$PLUGINSDIR\found.ini" "found" "address"
  ReadINIStr $FoundId "$PLUGINSDIR\found.ini" "found" "id"
  ; A brand name an earlier install here used, only set when it differs from
  ; this one - so Setup can clean up that earlier brand's shortcuts and take
  ; over from it (a plain update, or an earlier half-finished setup, or an
  ; install under an earlier name all look the same here).
  ReadINIStr $PrevBrand "$PLUGINSDIR\status.ini" "status" "prevbrand"
  ; Installs from before the name was recorded: the name Settings > Apps
  ; shows for the earlier install is the name its shortcuts were made under.
  ; (Only administrators can change that entry, so it is safe to use.)
  ${If} $PrevBrand == ""
    ReadRegStr $0 HKLM "${UNINSTKEY}" "DisplayName"
    ${If} $0 != ""
    ${AndIf} $0 != "${BRAND}"
      StrCpy $PrevBrand $0
    ${EndIf}
  ${EndIf}

  ; The most likely answer to "what does this computer do?":
  ;   set up before       -> the same as last time
  ;   old version found   -> whatever the old version did
  ;   main computer found -> this one shares a printer
  ;   nothing found       -> this is probably the main computer
  ${If} $WasConfigured != "1"
    ${If} $OldWebsite == "1"
      StrCpy $Role "main"
    ${ElseIf} $OldPrinter == "1"
      StrCpy $Role "printer"
    ${ElseIf} $FoundCount != ""
    ${AndIf} $FoundCount != "0"
      StrCpy $Role "printer"
    ${Else}
      StrCpy $Role "main"
    ${EndIf}
    ${If} $OldName != ""
      StrCpy $PcName $OldName
    ${EndIf}
  ${EndIf}

  ; Silent install: take any choices given on the command line.
  ; Written either way round - /NAME="Front desk" or "/NAME=Front desk" -
  ; and an address keeps its slashes, so /SERVER=http://192.168.1.20:3000
  ; arrives whole. SplitArgs deals with the quoting once; GetOpt then reads
  ; one option out of the result.
  ${GetParameters} $R0
  Call SplitArgs
  StrCpy $R1 "/ROLE="
  Call GetOpt
  ${IfNot} ${Errors}
    StrCpy $Role $R1
  ${EndIf}
  StrCpy $R1 "/NAME="
  Call GetOpt
  ${IfNot} ${Errors}
    StrCpy $PcName $R1
  ${EndIf}
  StrCpy $R1 "/SERVER="
  Call GetOpt
  ${IfNot} ${Errors}
    StrCpy $ServerTyped $R1
  ${EndIf}
  StrCpy $R1 "/LIBREOFFICE="
  Call GetOpt
  ${IfNot} ${Errors}
    StrCpy $WantLO $R1
  ${EndIf}
  StrCpy $R1 "/KEEPAWAKE="
  Call GetOpt
  ${IfNot} ${Errors}
    StrCpy $KeepAwake $R1
  ${EndIf}
  StrCpy $R1 "/LIDACTION="
  Call GetOpt
  ${IfNot} ${Errors}
    StrCpy $LidAction $R1
  ${EndIf}
  StrCpy $R1 "/BATACTION="
  Call GetOpt
  ${IfNot} ${Errors}
    StrCpy $BattAction $R1
  ${EndIf}
  ; /TAKEOVER=1 - make this the only main computer (main computer only).
  StrCpy $R1 "/TAKEOVER="
  Call GetOpt
  ${IfNot} ${Errors}
    StrCpy $TakeOver $R1
  ${EndIf}
  ${If} $TakeOver != "1"
    StrCpy $TakeOver "0"
  ${EndIf}
  ; /FIXADDRESS=1 (a free address Setup picks) or /FIXADDRESS=192.168.1.200.
  StrCpy $R1 "/FIXADDRESS="
  Call GetOpt
  ${IfNot} ${Errors}
  ${AndIf} $R1 != ""
  ${AndIf} $R1 != "0"
    StrCpy $FixAddr "1"
    ${If} $R1 != "1"
      StrCpy $FixAddress $R1
    ${EndIf}
  ${EndIf}
  ; NSIS compares without regard to case but the program doesn't, so
  ; /ROLE=MAIN is rewritten to exactly "main" - otherwise Setup would treat
  ; this as the main computer while the program saved it as a printer one.
  ${If} $Role == "main"
    StrCpy $Role "main"
  ${ElseIf} $Role == "client"
    StrCpy $Role "client"
  ${Else}
    StrCpy $Role "printer"
  ${EndIf}
  ; A value that isn't one of the numbers powercfg accepts would be passed
  ; straight to it and quietly do nothing, so anything else falls back to
  ; the recommended setting rather than leaving the computer half-set.
  ${If} $KeepAwake != "0"
    StrCpy $KeepAwake "1"
  ${EndIf}
  ${If} $LidAction != "1"
  ${AndIf} $LidAction != "2"
  ${AndIf} $LidAction != "3"
    StrCpy $LidAction "0"
  ${EndIf}
  ${If} $BattAction != "0"
  ${AndIf} $BattAction != "1"
  ${AndIf} $BattAction != "2"
    StrCpy $BattAction "3"
  ${EndIf}
  ; Only the main computer is ever asked about sleep and the lid; every
  ; other computer keeps the recommended behaviour, exactly as the wizard
  ; enforces in RolePageLeave. Without this, a silent install could hand a
  ; printer computer /LIDACTION=1 and it would go to sleep when its lid
  ; closed, taking its printers off the office's printing page.
  ${If} $Role != "main"
    StrCpy $KeepAwake "1"
    StrCpy $LidAction "0"
    StrCpy $BattAction "3"
  ${EndIf}
FunctionEnd

; Splits the command line into its arguments, honouring quotes, and leaves
; them in $R9 with one argument to a line. The quotes themselves are taken
; off, so "/NAME=Front desk" and /NAME="Front desk" both come out as the
; single argument /NAME=Front desk. Input in $R0. Uses $R2-$R7.
Function SplitArgs
  StrCpy $R9 ""    ; the arguments, one to a line
  StrCpy $R3 ""    ; the argument being built up
  StrCpy $R4 0     ; where we are in the command line
  StrCpy $R5 0     ; 1 = inside quotes
  StrCpy $R6 0     ; 1 = an argument is being built
  StrLen $R7 $R0
  split_loop:
    IntCmp $R4 $R7 split_done 0 split_done
    StrCpy $R2 $R0 1 $R4
    ${If} $R2 == '"'
      ${If} $R5 == 1
        StrCpy $R5 0
      ${Else}
        StrCpy $R5 1
      ${EndIf}
      StrCpy $R6 1
    ${ElseIf} $R2 == " "
    ${AndIf} $R5 == 0
      ${If} $R6 == 1
        StrCpy $R9 "$R9$R3$\n"
        StrCpy $R3 ""
        StrCpy $R6 0
      ${EndIf}
    ${Else}
      StrCpy $R3 "$R3$R2"
      StrCpy $R6 1
    ${EndIf}
    IntOp $R4 $R4 + 1
    Goto split_loop
  split_done:
  ${If} $R6 == 1
    StrCpy $R9 "$R9$R3$\n"
  ${EndIf}
FunctionEnd

; Reads one option out of the arguments SplitArgs left in $R9.
;   in  $R1  the switch, e.g. "/ROLE=" (capitals don't matter)
;   out $R1  its value, with the error flag set if it wasn't given at all
; A value runs on into the arguments after it until one that begins with a
; "/", so /NAME=Front desk still gives "Front desk" without quotes, while
; /ROLE=main /NAME=x keeps the two apart. An address keeps its slashes,
; since only an argument of its own can end the value. Uses $R2-$R8.
Function GetOpt
  StrCpy $R7 $R1     ; the switch being looked for
  StrLen $R8 $R7
  StrCpy $R2 ""      ; the value so far
  StrCpy $R6 0       ; 1 = the switch has been found
  StrCpy $R3 $R9     ; the arguments still to look at
  getopt_next:
    StrCmp $R3 "" getopt_done
    StrCpy $R4 ""    ; this argument
    getopt_char:
      StrCpy $R5 $R3 1
      StrCmp $R5 "" getopt_have
      StrCmp $R5 "$\n" getopt_have
      StrCpy $R4 "$R4$R5"
      StrCpy $R3 $R3 "" 1
      Goto getopt_char
    getopt_have:
    StrCpy $R3 $R3 "" 1
    ${If} $R6 == 1
      StrCpy $R5 $R4 1
      StrCmp $R5 "/" getopt_done
      StrCpy $R2 "$R2 $R4"
    ${Else}
      StrCpy $R5 $R4 $R8
      ${If} $R5 == $R7
        StrCpy $R2 $R4 "" $R8
        StrCpy $R6 1
      ${EndIf}
    ${EndIf}
    Goto getopt_next
  getopt_done:
  ClearErrors
  ${If} $R6 == 1
    StrCpy $R1 $R2
  ${Else}
    StrCpy $R1 ""
    SetErrors
  ${EndIf}
FunctionEnd

; --- page: an older version was found ---------------------------------------

Function OldPageShow
  ${If} $OldFound != "1"
    Abort ; nothing older here - skip this page
  ${EndIf}
  ; Not "${BRAND} was set up here before": what this page finds is the
  ; original .bat-file setup, which never carried this name.
  !insertmacro MUI_HEADER_TEXT "An older version was found" "This computer was already set up for office printing, the old way."

  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 10u "An older setup (from before ${BRAND}) is on this computer, here:"
  Pop $0
  ${NSD_CreateLabel} 12u 11u -12u 12u "$OldWhere"
  Pop $0
  CreateFont $1 "Segoe UI" 9 700
  SendMessage $0 ${WM_SETFONT} $1 0

  StrCpy $2 "Setup will replace it with this new version:"
  ${If} $OldWebsite == "1"
    StrCpy $2 "$2$\r$\n  -  Its list of printers and computers is kept, so it doesn't need setting up again - as long as this stays the main computer, which you choose on the next page."
  ${EndIf}
  ${If} $OldPrinter == "1"
    StrCpy $2 "$2$\r$\n  -  It keeps the name $\"$OldName$\" and carries on sharing its printers, unless you choose otherwise on the next page."
  ${EndIf}
  StrCpy $2 "$2$\r$\n  -  The old version is switched off. Its folder is left where it is, with a note inside saying it can be deleted."
  StrCpy $2 "$2$\r$\n  -  Other computers keep working as they are. Update them with this same Setup whenever it suits you."
  ${NSD_CreateLabel} 0 27u 100% 66u "$2"
  Pop $0

  ${NSD_CreateRadioButton} 0 97u 100% 12u "&Replace the older version (recommended)"
  Pop $hReplace
  ${NSD_CreateRadioButton} 0 111u 100% 12u "&Don't replace it - close Setup and change nothing"
  Pop $hKeep
  ${If} $Replace == "1"
    ${NSD_Check} $hReplace
  ${Else}
    ${NSD_Check} $hKeep
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function OldPageLeave
  ${NSD_GetState} $hReplace $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Replace "1"
  ${Else}
    StrCpy $Replace "0"
    MessageBox MB_OK|MB_ICONINFORMATION "Nothing was changed. The older version keeps running as before.$\r$\n$\r$\n(Running the old and the new version side by side is not possible: they would both try to print everything.)" /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
FunctionEnd

; --- looking for the main computer ----------------------------------------------
;
; Runs the program's own search (op.exe find-server) and reads what it found into
; $FoundCount / $FoundAddress / $FoundId.
;
; Windows Firewall drops the main computer's answer to the "where are you?"
; question for any program that has no allow rule, and this temporary copy of the
; program is brand new, so it has none (and nobody is there to click "Allow" on a
; pop-up that never appears). That is why the search so often found nothing. So
; the copy is given an allow rule for the length of the search, then loses it.
Function RunFindServer
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP} (Setup search)"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${APP} (Setup search)" dir=in action=allow program="$PLUGINSDIR\op.exe" enable=yes profile=any'
  Pop $0
  Delete "$PLUGINSDIR\found.ini"
  nsExec::Exec /TIMEOUT=180000 '"$PLUGINSDIR\op.exe" find-server "$PLUGINSDIR\found.ini"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP} (Setup search)"'
  Pop $0
  ReadINIStr $FoundCount "$PLUGINSDIR\found.ini" "found" "count"
  ReadINIStr $FoundAddress "$PLUGINSDIR\found.ini" "found" "address"
  ReadINIStr $FoundId "$PLUGINSDIR\found.ini" "found" "id"
  ReadINIStr $OldMainCount "$PLUGINSDIR\found.ini" "found" "oldcount"
  ReadINIStr $ClaimedBy "$PLUGINSDIR\found.ini" "found" "claimedby"
  ${If} $OldMainCount == ""
    StrCpy $OldMainCount "0"
  ${EndIf}
  ; One line per main computer found (main1..main8, then "and N more").
  StrCpy $MainList ""
  StrCpy $R0 1
  ${Do}
    ReadINIStr $R1 "$PLUGINSDIR\found.ini" "found" "main$R0"
    ${If} $R1 == ""
      ${Break}
    ${EndIf}
    ${If} $MainList == ""
      StrCpy $MainList "$R1"
    ${Else}
      StrCpy $MainList "$MainList$\r$\n$R1"
    ${EndIf}
    IntOp $R0 $R0 + 1
  ${LoopUntil} $R0 > 8
  ReadINIStr $R1 "$PLUGINSDIR\found.ini" "found" "more"
  ${If} $R1 != ""
  ${AndIf} $R1 != "0"
    StrCpy $MainList "$MainList$\r$\n  -  and $R1 more"
  ${EndIf}
FunctionEnd

; The "Find again" button: look for the main computer once more, without
; leaving this page (or starting Setup over).
Function SearchAgain
  Pop $0
  Banner::show "Looking for the main computer on this network - this takes a few seconds..."
  Call RunFindServer
  Banner::destroy
  ${If} $FoundCount != ""
  ${AndIf} $FoundCount != "0"
    ${NSD_SetText} $hFoundLabel "The main computer was found on this network ($FoundAddress). The printer on this computer will be shared through it."
  ${Else}
    ${NSD_SetText} $hFoundLabel "The main computer wasn't found. Check that it is switched on and on the same Wi-Fi or network, then press Find again - or type its address below."
  ${EndIf}
FunctionEnd

; --- page: what does this computer do? -----------------------------------------

Function RolePageShow
  !insertmacro MUI_HEADER_TEXT "What does this computer do?" "Choose one. You can change it later by running Setup again."

  nsDialogs::Create 1018
  Pop $0
  CreateFont $1 "Segoe UI" 9 700

  ${NSD_CreateRadioButton} 0 0 100% 11u "This is the &main computer"
  Pop $hMain
  SendMessage $hMain ${WM_SETFONT} $1 0
  ${NSD_OnClick} $hMain RoleChanged
  ${NSD_CreateLabel} 12u 11u -12u 17u "Runs the printing page everyone opens. Choose this on ONE computer only, one that stays on during office hours. Its printers are shared too."
  Pop $0

  ${NSD_CreateRadioButton} 0 30u 100% 11u "This computer &shares a printer"
  Pop $hPrinter
  SendMessage $hPrinter ${WM_SETFONT} $1 0
  ${NSD_OnClick} $hPrinter RoleChanged
  ${If} $FoundCount != ""
  ${AndIf} $FoundCount != "0"
    StrCpy $2 "The main computer was found on this network ($FoundAddress). The printer on this computer will be shared through it."
  ${Else}
    StrCpy $2 "A printer is plugged into (or installed on) this computer. The main computer must already be set up; this one finds it by itself."
  ${EndIf}
  ${NSD_CreateLabel} 12u 41u -12u 17u "$2"
  Pop $hFoundLabel

  ${NSD_CreateRadioButton} 0 60u 100% 11u "This computer &only prints"
  Pop $hClient
  SendMessage $hClient ${WM_SETFONT} $1 0
  ${NSD_OnClick} $hClient RoleChanged
  ${NSD_CreateLabel} 12u 71u -12u 17u "No printer here. People using this computer print to the office printers, from Excel, Word and any other program. It still goes to sleep as usual."
  Pop $0

  ${NSD_CreateLabel} 0 91u 100% 10u "&Name for this computer (people see it next to its printers, e.g. Front desk):"
  Pop $hNameLabel
  ${NSD_CreateText} 0 101u 60% 13u "$PcName"
  Pop $hName
  SendMessage $hName ${EM_LIMITTEXT} 60 0

  ${NSD_CreateLabel} 0 117u 100% 10u "Main computer's &address, only if it isn't found by itself (it's on the wall sign):"
  Pop $hServerLabel
  ${NSD_CreateText} 0 127u 60% 13u "$ServerTyped"
  Pop $hServer
  SendMessage $hServer ${EM_LIMITTEXT} 200 0

  ; Looks for the main computer again, so a search that missed it (a busy
  ; network, Wi-Fi still waking up) can simply be repeated.
  ${NSD_CreateButton} 62% 126u 38% 14u "&Find again"
  Pop $hSearch
  ${NSD_OnClick} $hSearch SearchAgain

  ${NSD_CreateCheckbox} 0 117u 100% 22u "Also install &LibreOffice (free), so Word, Excel and PowerPoint files and photos can be printed. It downloads about 350 MB and can take a while."
  Pop $hLO
  ${If} $WantLO == "1"
    ${NSD_Check} $hLO
  ${EndIf}

  ${If} $Role == "main"
    ${NSD_Check} $hMain
  ${ElseIf} $Role == "client"
    ${NSD_Check} $hClient
  ${Else}
    ${NSD_Check} $hPrinter
  ${EndIf}
  Call RoleChanged

  nsDialogs::Show
FunctionEnd

; Main computer: name and LibreOffice box (only if LibreOffice isn't there
; already). Printer computer: name and address box. Only prints: address.
Function RoleChanged
  Pop $0 ; the control that was clicked (or nothing, when called directly)
  ${NSD_GetState} $hMain $0
  ${NSD_GetState} $hClient $1
  ${If} $0 == ${BST_CHECKED}
    ShowWindow $hServerLabel ${SW_HIDE}
    ShowWindow $hServer ${SW_HIDE}
    ShowWindow $hSearch ${SW_HIDE}
    ${If} $HasLO == "1"
      ShowWindow $hLO ${SW_HIDE}
    ${Else}
      ShowWindow $hLO ${SW_SHOW}
    ${EndIf}
  ${Else}
    ShowWindow $hServerLabel ${SW_SHOW}
    ShowWindow $hServer ${SW_SHOW}
    ShowWindow $hSearch ${SW_SHOW}
    ShowWindow $hLO ${SW_HIDE}
  ${EndIf}
  ${If} $1 == ${BST_CHECKED}
    ShowWindow $hNameLabel ${SW_HIDE}
    ShowWindow $hName ${SW_HIDE}
  ${Else}
    ShowWindow $hNameLabel ${SW_SHOW}
    ShowWindow $hName ${SW_SHOW}
  ${EndIf}
FunctionEnd

Function RolePageLeave
  ${NSD_GetState} $hMain $0
  ${NSD_GetState} $hClient $1
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Role "main"
  ${ElseIf} $1 == ${BST_CHECKED}
    StrCpy $Role "client"
  ${Else}
    StrCpy $Role "printer"
  ${EndIf}
  ${NSD_GetText} $hName $PcName
  ${NSD_GetText} $hServer $ServerTyped
  ${NSD_GetState} $hLO $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $WantLO "1"
  ${Else}
    StrCpy $WantLO "0"
  ${EndIf}

  ; A printer or client computer always gets the recommended power
  ; behaviour and is never asked (PowerPageShow skips it for them) - so if
  ; someone picked "main", set custom choices on the next page, then came
  ; back and switched away from "main", make sure those custom choices
  ; don't quietly carry over to the printer/client computer.
  ${If} $Role != "main"
    StrCpy $KeepAwake "1"
    StrCpy $LidAction "0"
    StrCpy $BattAction "3"
  ${EndIf}

  ${If} $PcName == ""
  ${AndIf} $Role != "client"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Please type a name for this computer, such as $\"Front desk$\" or $\"Accounts$\"."
    Abort
  ${EndIf}

  ; (Another main computer on the network is dealt with on the next page,
  ; where this one can also be made the only main computer.)

  ${If} $Role != "main"
    ${If} $OldWebsite == "1"
    ${OrIf} $PrevRole == "main"
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "This computer runs the printing page for the office.$\r$\n$\r$\nIf it isn't the main computer from now on, printing stops for everyone until another computer is set up as the main computer.$\r$\n$\r$\nContinue anyway?" IDYES +2
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; --- page: make this the only main computer? ----------------------------------
;
; Shown whenever this computer is to be the main computer - a first install,
; one replacing an older version, or Setup run again. Ticked, every other main
; computer on the network - now, or the next time it is switched on - stops
; running its printing page and shares its printers through this one (see
; watchForTakeover in server.js and applyStepDown in supervisor.js). Nothing
; is uninstalled or deleted there.

Function TakeOverPageShow
  ${If} $Role != "main"
    Abort ; not the main computer - nothing to ask
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Other main computers" "Make this the only main computer on this network?"

  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 26u ""
  Pop $hTakeIntro
  ${NSD_CreateLabel} 0 27u 100% 38u ""
  Pop $hTakeList
  Call ShowMainList

  ${NSD_CreateCheckbox} 0 67u 100% 20u "&Make this the only main computer: every other main computer on this network switches over to it."
  Pop $hTakeOver
  CreateFont $1 "Segoe UI" 9 700
  SendMessage $hTakeOver ${WM_SETFONT} $1 0
  ${If} $TakeOver == "1"
    ${NSD_Check} $hTakeOver
  ${EndIf}
  ${NSD_CreateLabel} 12u 88u -12u 36u "Within about a minute they stop running their own printing page and share their printers through this one (one that is off does so when next switched on). Nothing is deleted on them; Setup can make one the main computer again. Older versions can't do this - update or remove those by hand."
  Pop $0

  ${NSD_CreateButton} 0 125u 30% 14u "&Look again"
  Pop $0
  ${NSD_OnClick} $0 TakeOverLookAgain

  nsDialogs::Show
FunctionEnd

; Fills in the two labels at the top of the page from the last search.
Function ShowMainList
  ${If} $FoundCount != ""
  ${AndIf} $FoundCount != "0"
    ${If} $ClaimedBy != ""
      ${NSD_SetText} $hTakeIntro "These main computers are on this network. $\"$ClaimedBy$\" is set as the only main computer, so unless you tick the box below, THIS one switches itself off again within a minute:"
    ${Else}
      ${NSD_SetText} $hTakeIntro "These main computers are already on this network. With more than one, the office's printers are split between two printing pages:"
    ${EndIf}
    ${NSD_SetText} $hTakeList "$MainList"
  ${Else}
    ${NSD_SetText} $hTakeIntro "No other main computer answered just now. One that is switched off (or set up the old way) would still run its own printing page when it is switched back on."
    ${NSD_SetText} $hTakeList ""
  ${EndIf}
FunctionEnd

Function TakeOverLookAgain
  Pop $0
  Banner::show "Looking for main computers on this network - this takes a few seconds..."
  Call RunFindServer
  Banner::destroy
  Call ShowMainList
FunctionEnd

Function TakeOverPageLeave
  ${NSD_GetState} $hTakeOver $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $TakeOver "1"
  ${Else}
    StrCpy $TakeOver "0"
  ${EndIf}

  ${If} $TakeOver == "0"
  ${AndIf} $FoundCount != ""
  ${AndIf} $FoundCount != "0"
    ${If} $ClaimedBy != ""
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "$\"$ClaimedBy$\" is set as the only main computer on this network, so this one would switch itself off again within a minute of starting.$\r$\n$\r$\nMake THIS the only main computer instead?" IDNO +3
      StrCpy $TakeOver "1"
      Goto takeover_checked
      Abort
    ${Else}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Another computer on this network is already the main computer ($FoundAddress).$\r$\n$\r$\nWith two main computers, the office's printers would be split between two printing pages. Ticking $\"Make this the only main computer$\" avoids that.$\r$\n$\r$\nKeep both main computers anyway?" IDYES +2
      Abort
    ${EndIf}
  ${EndIf}
  takeover_checked:

  ${If} $TakeOver == "1"
  ${AndIf} $OldMainCount != "0"
    MessageBox MB_OK|MB_ICONINFORMATION "$OldMainCount of the main computers found run an older version of ${BRAND}, which can't switch itself off.$\r$\n$\r$\nAfterwards, run this Setup on each of them and choose $\"This computer shares a printer$\" (or uninstall ${BRAND} there)." /SD IDOK
  ${EndIf}
FunctionEnd

; --- page: how should the main computer behave? ------------------------------
;
; Only the main computer asks: it's the one that must stay reachable. A
; printer or client computer just gets the recommended values above, with
; no extra page (a printer computer still needs to stay awake; a computer
; that only prints sleeps as usual - see the Section below).

; --- "keep this computer's address the same" (main computer) -------------------
; A fixed network address set on this computer, so the wall sign's address
; keeps working after a power cut or a router restart. The program does the
; work and undoes it by itself if the network stops working with it (see
; desktop/lib/fixip.js).
Function AddressPageShow
  ${If} $Role != "main"
    Abort
  ${EndIf}
  ${If} $NetChecked != "1"
    Banner::show "Looking at this computer's network connection..."
    Delete "$PLUGINSDIR\net.ini"
    nsExec::Exec /TIMEOUT=120000 '"$PLUGINSDIR\op.exe" network-info "$PLUGINSDIR\net.ini"'
    Pop $0
    Banner::destroy
    StrCpy $NetChecked "1"
    ReadINIStr $NetFound "$PLUGINSDIR\net.ini" "net" "found"
    ReadINIStr $NetWifi "$PLUGINSDIR\net.ini" "net" "wifi"
    ReadINIStr $NetAddress "$PLUGINSDIR\net.ini" "net" "address"
    ReadINIStr $NetDhcp "$PLUGINSDIR\net.ini" "net" "dhcp"
    ReadINIStr $NetOurs "$PLUGINSDIR\net.ini" "net" "ours"
    ${If} $FixAddress == ""
      ReadINIStr $FixAddress "$PLUGINSDIR\net.ini" "net" "suggested"
    ${EndIf}
    ; Recommended (ticked) on a cable connection, and kept ticked if Setup
    ; fixed it before. On Wi-Fi it is left to the person: a laptop that
    ; moves between networks must not have one.
    ${If} $NetOurs == "1"
      StrCpy $FixAddr "1"
    ${ElseIf} $NetDhcp == "1"
    ${AndIf} $NetWifi != "1"
    ${AndIf} $FixAddress != ""
      StrCpy $FixAddr "1"
    ${EndIf}
  ${EndIf}
  ; Nothing to offer: no network, or an address someone already fixed by hand.
  ${If} $NetFound != "1"
    Abort
  ${EndIf}
  ${If} $NetDhcp != "1"
  ${AndIf} $NetOurs != "1"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Keep this computer's address the same?" "So the address on the wall sign keeps working after a power cut or a router restart."

  nsDialogs::Create 1018
  Pop $0
  CreateFont $1 "Segoe UI" 9 700

  ${If} $NetOurs == "1"
    ${NSD_CreateLabel} 0 0 100% 28u "This computer's address is fixed at $NetAddress (set by an earlier Setup). Untick the box to let the router choose it again."
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 28u "This computer's address is $NetAddress right now. The router chose it, and can give it a different one after a power cut or a router restart - then the wall sign's address stops working."
  ${EndIf}
  Pop $0

  ${NSD_CreateCheckbox} 0 30u 100% 12u "&Give this computer a fixed address (recommended for the main computer)"
  Pop $hFix
  SendMessage $hFix ${WM_SETFONT} $1 0
  ${If} $FixAddr == "1"
    ${NSD_Check} $hFix
  ${EndIf}
  ${NSD_OnClick} $hFix AddressToggle

  ${NSD_CreateLabel} 12u 47u 70u 10u "Fixed &address:"
  Pop $0
  ${NSD_CreateText} 85u 45u 40% 12u "$FixAddress"
  Pop $hFixAddr

  ${If} $NetWifi == "1"
    ${NSD_CreateLabel} 12u 63u -12u 70u "A free address high up on this network is suggested; change it if you have your own plan. If the network stops working with it, Setup changes it back to automatic by itself.$\r$\n$\r$\nThis computer is on Wi-Fi: only tick this if it stays in the office. The fixed address is used on every Wi-Fi network it joins, so a laptop taken elsewhere wouldn't connect there until it's set back to automatic.$\r$\n$\r$\nIf you can, also reserve this address in the router."
  ${Else}
    ${NSD_CreateLabel} 12u 63u -12u 60u "A free address high up on this network is suggested; change it if you have your own plan. If the network stops working with it, Setup changes it back to automatic by itself.$\r$\n$\r$\nThe router doesn't know about an address fixed here, so in rare cases it could give the same one to another device. If you can, also reserve this address in the router - that rules it out."
  ${EndIf}
  Pop $0

  Call AddressToggle
  nsDialogs::Show
FunctionEnd

Function AddressToggle
  ${NSD_GetState} $hFix $0
  ${If} $0 == ${BST_CHECKED}
    EnableWindow $hFixAddr 1
  ${Else}
    EnableWindow $hFixAddr 0
  ${EndIf}
FunctionEnd

Function AddressPageLeave
  ${NSD_GetState} $hFix $0
  ${NSD_GetText} $hFixAddr $FixAddress
  ${If} $0 == ${BST_CHECKED}
    StrCpy $FixAddr "1"
  ${Else}
    StrCpy $FixAddr "0"
  ${EndIf}
FunctionEnd

Function PowerPageShow
  ${IfNot} $Role == "main"
    Abort ; not the main computer - use the recommended values without asking
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "How should this computer behave?" "It runs the printing page, so people need it to stay reachable. The recommended choice is already picked for each."

  nsDialogs::Create 1018
  Pop $0
  CreateFont $1 "Segoe UI" 9 700

  ${NSD_CreateCheckbox} 0 0 100% 11u "&Keep this computer awake while it's switched on (recommended)"
  Pop $hKeepAwake
  SendMessage $hKeepAwake ${WM_SETFONT} $1 0
  ${If} $KeepAwake == "1"
    ${NSD_Check} $hKeepAwake
  ${EndIf}
  ${NSD_CreateLabel} 12u 11u -12u 17u "So printing keeps working while people are in the office. The screen still turns off after 10 minutes; this only stops the computer itself from sleeping."
  Pop $0

  ${NSD_CreateLabel} 0 32u 100% 10u "When the &lid is closed:"
  Pop $0
  ; A drop-down list ignores the text it is created with - each choice has
  ; to be added on its own, or the list is empty and nothing can be picked.
  ${NSD_CreateDropList} 0 42u 60% 80u ""
  Pop $hLidAction
  ${NSD_CB_AddString} $hLidAction "Do nothing (recommended)"
  ${NSD_CB_AddString} $hLidAction "Sleep"
  ${NSD_CB_AddString} $hLidAction "Shut down"
  ${NSD_CreateLabel} 0 57u 100% 17u "Choose $\"Do nothing$\" to keep printing with the lid down; a laptop people carry around is usually fine on $\"Sleep$\". The power button always shuts down cleanly."
  Pop $0

  ${NSD_CreateLabel} 0 80u 100% 10u "On critical &battery (about to run out):"
  Pop $0
  ${NSD_CreateDropList} 0 90u 60% 80u ""
  Pop $hBattAction
  ${NSD_CB_AddString} $hBattAction "Shut down safely (recommended)"
  ${NSD_CB_AddString} $hBattAction "Hibernate"
  ${NSD_CB_AddString} $hBattAction "Sleep"
  ${NSD_CB_AddString} $hBattAction "Do nothing"
  ${NSD_CreateLabel} 0 105u 100% 17u "Only matters on a laptop running on battery. Shutting down safely avoids losing anything if the battery runs all the way out."
  Pop $0

  ; Select the recommended (or previously chosen) item in each drop-down.
  StrCpy $2 0
  ${If} $LidAction == "1"
    StrCpy $2 1
  ${ElseIf} $LidAction == "3"
    StrCpy $2 2
  ${EndIf}
  SendMessage $hLidAction ${CB_SETCURSEL} $2 0

  StrCpy $2 0
  ${If} $BattAction == "2"
    StrCpy $2 1
  ${ElseIf} $BattAction == "1"
    StrCpy $2 2
  ${ElseIf} $BattAction == "0"
    StrCpy $2 3
  ${EndIf}
  SendMessage $hBattAction ${CB_SETCURSEL} $2 0

  nsDialogs::Show
FunctionEnd

Function PowerPageLeave
  ${NSD_GetState} $hKeepAwake $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $KeepAwake "1"
  ${Else}
    StrCpy $KeepAwake "0"
  ${EndIf}

  SendMessage $hLidAction ${CB_GETCURSEL} 0 0 $0
  ${If} $0 == 1
    StrCpy $LidAction "1"
  ${ElseIf} $0 == 2
    StrCpy $LidAction "3"
  ${Else}
    StrCpy $LidAction "0"
  ${EndIf}

  SendMessage $hBattAction ${CB_GETCURSEL} 0 0 $0
  ${If} $0 == 1
    StrCpy $BattAction "2"
  ${ElseIf} $0 == 2
    StrCpy $BattAction "1"
  ${ElseIf} $0 == 3
    StrCpy $BattAction "0"
  ${Else}
    StrCpy $BattAction "3"
  ${EndIf}
FunctionEnd

Function InstPageShow
  ; nothing extra; the details list shows each step in plain words
FunctionEnd

; --- installing -------------------------------------------------------------------

Section "${BRAND}" SecMain
  SetShellVarContext all
  SetRegView 64
  ${DisableX64FSRedirection}
  SetDetailsPrint both

  DetailPrint "Stopping ${BRAND} if it is already running..."
  ; The startup task first (added again further down): otherwise Task
  ; Scheduler would start the old program again while it is being replaced.
  !insertmacro QUIET '"$SYSDIR\schtasks.exe" /End /TN "${APP}"'
  !insertmacro QUIET '"$SYSDIR\schtasks.exe" /Delete /TN "${APP}" /F'
  !insertmacro QUIET '"$SYSDIR\taskkill.exe" /F /IM ${EXE}'
  Sleep 1500

  DetailPrint "Copying files..."
  SetDetailsPrint none
  SetOutPath "$INSTDIR"
  ; When updating, the old program file must be gone before the new one
  ; can take its place. Give Windows a few seconds to let go of it.
  StrCpy $R0 0
  ${Do}
    ClearErrors
    Delete "$INSTDIR\${EXE}"
    ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
      ${Break}
    ${EndIf}
    !insertmacro QUIET '"$SYSDIR\taskkill.exe" /F /IM ${EXE}'
    Sleep 2000
    IntOp $R0 $R0 + 1
  ${LoopUntil} $R0 >= 10
  ; Still there: Windows (or security software) wouldn't let go of the
  ; previous version. Copying over it would fail without a word and the
  ; OLD program would then be set up as if it were this one - so stop
  ; here, with the previous version left exactly as it was, and started
  ; again.
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    SetDetailsPrint both
    DetailPrint "PROBLEM: the previous version in $INSTDIR couldn't be replaced."
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\${EXE}"'
    MessageBox MB_OK|MB_ICONSTOP "Setup couldn't replace the ${BRAND} that is already on this computer, because Windows is still using it. Nothing has been changed, and the version already here keeps working.$\r$\n$\r$\nRestart the computer and run Setup again." /SD IDOK
    SetErrorLevel 4
    Abort
  ${EndIf}
  CopyFiles /SILENT "$PLUGINSDIR\op.exe" "$INSTDIR\${EXE}"
  File "..\agent\tools\SumatraPDF.exe"
  File "SumatraPDF-LICENCE.txt"
  File "office-printing.ico"
  File "README.txt"
  ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
    DetailPrint "PROBLEM: the program could not be copied into $INSTDIR."
    ; Nothing works without it, and the uninstaller isn't written until the
    ; end of this section - so the few files already copied are taken back
    ; out here, rather than being left in Program Files with no entry in
    ; Settings > Apps and no way to remove them.
    Delete "$INSTDIR\SumatraPDF.exe"
    Delete "$INSTDIR\SumatraPDF-LICENCE.txt"
    Delete "$INSTDIR\office-printing.ico"
    Delete "$INSTDIR\README.txt"
    RMDir "$INSTDIR"
    MessageBox MB_OK|MB_ICONSTOP "Setup could not copy ${BRAND} into $INSTDIR, so nothing has been installed.$\r$\n$\r$\nThis is usually security software, or the computer still using a copy from a previous version. Restart the computer and run Setup again." /SD IDOK
    SetErrorLevel 4
    Abort
  ${EndIf}

  ; Everyone who signs in to this computer runs ${BRAND}, so they
  ; all need to be able to save its settings and logs.
  CreateDirectory "$APPDATA\${APP}"
  SetDetailsPrint both
  !insertmacro QUIET '"$SYSDIR\icacls.exe" "$APPDATA\${APP}" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'

  ; Save this computer's choices (a UTF-16 file, so any name survives).
  FileOpen $9 "$PLUGINSDIR\choices.txt" w
  FileWriteWord $9 0xFEFF
  FileWriteUTF16LE $9 "role=$Role$\r$\n"
  FileWriteUTF16LE $9 "name=$PcName$\r$\n"
  FileWriteUTF16LE $9 "server=$ServerTyped$\r$\n"
  FileWriteUTF16LE $9 "foundid=$FoundId$\r$\n"
  ${If} $Role == "main"
    FileWriteUTF16LE $9 "takeover=$TakeOver$\r$\n"
  ${EndIf}
  FileClose $9
  !insertmacro OP 'configure "$PLUGINSDIR\choices.txt"'

  ; "Keep this computer's address the same" (main computer; never in an
  ; automatic update, which changes nothing). Done before anything starts,
  ; so the printing page comes up on the new address.
  ${If} $Role == "main"
  ${AndIf} $Update != "1"
    ${If} $FixAddr == "1"
      DetailPrint "Giving this computer a fixed network address (this can take half a minute)..."
      !insertmacro OP 'fix-address on "$FixAddress"'
    ${ElseIf} $NetOurs == "1"
      DetailPrint "Letting the router choose this computer's address again..."
      !insertmacro OP 'fix-address off'
    ${EndIf}
  ${EndIf}

  ${If} $OldFound == "1"
  ${AndIf} $Replace == "1"
    !insertmacro OP 'replace-old $Role'
  ${EndIf}

  ; An automatic update leaves the power settings exactly as they are (they
  ; may have been chosen by hand on this computer's "how should this
  ; computer behave?" page).
  ${If} $Update == "1"
    DetailPrint "Automatic update: keeping this computer's settings as they are."
    Goto power_done
  ${EndIf}
  ; A computer that only prints is someone's own computer: it sleeps as
  ; usual (and gets its own settings back if it used to share a printer).
  ${If} $Role == "client"
    SetDetailsPrint none
    !insertmacro OP 'restore-power'
    SetDetailsPrint both
    Goto power_done
  ${EndIf}
  SetDetailsPrint none
  !insertmacro OP 'save-power'
  SetDetailsPrint both
  ; $KeepAwake, $LidAction and $BattAction are the choices made on the "how
  ; should this computer behave?" page (main computer), or the recommended
  ; values set in .onInit and never asked about (printer computer).
  ${If} $KeepAwake == "1"
    DetailPrint "Keeping this computer awake (the screen still turns off after 10 minutes)..."
    !insertmacro QUIET '"$SYSDIR\powercfg.exe" /change standby-timeout-ac 0'
    !insertmacro QUIET '"$SYSDIR\powercfg.exe" /change standby-timeout-dc 0'
    !insertmacro QUIET '"$SYSDIR\powercfg.exe" /change hibernate-timeout-ac 0'
    !insertmacro QUIET '"$SYSDIR\powercfg.exe" /change hibernate-timeout-dc 0'
    ; Hibernation is only switched off when nothing chosen on this page
    ; needs it - otherwise "Hibernate" on critical battery (or with the lid
    ; closed) would silently do nothing at all.
    ${If} $BattAction != "2"
    ${AndIf} $LidAction != "2"
      !insertmacro QUIET '"$SYSDIR\powercfg.exe" /hibernate off'
    ${Else}
      ; ...and switched back on if an earlier Setup run turned it off.
      !insertmacro QUIET '"$SYSDIR\powercfg.exe" /hibernate on'
    ${EndIf}
    ; Windows Update may still install updates, but not restart the computer
    ; by itself while someone is signed in.
    WriteRegDWORD HKLM "SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" "NoAutoRebootWithLoggedOnUsers" 1
  ${Else}
    DetailPrint "Leaving this computer's sleep timing as Windows had it, and turning the screen off after 10 minutes..."
    ; If an earlier Setup kept it awake, that is undone here - unticking
    ; the box otherwise changed nothing.
    SetDetailsPrint none
    !insertmacro OP 'restore-sleep'
    SetDetailsPrint both
  ${EndIf}
  !insertmacro QUIET '"$SYSDIR\powercfg.exe" /change monitor-timeout-ac 10'
  !insertmacro QUIET '"$SYSDIR\powercfg.exe" /change monitor-timeout-dc 10'
  !insertmacro QUIET '"$SYSDIR\powercfg.exe" /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION $LidAction'
  !insertmacro QUIET '"$SYSDIR\powercfg.exe" /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION $LidAction'
  ; The power button shuts the computer down (3), which is what pressing it
  ; is normally taken to mean. It is deliberately NOT tied to the lid
  ; choice: the recommended lid choice is "do nothing", and applying that
  ; to the power button as well left it completely dead - press it, nothing
  ; happens, and the usual next move is to hold it in until the computer
  ; cuts out, which is the one way of switching it off that can lose work.
  ; Shutting down cleanly still never puts this computer to sleep, so it
  ; keeps the promise the rest of this page makes.
  !insertmacro QUIET '"$SYSDIR\powercfg.exe" /setacvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 3'
  !insertmacro QUIET '"$SYSDIR\powercfg.exe" /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 3'
  !insertmacro QUIET '"$SYSDIR\powercfg.exe" /setacvalueindex SCHEME_CURRENT SUB_BATTERY BATACTIONCRIT $BattAction'
  !insertmacro QUIET '"$SYSDIR\powercfg.exe" /setdcvalueindex SCHEME_CURRENT SUB_BATTERY BATACTIONCRIT $BattAction'
  !insertmacro QUIET '"$SYSDIR\powercfg.exe" /setactive SCHEME_CURRENT'
  power_done:

  !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP}"'
  !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP} (port 3000)"'
  !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP} (finding it)"'
  !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP} (Setup search)"'
  ; EVERY computer gets this rule, not just the main one: a printer or print-only
  ; computer finds the main computer by asking the whole network, and Windows
  ; Firewall drops the answer for a program that has no allow rule (nobody is
  ; signed in at start-up to click "Allow" on a pop-up). Without it, finding the
  ; main computer by itself often failed on these computers.
  DetailPrint "Letting ${BRAND} find the main computer (Windows Firewall)..."
  !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${APP}" dir=in action=allow program="$INSTDIR\${EXE}" enable=yes profile=any'
  ; If someone once clicked Cancel on a firewall pop-up, Windows made a
  ; "block" rule that beats every "allow" rule. Remove any such rule.
  !insertmacro QUIET `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Get-NetFirewallApplicationFilter | Where-Object { $$_.Program -like '*\${EXE}' } | Get-NetFirewallRule | Where-Object { $$_.Action -eq 'Block' } | Remove-NetFirewallRule"`
  ${If} $Role == "main"
    DetailPrint "Letting other devices reach the printing page (Windows Firewall)..."
    !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${APP} (port 3000)" dir=in action=allow protocol=TCP localport=3000 profile=any'
    ; Other computers ask the whole network "where is the printing website?"
    ; and this one answers, so they find it whatever address it has today.
    !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${APP} (finding it)" dir=in action=allow protocol=UDP localport=39276 profile=any'
  ${EndIf}

  DetailPrint "Making ${BRAND} start by itself whenever Windows starts..."
  ; At sign-in: the part that opens printouts in the browser (and, as a
  ; fallback, everything else - exactly as older versions did).
  WriteRegStr HKLM "${RUNKEY}" "${APP}" '"$INSTDIR\${EXE}"'
  ; At boot, before anyone signs in: the printing website and printer
  ; sharing, so after a power cut printing comes back as soon as the
  ; computers are switched on. A computer that only prints gets it too
  ; (since 4.1.3): there it runs nothing but automatic updates, which need
  ; the system account's rights and must work with nobody signed in.
  !insertmacro OP 'install-service'

  DetailPrint "Adding ${BRAND} to the Start menu and desktop..."
  SetDetailsPrint none
  ; Shortcuts from before any brand name was used are replaced by the
  ; current brand's ones.
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$SMPROGRAMS\${APP}"
  ; And, whatever name an earlier install here used (any name from before
  ; this one), its
  ; shortcuts are removed too, so this one takes over cleanly with no
  ; leftover Start menu entry under the old name.
  ${If} $PrevBrand != ""
  ${AndIf} $PrevBrand != "${BRAND}"
    SetDetailsPrint both
    DetailPrint "Taking over from the previous setup on this computer ($PrevBrand)..."
    SetDetailsPrint none
    Delete "$DESKTOP\$PrevBrand.lnk"
    RMDir /r "$SMPROGRAMS\$PrevBrand"
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\${BRAND}"
  CreateShortcut "$SMPROGRAMS\${BRAND}\${BRAND}.lnk" "$INSTDIR\${EXE}" "open" "$INSTDIR\office-printing.ico" 0 SW_SHOWNORMAL "" "Open the printing page"
  CreateShortcut "$SMPROGRAMS\${BRAND}\Check ${BRAND}.lnk" "$INSTDIR\${EXE}" "check" "$INSTDIR\office-printing.ico" 0 SW_SHOWNORMAL "" "See whether everything is working"
  CreateShortcut "$SMPROGRAMS\${BRAND}\Restart ${BRAND}.lnk" "$INSTDIR\${EXE}" "restart" "$INSTDIR\office-printing.ico" 0 SW_SHOWNORMAL "" "Stop and start ${BRAND} on this computer"
  CreateShortcut "$SMPROGRAMS\${BRAND}\Update ${BRAND} now.lnk" "$INSTDIR\${EXE}" "update-now" "$INSTDIR\office-printing.ico" 0 SW_SHOWMINIMIZED "" "Look for a new version now (it installs by itself)"
  CreateShortcut "$SMPROGRAMS\${BRAND}\Read me.lnk" "$INSTDIR\README.txt"
  CreateShortcut "$DESKTOP\${BRAND}.lnk" "$INSTDIR\${EXE}" "open" "$INSTDIR\office-printing.ico" 0 SW_SHOWNORMAL "" "Open the printing page"

  SetDetailsPrint both
  DetailPrint "Adding ${BRAND} to Settings > Apps (to remove it later)..."
  SetDetailsPrint none
  WriteUninstaller "$INSTDIR\Uninstall Office Printing.exe"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${BRAND}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\office-printing.ico"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall Office Printing.exe"'
  WriteRegStr HKLM "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Office Printing.exe" /S'
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINSTKEY}" "EstimatedSize" "$0"
  SetDetailsPrint both

  DetailPrint "Adding the $\"${BRAND}$\" printer, for printing from Excel, Word and other programs..."
  !insertmacro OP 'add-printer'

  ${If} $Role == "main"
  ${AndIf} $HasLO != "1"
  ${AndIf} $WantLO == "1"
  ${AndIf} $Update != "1"
    DetailPrint "Installing LibreOffice. This can take 10 to 20 minutes on a slow connection - please leave this window open."
    !insertmacro OP 'install-libreoffice'
  ${EndIf}

  ${If} $FreshInstall == "1"
    ; Nothing is started here: the last page offers to start it now, or to
    ; just close Setup (it then starts by itself when Windows next starts).
    Call MakeFreshFinishText
  ${Else}
    DetailPrint "Starting ${BRAND}..."
    SetDetailsPrint none
    !insertmacro OP 'start-service'
    SetDetailsPrint both
    ${If} $Update == "1"
      ; Run by the system account, which can't start a program on anyone's
      ; screen: the sign-in part is started for each person signed in, as
      ; them (see startForSignedInUsers in service.js).
      !insertmacro OP 'start-signed-in'
    ${Else}
      Call StartAsSignedInUser
    ${EndIf}
    Call WaitUntilReady
    Call MakeFinishText
  ${EndIf}
  DetailPrint "Done."
SectionEnd

; Start the background program as the person signed in to Windows, not as
; the administrator running Setup (exactly as it will start after a restart).
; Asking Explorer to open it does that. If that didn't work, start it directly.
; Asks the installed program for a fresh report. The old file is deleted
; first: status.ini was last written before any of this was installed (see
; .onInit), so without this a program that can't run at all - blocked by
; security software, or a copy that didn't survive being copied - would
; leave the wizard reading facts from before the install and calling it a
; success. A missing file afterwards means it genuinely didn't answer.
!macro FRESH_STATUS
  ; Quietly: this runs every second or two while Setup waits, and would
  ; otherwise fill the list of steps with "Delete file" lines.
  SetDetailsPrint none
  Delete "$PLUGINSDIR\status.ini"
  SetDetailsPrint lastused
  nsExec::Exec '"$INSTDIR\${EXE}" status "$PLUGINSDIR\status.ini"'
  Pop $0
!macroend

Function StartAsSignedInUser
  SetDetailsPrint none
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${EXE}"'
  StrCpy $R0 0
  ${Do}
    Sleep 1000
    IntOp $R0 $R0 + 1
    !insertmacro FRESH_STATUS
    ReadINIStr $1 "$PLUGINSDIR\status.ini" "status" "running"
    ${If} $1 == "1"
      SetDetailsPrint both
      Return
    ${EndIf}
  ${LoopUntil} $R0 >= 30
  ; Explorer didn't start it (rare). Start it directly instead: it then runs
  ; with Setup's permissions until the next sign-in, which works too.
  Exec '"$INSTDIR\${EXE}"'
  SetDetailsPrint both
FunctionEnd

; Wait (up to about half a minute) until this computer is connected, so the
; last page can say what actually happened.
Function WaitUntilReady
  StrCpy $R0 0
  ${Do}
    Sleep 2000
    IntOp $R0 $R0 + 1
    !insertmacro FRESH_STATUS
    ReadINIStr $1 "$PLUGINSDIR\status.ini" "status" "connected"
    ${If} $1 == "1"
      Return
    ${EndIf}
  ${LoopUntil} $R0 >= 15
FunctionEnd

; The last page of a first install: nothing has been started yet.
Function MakeFreshFinishText
  ${If} $Role == "main"
    StrCpy $FinishText "${BRAND} is installed on this computer as the main computer.$\r$\n$\r$\nTo start it now, leave the box below ticked and press Finish; the sign for the wall then opens, ready to print.$\r$\n$\r$\nOr just close this window. ${BRAND} then starts by itself the next time Windows starts, even after a power cut, with nobody signed in."
    StrCpy $FinishLink "Start ${BRAND} now"
  ${ElseIf} $Role == "printer"
    StrCpy $FinishText "${BRAND} is installed on this computer, which will share its printers with the office.$\r$\n$\r$\nTo start it now, leave the box below ticked and press Finish. It finds the main computer by itself.$\r$\n$\r$\nOr just close this window. ${BRAND} then starts by itself the next time Windows starts."
    StrCpy $FinishLink "Start ${BRAND} now"
  ${Else}
    StrCpy $FinishText "${BRAND} is installed on this computer, which can now print to the office printers.$\r$\n$\r$\nTo start it now, leave the box below ticked and press Finish. It finds the main computer by itself.$\r$\n$\r$\nOr just close this window. ${BRAND} then starts by itself the next time someone signs in."
    StrCpy $FinishLink "Start ${BRAND} now"
  ${EndIf}
  ${If} $Role != "client"
    StrCpy $FinishText "$FinishText$\r$\n$\r$\nTo print from Excel, Word or other programs, choose the $\"${BRAND}$\" printer."
  ${EndIf}
  ${If} $Role == "main"
  ${AndIf} $TakeOver == "1"
    StrCpy $FinishText "$FinishText$\r$\n$\r$\nThis is now the only main computer: any other main computer on this network switches over to it within about a minute of it starting (one that is switched off does so when it's next switched on). Their wall signs show their old address, so print this computer's sign to replace them."
  ${EndIf}
  StrCpy $FinishText "$FinishText$\r$\n$\r$\n${CREDIT}"
FunctionEnd

Function MakeFinishText
  ; No report at all means the installed program never ran, so nothing below
  ; would be true. Say that plainly instead of describing an install that
  ; didn't happen.
  ${IfNot} ${FileExists} "$PLUGINSDIR\status.ini"
    StrCpy $FinishText "${BRAND} was copied onto this computer, but it couldn't be started to check that it works.$\r$\n$\r$\nThis is usually security software blocking it. Allow ${EXE} in it, then run this Setup again (or restart the computer), and open $\"Check ${BRAND}$\" from the Start menu to see how it's going."
    StrCpy $FinishLink ""
    ; A silent install reports this too, not just a finished-looking page.
    SetErrorLevel 5
    Return
  ${EndIf}
  ReadINIStr $0 "$PLUGINSDIR\status.ini" "status" "address"
  ReadINIStr $1 "$PLUGINSDIR\status.ini" "status" "connected"
  ReadINIStr $2 "$PLUGINSDIR\status.ini" "status" "printers"
  ReadINIStr $3 "$PLUGINSDIR\status.ini" "status" "website"
  ReadINIStr $4 "$PLUGINSDIR\status.ini" "status" "libreoffice"

  ReadINIStr $5 "$PLUGINSDIR\status.ini" "status" "winprinter"

  ${If} $Role == "client"
    ${If} $1 == "1"
      StrCpy $FinishText "This computer can now print to the office printers.$\r$\n$\r$\nIn Excel, Word or any other program, choose the $\"${BRAND}$\" printer in the Print window. The print page then opens with a preview: choose a printer and press Print.$\r$\n$\r$\nThe print page is at $3."
    ${Else}
      StrCpy $FinishText "${BRAND} is installed, but hasn't found the main computer yet. It keeps looking by itself.$\r$\n$\r$\nMake sure the main computer is switched on and this computer is on the same network. To see how it's going, open $\"Check ${BRAND}$\" from the Start menu."
    ${EndIf}
    ; $3 is the printing page's address, empty until this computer has
    ; reached it - there is nothing to open until then.
    ${If} $3 == ""
      StrCpy $FinishLink ""
    ${Else}
      StrCpy $FinishLink "Open the printing page"
    ${EndIf}
  ${ElseIf} $Role == "main"
    ${If} $1 != "1"
      ; Its own printer part never reached its own printing page: the page
      ; isn't answering (another program using port 3000, for example).
      StrCpy $FinishText "${BRAND} is installed, but its printing page hasn't answered yet. It keeps trying by itself.$\r$\n$\r$\nIf it still isn't working in a few minutes, open $\"Check ${BRAND}$\" from the Start menu to see why."
    ${ElseIf} $0 == ""
      StrCpy $FinishText "${BRAND} is running, but this computer isn't connected to a network right now. Connect it to the office Wi-Fi or network, then open $\"Check ${BRAND}$\" from the Start menu to see the address to use."
    ${Else}
      StrCpy $FinishText "Everyone can now print by opening this address on any phone or computer on the office network:$\r$\n$\r$\n        $0$\r$\n$\r$\nNext, print the sign for the wall (it has this address and a code to scan), then run this Setup on each computer that has a printer."
    ${EndIf}
    ${If} $WantLO == "1"
    ${AndIf} $4 != "1"
      StrCpy $FinishText "$FinishText$\r$\n$\r$\nLibreOffice couldn't be downloaded, so Word, Excel and PowerPoint files and photos won't print yet (PDFs will). Run Setup again later to try once more."
    ${EndIf}
    StrCpy $FinishLink "Open the sign for the wall, to print it"
  ${Else}
    ${If} $1 == "1"
      ${If} $2 == ""
        StrCpy $FinishText "This computer is connected to the printing page as $\"$PcName$\", but no printers were found on it.$\r$\n$\r$\nInstall the printer in Windows (Settings, then Printers & scanners) and print a test page. It is shared automatically within 5 minutes."
      ${Else}
        StrCpy $FinishText "This computer's printers are now shared with the office as $\"$PcName$\":$\r$\n$\r$\n        $2$\r$\n$\r$\nPeople print from $3."
      ${EndIf}
    ${Else}
      StrCpy $FinishText "${BRAND} is installed, but hasn't reached the main computer yet. It keeps trying by itself.$\r$\n$\r$\nMake sure the main computer is switched on and this computer is on the same network. To see how it's going, open $\"Check ${BRAND}$\" from the Start menu."
    ${EndIf}
    ${If} $3 == ""
      StrCpy $FinishLink ""
    ${Else}
      StrCpy $FinishLink "Open the printing page"
    ${EndIf}
  ${EndIf}
  ${If} $5 != "1"
    StrCpy $FinishText "$FinishText$\r$\n$\r$\nThe $\"${BRAND}$\" printer (for Excel, Word and other programs) couldn't be added. Open $\"Check ${BRAND}$\" from the Start menu to see why."
  ${ElseIf} $Role != "client"
    StrCpy $FinishText "$FinishText$\r$\n$\r$\nTo print from Excel, Word or other programs, choose the $\"${BRAND}$\" printer."
  ${EndIf}
  ${If} $Role == "client"
    StrCpy $FinishText "$FinishText$\r$\n$\r$\nIt starts by itself whenever someone signs in, and finds the main computer by itself, even if its address changes."
  ${Else}
    ReadINIStr $6 "$PLUGINSDIR\status.ini" "status" "startuptask"
    ${If} $6 == "1"
      StrCpy $FinishText "$FinishText$\r$\n$\r$\nIt starts by itself whenever Windows starts - even after a power cut, with nobody signed in."
    ${Else}
      StrCpy $FinishText "$FinishText$\r$\n$\r$\nIt starts by itself whenever someone signs in."
    ${EndIf}
  ${EndIf}
  ${If} $Role == "main"
  ${AndIf} $TakeOver == "1"
    StrCpy $FinishText "$FinishText$\r$\n$\r$\nThis is now the only main computer: any other main computer on this network switches over to it within about a minute of it starting (one that is switched off does so when it's next switched on). Their wall signs show their old address, so print this computer's sign to replace them."
  ${EndIf}
  StrCpy $FinishText "$FinishText$\r$\n$\r$\n${CREDIT}"
FunctionEnd

; The standard finish page leaves little room for text above its checkbox.
; Make the text area taller and move the checkbox down below it.
Function FinishPageShow
  ; 195 x 112 dialog units, in pixels for this screen
  System::Call "*(i 0, i 0, i 195, i 112) p .r1"
  System::Call "user32::MapDialogRect(p $mui.FinishPage, p r1)"
  System::Call "*$1(i, i, i .r2, i .r3)"
  System::Free $1
  ; where the text starts now
  System::Call "*(i 0, i 0, i 0, i 0) p .r4"
  System::Call "user32::GetWindowRect(p $mui.FinishPage.Text, p r4)"
  System::Call "user32::MapWindowPoints(p 0, p $mui.FinishPage, p r4, i 2)"
  System::Call "*$4(i .r5, i .r6, i, i)"
  System::Free $4
  System::Call "user32::SetWindowPos(p $mui.FinishPage.Text, p 0, i r5, i r6, i r2, i r3, i 0x14)"
  ; 4 dialog units of space, then the checkbox
  System::Call "*(i 0, i 0, i 0, i 4) p .r1"
  System::Call "user32::MapDialogRect(p $mui.FinishPage, p r1)"
  System::Call "*$1(i, i, i, i .r7)"
  System::Free $1
  IntOp $8 $6 + $3
  IntOp $8 $8 + $7
  System::Call "user32::SetWindowPos(p $mui.FinishPage.Run, p 0, i r5, i r8, i 0, i 0, i 0x15)"
  ; When there is nothing to open (no printing page was reached, or the
  ; program couldn't be started at all), hide the tick box rather than
  ; leaving an empty, ticked one that appears to do nothing when Finish is
  ; pressed.
  ${If} $FinishLink == ""
    ; Unticked too: a hidden box that is still ticked would still open
    ; something (a page that isn't there) when Finish is pressed.
    SendMessage $mui.FinishPage.Run ${BM_SETCHECK} ${BST_UNCHECKED} 0
    ShowWindow $mui.FinishPage.Run ${SW_HIDE}
  ${EndIf}
FunctionEnd

Function OpenAfterSetup
  ; Nothing to open (the tick box was hidden for that reason).
  ${If} $FinishLink == ""
    Return
  ${EndIf}
  ${If} $FreshInstall == "1"
    ; First install: the tick box means "start it now". Pressing Finish with
    ; it ticked starts everything (as the signed-in person, like a restart
    ; would), waits a moment, and on the main computer opens the sign for the wall.
    SetDetailsPrint none
    !insertmacro OP 'start-service'
    SetDetailsPrint both
    Call StartAsSignedInUser
    ${If} $Role == "main"
      Call WaitUntilReady
      Exec '"$WINDIR\explorer.exe" "http://localhost:3000/poster.html"'
    ${EndIf}
    Return
  ${EndIf}
  ; Opened through Explorer so the browser runs as the signed-in person.
  ${If} $Role == "main"
    Exec '"$WINDIR\explorer.exe" "http://localhost:3000/poster.html"'
  ${Else}
    ReadINIStr $0 "$PLUGINSDIR\status.ini" "status" "website"
    ${If} $0 != ""
      Exec '"$WINDIR\explorer.exe" "$0"'
    ${EndIf}
  ${EndIf}
FunctionEnd

; --- removing ------------------------------------------------------------------------

Function un.onInit
  SetRegView 64
  SetShellVarContext all
  InitPluginsDir
  StrCpy $KeepData "0"
  StrCpy $KeepLO "0"

  ; Whether this Setup was the one that installed LibreOffice - only then
  ; is there anything to offer keeping on the next page.
  nsExec::ExecToLog '"$INSTDIR\${EXE}" uninstall-status "$PLUGINSDIR\unstatus.ini"'
  Pop $0
  ReadINIStr $LOBySetup "$PLUGINSDIR\unstatus.ini" "status" "libreofficebysetup"

  ${GetParameters} $R0
  ; Neither of these takes a value, so quotes around them mean nothing -
  ; but they would stop GetOptions matching, and a command line that quotes
  ; every argument ("/S" "/KEEPDATA") would then quietly delete the saved
  ; information it was asked to keep. Taking the quotes out first makes
  ; both ways of writing it behave the same, as they do for the installer.
  StrCpy $R2 ""
  StrCpy $R3 0
  StrLen $R4 $R0
  unquote_loop:
    IntCmp $R3 $R4 unquote_done 0 unquote_done
    StrCpy $R5 $R0 1 $R3
    ${If} $R5 != '"'
      StrCpy $R2 "$R2$R5"
    ${EndIf}
    IntOp $R3 $R3 + 1
    Goto unquote_loop
  unquote_done:
  StrCpy $R0 $R2
  ClearErrors
  ${GetOptions} $R0 "/KEEPDATA" $R1
  ${IfNot} ${Errors}
    StrCpy $KeepData "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/KEEPLIBREOFFICE" $R1
  ${IfNot} ${Errors}
    StrCpy $KeepLO "1"
  ${EndIf}
FunctionEnd

; One screen, one button: Uninstall removes everything. The boxes are for
; the rare case of reinstalling on the main computer and keeping its list,
; and for keeping LibreOffice if it's still wanted for something else.
Function un.ConfirmShow
  !insertmacro MUI_HEADER_TEXT "Remove ${BRAND}" "Everything ${BRAND} added to this computer will be removed."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 58u "This removes ${BRAND} from this computer completely: the program, its shortcuts, the $\"${BRAND}$\" printer, the start-up setting and firewall rules, and the older version's leftover files. Power settings go back to how they were.$\r$\n$\r$\nPrinters on this computer stop being shared. If this is the main computer, printing stops for everyone until ${BRAND} is set up on another main computer."
  Pop $0

  ${NSD_CreateCheckbox} 0 70u 100% 20u "&Keep the saved list of printers and computers (only if ${BRAND} will be installed on this computer again)"
  Pop $hKeepData
  ${If} $KeepData == "1"
    ${NSD_Check} $hKeepData
  ${EndIf}

  ${If} $LOBySetup == "1"
    ${NSD_CreateCheckbox} 0 92u 100% 20u "Keep &LibreOffice (${BRAND} Setup installed it, to print Word, Excel and PowerPoint files - leave unticked to remove it too)"
    Pop $hKeepLO
    ${If} $KeepLO == "1"
      ${NSD_Check} $hKeepLO
    ${EndIf}
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:&Uninstall"
  nsDialogs::Show
FunctionEnd

Function un.ConfirmLeave
  ${NSD_GetState} $hKeepData $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $KeepData "1"
  ${Else}
    StrCpy $KeepData "0"
  ${EndIf}
  ${If} $LOBySetup == "1"
    ${NSD_GetState} $hKeepLO $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $KeepLO "1"
    ${Else}
      StrCpy $KeepLO "0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext all
  SetRegView 64
  ${DisableX64FSRedirection}

  DetailPrint "Stopping ${BRAND}..."
  ; The startup task first, so Task Scheduler can't start it again.
  !insertmacro QUIET '"$SYSDIR\schtasks.exe" /End /TN "${APP}"'
  !insertmacro QUIET '"$SYSDIR\schtasks.exe" /Delete /TN "${APP}" /F'
  ; And the helper tasks automatic updates make (see updater.js and service.js).
  !insertmacro QUIET '"$SYSDIR\schtasks.exe" /Delete /TN "${APP} Update" /F'
  !insertmacro QUIET '"$SYSDIR\schtasks.exe" /Delete /TN "${APP} (start 1)" /F'
  !insertmacro QUIET '"$SYSDIR\schtasks.exe" /Delete /TN "${APP} (start 2)" /F'
  !insertmacro QUIET '"$SYSDIR\schtasks.exe" /Delete /TN "${APP} (start 3)" /F'
  !insertmacro QUIET '"$SYSDIR\schtasks.exe" /Delete /TN "${APP} (start 4)" /F'
  !insertmacro QUIET '"$SYSDIR\taskkill.exe" /F /IM PrintBridgeUpdater.exe'
  ; Its own "stop" first (it knows every part it started), then Windows'.
  nsExec::Exec '"$INSTDIR\${EXE}" stop'
  Pop $0
  !insertmacro QUIET '"$SYSDIR\taskkill.exe" /F /IM ${EXE}'
  Sleep 1500

  DeleteRegValue HKLM "${RUNKEY}" "${APP}"
  !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP}"'
  !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP} (port 3000)"'
  !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP} (finding it)"'
  !insertmacro QUIET '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${APP} (Setup search)"'

  DetailPrint "Putting this computer's power settings back the way they were..."
  nsExec::ExecToLog '"$INSTDIR\${EXE}" restore-power'
  Pop $0

  ; The printer, LibreOffice (unless kept - see $KeepLO), the older
  ; version's files, and a goodbye to the main computer from a printer
  ; computer.
  DetailPrint "Removing the $\"${BRAND}$\" printer and anything else Setup added..."
  nsExec::ExecToLog '"$INSTDIR\${EXE}" before-uninstall $KeepLO'
  Pop $0

  DetailPrint "Removing the program, shortcuts and start-up setting..."
  SetDetailsPrint none
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$SMPROGRAMS\${APP}"
  Delete "$DESKTOP\${BRAND}.lnk"
  RMDir /r "$SMPROGRAMS\${BRAND}"

  ; The program file can only go once nothing is running it.
  StrCpy $R0 0
  ${Do}
    Delete "$INSTDIR\${EXE}"
    ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
      ${Break}
    ${EndIf}
    !insertmacro QUIET '"$SYSDIR\taskkill.exe" /F /IM ${EXE}'
    Sleep 1500
    IntOp $R0 $R0 + 1
  ${LoopUntil} $R0 >= 10
  Delete "$INSTDIR\SumatraPDF.exe"
  Delete "$INSTDIR\SumatraPDF-LICENCE.txt"
  Delete "$INSTDIR\office-printing.ico"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\Uninstall Office Printing.exe"
  ; Automatic updates' folder (a downloaded installer, notes).
  RMDir /r "$INSTDIR\updates"
  RMDir "$INSTDIR"
  SetDetailsPrint both
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    DetailPrint "The program file is still in use; it will be removed when the computer restarts."
    Delete /REBOOTOK "$INSTDIR\${EXE}"
    RMDir /REBOOTOK "$INSTDIR"
  ${EndIf}

  ${If} $KeepData == "1"
    DetailPrint "Kept the saved list of printers and computers in $APPDATA\${APP}."
  ${Else}
    SetDetailsPrint none
    RMDir /r "$APPDATA\${APP}"
    SetDetailsPrint both
    DetailPrint "Deleted the saved information and logs."
  ${EndIf}

  DeleteRegKey HKLM "${UNINSTKEY}"
  DetailPrint "${BRAND} has been removed."
SectionEnd
