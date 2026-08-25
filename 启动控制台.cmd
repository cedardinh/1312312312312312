@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 20 or 22 x64 and add node to PATH.
  pause
  exit /b 1
)

node -e "if(Number(process.versions.node.split('.')[0])^<20)process.exit(1)"
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  pause
  exit /b 1
)

if not exist "%CD%\dist\server\src\server\index.js" (
  echo [ERROR] The application files are incomplete.
  pause
  exit /b 1
)

set "CONTRACT_CONSOLE_HOST=127.0.0.1"
set "CONTRACT_CONSOLE_PORT=4174"
set "CONTRACT_CONSOLE_ALLOW_OVERSIZED_CONTRACTS=true"
set "CONSOLE_URL=http://127.0.0.1:4174/"

start "" /b powershell -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "$u='%CONSOLE_URL%';for($i=0;$i-lt 60;$i++){try{$r=Invoke-RestMethod -Uri ($u+'api/health') -TimeoutSec 1;if($r.ok){Start-Process $u;exit}}catch{};Start-Sleep -Milliseconds 500}"

echo Contract Console is starting at %CONSOLE_URL%
echo Keep this window open. Press Ctrl+C to stop the service.
node "%CD%\dist\server\src\server\index.js"
set "CONSOLE_EXIT=%ERRORLEVEL%"
echo.
echo Service stopped with exit code %CONSOLE_EXIT%.
pause
exit /b %CONSOLE_EXIT%
