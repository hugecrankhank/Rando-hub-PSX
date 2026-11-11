@echo off
setlocal
title PSX Rando Hub - build installer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  start https://nodejs.org
  pause
  exit /b 1
)

echo [1/3] Installing build tools...
call npm install --no-audit --no-fund || goto :fail

echo [2/3] Bundling SotN Randomizer...
call npm run setup || goto :fail

echo [3/3] Building installer (takes a few minutes the first time)...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win nsis portable --publish never || goto :fail

echo.
echo Done! Your installer and portable exe are in the "dist" folder.
start "" "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo Build failed - scroll up for the error.
pause
exit /b 1
