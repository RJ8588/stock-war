@echo off
cd /d "%~dp0"
echo Starting Dashboard at http://localhost:4173/
echo Keep this window open while previewing locally.
node server.js
pause
