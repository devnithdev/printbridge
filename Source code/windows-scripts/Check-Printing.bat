@echo off
title Office Printing Check
REM Office Printing - health check. Only looks; changes nothing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Check-Printing.ps1"
echo.
pause
