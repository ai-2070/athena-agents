@echo off
rem Starts My Dashboard (http://localhost:4800) and opens it. Double-click me.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies, one moment...
  call npm install --no-fund --no-audit || (pause & exit /b 1)
)
start "My Dashboard" /min node server\index.js %*
