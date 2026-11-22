@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [cep-zh] Node.js 22+ is required but "node" was not found in PATH.
  exit /b 1
)
node "%~dp0cli.mjs" %*
