@echo off
setlocal
title Office Printing Reset
REM ------------------------------------------------------------------
REM  Office Printing - restart, start fresh, or remove from this computer.
REM
REM  1 and 2 work with a normal double-click.
REM  3 (remove) needs: right-click this file, "Run as administrator".
REM ------------------------------------------------------------------

set "HERE=%~dp0"
set "STARTUPFILE=%ProgramData%\Microsoft\Windows\Start Menu\Programs\StartUp\Office Printing.bat"
set "OLDSTARTUPFILE=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Office Printing.bat"

echo.
echo  ============================================================
echo   Office Printing - restart, reset or remove
echo  ============================================================
echo.
echo   1  Restart printing
echo      Stops everything and starts it again. Try this first
echo      whenever something is not working. Nothing is lost.
echo.
if exist "%HERE%server\server.js" goto menumain
echo   2  Connect again
echo      Forgets the saved website address and asks for it again.
echo      Use this if the main computer's address has changed.
echo.
goto menurest
:menumain
echo   2  Start fresh
echo      Clears the print queue and the list of connected printer
echo      computers, then starts again. You will need to connect the
echo      printers again afterwards.
echo.
:menurest
echo   3  Remove from this computer
echo      Stops printing and undoes everything Setup-Printing.bat
echo      changed. Afterwards you can delete this folder.
echo.
echo   4  Cancel - do nothing
echo.
choice /c 1234 /n /m "  Type 1, 2, 3 or 4: "
if errorlevel 4 goto cancel
if errorlevel 3 goto remove
if errorlevel 2 goto fresh
if errorlevel 1 goto restart
goto cancel

REM ---------------- 1. restart ----------------
:restart
echo.
echo  Stopping...
call :stopall
echo  Starting again...
call "%HERE%AutoStart-Printing.bat" startup
echo  Done. Give it about 30 seconds, then try printing again.
goto finish

REM ---------------- 2. start fresh / connect again ----------------
:fresh
echo.
choice /c YN /n /m "  Clear the saved settings and connect again? Y/N: "
if errorlevel 2 goto cancel
echo.
echo  Stopping...
call :stopall
if exist "%HERE%server\data\db.json" move /y "%HERE%server\data\db.json" "%HERE%server\data\db.json.old" >nul
if exist "%HERE%config.json" move /y "%HERE%config.json" "%HERE%config.json.old" >nul
echo  Cleared. The old copies were kept, ending in .old, just in case.
echo  Starting again...
call "%HERE%AutoStart-Printing.bat" startup
echo.
if exist "%HERE%PrintAgent.exe" echo  A "Connect this printer" page will open in your browser - fill it in again.
if exist "%HERE%server\server.js" echo  Every OTHER printer computer must now run this file too and choose 2, "Connect again".
goto finish

REM ---------------- 3. remove ----------------
:remove
fltmc >nul 2>&1
if errorlevel 1 goto notadmin
echo.
echo  This will:
echo   - stop printing on this computer
echo   - stop it starting by itself when Windows starts
echo   - remove the firewall rules Setup added
echo   - put Windows power settings back to normal. Note: this resets ALL
echo     power plans to the Windows defaults, including any you made yourself.
echo.
choice /c YN /n /m "  Remove Office Printing from this computer? Y/N: "
if errorlevel 2 goto cancel
echo.
echo  Stopping...
call :stopall
if exist "%STARTUPFILE%" del /f /q "%STARTUPFILE%"
if exist "%OLDSTARTUPFILE%" del /f /q "%OLDSTARTUPFILE%"
netsh advfirewall firewall delete rule name="Office Printing (port 3000)" >nul 2>&1
netsh advfirewall firewall delete rule name="Office Printing (Node.js)" >nul 2>&1
reg delete "HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" /v NoAutoRebootWithLoggedOnUsers /f >nul 2>&1
powercfg /restoredefaultschemes >nul 2>&1
powercfg /hibernate on >nul 2>&1
echo.
echo  Removed. You can now delete this whole folder:
echo    %HERE%
echo.
echo  Node.js and LibreOffice are still installed. If nothing else on this
echo  computer needs them, remove them from Settings, Apps, Installed apps.
if exist "%HERE%server\server.js" echo  Printing has now stopped for everyone, because this was the main computer.
goto finish

REM ---------------- helpers ----------------
:stopall
REM Stops the keep-running windows first, so they cannot start anything
REM again, then PrintAgent, then whatever is running the website.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*AutoStart-Printing.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-Process PrintAgent -ErrorAction SilentlyContinue | Stop-Process -Force; Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }" >nul 2>&1
timeout /t 3 /nobreak >nul
REM Did everything really stop? It will not if it was started "as administrator".
powershell -NoProfile -ExecutionPolicy Bypass -Command "if ((Get-Process PrintAgent -ErrorAction SilentlyContinue) -or (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) { exit 1 } else { exit 0 }" >nul 2>&1
if errorlevel 1 goto stuck
goto :eof

:stuck
echo.
echo  Some of it could not be stopped - it was probably started "as administrator".
echo  Close this window, right-click Reset-or-Remove-Printing.bat, choose
echo  "Run as administrator", click Yes, and choose the same option again.
echo.
pause
exit

:notadmin
echo.
echo  Removing needs administrator rights.
echo  Close this window, right-click Reset-or-Remove-Printing.bat,
echo  choose "Run as administrator", click Yes, and choose 3 again.
goto finish

:cancel
echo.
echo  Nothing was changed.

:finish
echo.
pause
exit /b 0
