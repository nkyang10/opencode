@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows-installer.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo BUILD FAILED with exit code %EXITCODE%
  exit /b %EXITCODE%
)
exit /b 0
