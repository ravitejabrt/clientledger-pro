@echo off
title ClientLedger Pro Launcher
echo Starting ClientLedger Pro...

:: Check if Node is installed
where node >nul 2>nul
if %errorlevel% equ 0 (
    echo Node.js detected. Starting local server...
    node server.js
) else (
    echo Node.js not detected. Opening directly in your default browser...
    start "" "%~dp0index.html"
)
pause
