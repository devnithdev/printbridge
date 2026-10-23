@echo off
setlocal
title Office Printing Setup
REM ------------------------------------------------------------------
REM  Office Printing - one-time setup for this computer.
REM
REM  Right-click this file and choose "Run as administrator".
REM  Safe to run again at any time; it just puts everything back
REM  the way it should be.
REM
REM  What it does:
REM   - stops this computer sleeping, hibernating or restarting by itself
REM     (the screen still switches off after 10 minutes)
REM   - makes printing start by itself whenever Windows starts
REM   - on the main computer only: lets other devices reach the website
REM     through Windows Firewall, and checks Node.js and LibreOffice
REM ------------------------------------------------------------------

set "HERE=%~dp0"
REM The all-users Startup folder, so it works whoever is signed in.
set "STARTUPDIR=%ProgramData%\Microsoft\Windows\Start Menu\Programs\StartUp"
set "STARTUPFILE=%STARTUPDIR%\Office Printing.bat"
set "OLDSTARTUPDIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

fltmc >nul 2>&1
if errorlevel 1 goto notadmin

set "HASWEB=0"
set "HASAGENT=0"
if exist "%HERE%server\server.js" set "HASWEB=1"
if exist "%HERE%PrintAgent.exe" set "HASAGENT=1"
if "%HASWEB%%HASAGENT%"=="00" goto nothingfound
if not exist "%HERE%AutoStart-Printing.bat" goto noautostart

echo.
echo  ============================================================
echo   Office Printing - setting up this computer
echo  ============================================================
if "%HASWEB%"=="1" echo   This is the MAIN computer - it runs the printing website.
if "%HASWEB%"=="0" echo   This is a PRINTER computer - it runs PrintAgent only.
if "%HASWEB%%HASAGENT%"=="11" echo   PrintAgent.exe is here too, so its printer will be shared as well.
echo.

REM ---------------- 1. stay awake ----------------
echo  * Keeping this computer awake...
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change standby-timeout-dc 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-dc 0 >nul 2>&1
powercfg /change monitor-timeout-ac 10 >nul 2>&1
powercfg /change monitor-timeout-dc 10 >nul 2>&1
powercfg /hibernate off >nul 2>&1
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 >nul 2>&1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 >nul 2>&1
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 0 >nul 2>&1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 0 >nul 2>&1
powercfg /setacvalueindex SCHEME_CURRENT SUB_BATTERY BATACTIONCRIT 3 >nul 2>&1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BATTERY BATACTIONCRIT 3 >nul 2>&1
powercfg /setactive SCHEME_CURRENT >nul 2>&1
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" /v NoAutoRebootWithLoggedOnUsers /t REG_DWORD /d 1 /f >nul
echo      OK - no sleep, no hibernate, closing the lid does nothing,
echo      Windows Update is told not to restart it while someone is signed in.
echo      The screen still turns off after 10 minutes - that is fine.

REM ---------------- 2. start by itself ----------------
echo  * Making printing start by itself when Windows starts...
> "%STARTUPFILE%" echo @echo off
>> "%STARTUPFILE%" echo REM Starts office printing when Windows starts. Made by Setup-Printing.bat.
>> "%STARTUPFILE%" echo start "" /min cmd /c ""%HERE%AutoStart-Printing.bat" startup"
if not exist "%STARTUPFILE%" goto startupfailed
REM An older version of these scripts put its own copy in the personal
REM Startup folder; two copies would start everything twice.
if exist "%OLDSTARTUPDIR%\Office Printing.bat" del /f /q "%OLDSTARTUPDIR%\Office Printing.bat"
echo      OK
goto afterstartup
:startupfailed
echo      PROBLEM - could not write to the Startup folder:
echo      %STARTUPDIR%
:afterstartup

REM Files that came from a downloaded zip carry a "downloaded from the
REM internet" mark, which makes Windows ask "are you sure?" every time
REM they run - including at startup, when nobody is there to click.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath $env:HERE -Recurse -File | Unblock-File" >nul 2>&1

if "%HASWEB%"=="0" goto duplicates

REM ---------------- 3. firewall (main computer) ----------------
echo  * Letting other devices reach the website (Windows Firewall)...
set "NODEEXE="
for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%n"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
netsh advfirewall firewall delete rule name="Office Printing (port 3000)" >nul 2>&1
netsh advfirewall firewall add rule name="Office Printing (port 3000)" dir=in action=allow protocol=TCP localport=3000 profile=any >nul
if errorlevel 1 goto fwfailed
if not defined NODEEXE goto fwok
netsh advfirewall firewall delete rule name="Office Printing (Node.js)" >nul 2>&1
netsh advfirewall firewall add rule name="Office Printing (Node.js)" dir=in action=allow program="%NODEEXE%" enable=yes profile=any >nul
REM If someone once clicked Cancel on the firewall pop-up, Windows made
REM a "block Node.js" rule that beats every "allow" rule. Remove it.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*\node.exe' } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule" >nul 2>&1
:fwok
echo      OK
goto nodecheck
:fwfailed
echo      PROBLEM - the firewall rule could not be added.

REM ---------------- 4. Node.js (main computer) ----------------
:nodecheck
echo  * Checking Node.js (the program the website runs on)...
if defined NODEEXE goto nodeok
where winget >nul 2>&1
if errorlevel 1 goto nodemanual
echo      Not found - installing it now. Please wait...
winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
if exist "%ProgramFiles%\nodejs\node.exe" goto nodejustinstalled
:nodemanual
echo      ACTION NEEDED - Node.js is not installed.
echo      Download the "LTS" version from https://nodejs.org , install it,
echo      then run this setup again.
goto locheck
:nodejustinstalled
echo      OK - Node.js installed. Run this setup once more so the
echo      firewall step can finish for it.
goto locheck
:nodeok
echo      OK - %NODEEXE%

REM ---------------- 5. LibreOffice (main computer) ----------------
:locheck
echo  * Checking LibreOffice (needed to print Word, Excel and PowerPoint files)...
call :findlo
if defined LOEXE goto look
where winget >nul 2>&1
if errorlevel 1 goto lomanual
echo      Not found - installing it now. This is a big download and can take
echo      a long time on a slow connection. Please leave this window open...
winget install --id TheDocumentFoundation.LibreOffice -e --silent --accept-package-agreements --accept-source-agreements
call :findlo
if defined LOEXE goto look
:lomanual
echo      ACTION NEEDED - LibreOffice is not installed. PDFs and photos will
echo      still print, but Word/Excel/PowerPoint files will not.
echo      Download it from https://www.libreoffice.org/download/ and install it.
echo      Nothing needs restarting afterwards.
goto duplicates
:look
echo      OK - %LOEXE%

REM ---------------- 6. look for old copies ----------------
:duplicates
echo  * Looking for old ways of starting printing that would clash...
set "DUP=0"
for /f "delims=" %%f in ('dir /b "%STARTUPDIR%" 2^>nul ^| findstr /i "PrintAgent Platform"') do call :founddup "In %STARTUPDIR%: %%f"
for /f "delims=" %%f in ('dir /b "%OLDSTARTUPDIR%" 2^>nul ^| findstr /i "PrintAgent Platform"') do call :founddup "In %OLDSTARTUPDIR%: %%f"
schtasks /query /v /fo csv 2>nul | findstr /i "PrintAgent.exe" >nul
if not errorlevel 1 call :founddup "A Task Scheduler task that starts PrintAgent.exe"
if "%DUP%"=="0" echo      OK - none found.
if "%DUP%"=="1" echo      Delete the items above - open each folder shown and delete the file,
if "%DUP%"=="1" echo      and delete any such task in Task Scheduler. Printing now starts by itself.

REM ---------------- done ----------------
echo.
echo  ============================================================
echo   Setup finished.
echo  ============================================================
if "%HASWEB%"=="0" goto finishprinter
echo.
echo   The printing website's address - everyone uses this one:
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { '      http://' + $_.IPAddress + ':3000' }"
echo.
echo   If more than one address is shown, use the one that starts the same
echo   way as your other office devices (often 192.168...).
:finishprinter
echo.
echo   Next: double-click AutoStart-Printing.bat to start printing now.
echo.
pause
exit /b 0

REM ---------------- helpers ----------------
:findlo
set "LOEXE="
if exist "%ProgramFiles%\LibreOffice\program\soffice.exe" set "LOEXE=%ProgramFiles%\LibreOffice\program\soffice.exe"
if defined LOEXE goto :eof
if exist "%ProgramFiles(x86)%\LibreOffice\program\soffice.exe" set "LOEXE=%ProgramFiles(x86)%\LibreOffice\program\soffice.exe"
goto :eof

:founddup
set "DUP=1"
echo      FOUND - %~1
goto :eof

:notadmin
echo.
echo  This needs to run as administrator.
echo  Close this window, right-click Setup-Printing.bat and choose
echo  "Run as administrator", then click Yes.
echo.
pause
exit /b 1

:nothingfound
echo.
echo  This file must be in the same folder as PrintAgent.exe
echo  and/or the "server" folder. Nothing was found next to it in:
echo    %HERE%
echo.
pause
exit /b 1

:noautostart
echo.
echo  AutoStart-Printing.bat is missing from this folder:
echo    %HERE%
echo  Put it back (it came in the same zip) and run this again.
echo.
pause
exit /b 1
