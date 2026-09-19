@echo off
setlocal
set OPENCODE_LOG_DIR=C:\Users\MY\Desktop\Development\opencode\logs
set OPENCODE_LOG_LEVEL=DEBUG
"%~dp0opencode.exe" web --port 4446 --hostname 127.0.0.1
endlocal
