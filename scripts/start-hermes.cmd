@echo off
setlocal
cd /d "%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-hermes.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%
