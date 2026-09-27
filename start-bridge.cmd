@echo off
rem Starts the WoW lighting bridge and opens its settings page.
rem Close this window (or use "Stop bridge" on the settings page) to stop it;
rem your normal SignalRGB effect is restored either way.
title WoW Lighting Bridge
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Run: winget install OpenJS.NodeJS.LTS & pause & exit /b 1)
node src\index.js --open %*
if errorlevel 1 pause
