@echo off
rem Launcher shell: keep this file pure ASCII so cmd.exe can always parse it.
setlocal
set ELECTRON_RUN_AS_NODE=
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\launch.ps1" %*
if errorlevel 1 pause
endlocal
