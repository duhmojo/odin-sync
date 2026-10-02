@echo off
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" (
  "node_modules\electron\dist\electron.exe" .
) else (
  call npm.cmd start
)
if errorlevel 1 pause
