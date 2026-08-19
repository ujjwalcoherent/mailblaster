@echo off
title MailBlaster
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)

echo.
echo   MailBlaster starting on http://localhost:3000
echo   Leave this window open. Press Ctrl+C to stop.
echo.

start "" http://localhost:3000
node dev-server.js
pause
