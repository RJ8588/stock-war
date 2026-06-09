@echo off
cd /d "%~dp0"
echo Starting Dashboard at http://localhost:4173/
echo Backup URL: http://127.0.0.1:4173/
echo Keep this window open while previewing locally.
node server.js
pause
