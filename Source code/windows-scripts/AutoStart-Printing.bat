@echo off
setlocal
REM ------------------------------------------------------------------
REM  Office Printing - start everything and keep it running.
REM
REM  Double-click this to start printing on this computer.
REM  Setup-Printing.bat also makes it run by itself whenever Windows
REM  starts, so after a power cut everything comes back on its own.
REM
REM  If the website or PrintAgent ever stops, it is started again
REM  5 seconds later. Nothing here needs to be edited.
REM ------------------------------------------------------------------

set "HERE=%~dp0"
if /i "%~1"=="website-loop" goto websiteloop
if /i "%~1"=="printer-loop" goto printerloop

set "HASWEB=0"
set "HASAGENT=0"
set "PROBLEM=0"
if exist "%HERE%server\server.js" set "HASWEB=1"
if exist "%HERE%PrintAgent.exe" set "HASAGENT=1"
if "%HASWEB%%HASAGENT%"=="00" goto nothingfound

echo.
echo  Office Printing
echo  ---------------
echo.
if "%HASWEB%"=="1" call :startweb
if "%HASWEB%%HASAGENT%"=="11" timeout /t 5 /nobreak >nul
if "%HASAGENT%"=="1" call :startagent
echo.
echo  Everything runs as small windows in the taskbar at the bottom of
echo  the screen. Leave them there - closing them stops printing.
echo.
if /i "%~1"=="startup" exit /b 0
if "%PROBLEM%"=="1" goto waitforkey
echo  This window closes by itself in 20 seconds.
timeout /t 20 >nul
exit /b 0

:waitforkey
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

REM ---------------- starting the website ----------------
REM Exit code 0 = its keep-running window is already open,
REM 2 = something else is already using port 3000, 1 = free to start.
:startweb
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*website-loop*' }) { exit 0 } elseif (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 2 } else { exit 1 }" >nul 2>&1
if errorlevel 2 goto webportbusy
if not errorlevel 1 goto webalready
where node >nul 2>&1
if errorlevel 1 goto webnonode
start "Office Printing - Website" /min cmd /c ""%~f0" website-loop"
echo  - Website: started.
goto :eof

:webalready
echo  - Website: already running.
goto :eof

:webportbusy
echo  - Website: something is already using port 3000 - most likely the
echo    website is already open in another window. Not starting a second
echo    copy. If printing is not working, run Reset-or-Remove-Printing.bat
echo    and choose 1 to restart everything.
goto :eof

:webnonode
echo  - Website: PROBLEM - Node.js is not installed on this computer.
echo    Install it from https://nodejs.org then run this file again.
set "PROBLEM=1"
goto :eof

REM ---------------- starting PrintAgent ----------------
:startagent
powershell -NoProfile -ExecutionPolicy Bypass -Command "if ((Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*printer-loop*' }) -or (Get-Process PrintAgent -ErrorAction SilentlyContinue)) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 goto agentalready
start "Office Printing - Printer" /min cmd /c ""%~f0" printer-loop"
echo  - PrintAgent: started.
if not exist "%HERE%config.json" echo    First time: a "Connect this printer" page will open in your browser.
goto :eof

:agentalready
echo  - PrintAgent: already running.
goto :eof

REM ---------------- the website's keep-running loop ----------------
:websiteloop
title Office Printing - Website
cd /d "%HERE%server"
:webcheck
if exist "node_modules\express\package.json" goto webrun
echo.
echo  First time only: downloading what the website needs.
echo  This needs internet and takes about a minute...
echo.
call npm install --no-audit --no-fund
:webrun
echo.
echo  Starting the website. Keep this window open - minimized is fine.
echo.
node server.js
echo.
echo  The website stopped. Starting it again in 5 seconds...
timeout /t 5 /nobreak >nul
goto webcheck

REM ---------------- PrintAgent's keep-running loop ----------------
:printerloop
title Office Printing - Printer
cd /d "%HERE%"
:agentrun
"%HERE%PrintAgent.exe"
echo.
echo  PrintAgent stopped. Starting it again in 5 seconds...
timeout /t 5 /nobreak >nul
goto agentrun
