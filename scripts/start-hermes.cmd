@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

echo.
echo ========================================
echo  AUTOROUTER V2
echo ========================================
echo.

curl.exe --silent --fail --connect-timeout 2 http://127.0.0.1:20200/health >nul 2>&1
if not errorlevel 1 (
  echo [READY] AutoRouter is already running at http://127.0.0.1:20200
  exit /b 0
)

call npm run build
if errorlevel 1 (
  echo [ERROR] AutoRouter build failed.
  exit /b 1
)

echo [INFO] Starting AutoRouter at http://127.0.0.1:20200
node dist\index.js
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%
