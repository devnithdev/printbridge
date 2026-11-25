@echo off
REM  LEGACY: from before PrintBridgeSetup.exe existed. Setup and "Check PrintBridge" do this now.
REM  Kept for reference; on a current install it can stop the wrong thing.
title Office Printing Check
REM Office Printing - health check. Only looks; changes nothing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Check-Printing.ps1"
echo.
pause
