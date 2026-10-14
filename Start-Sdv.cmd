@echo off
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\Start-Sdv.ps1" %*
if errorlevel 1 (
    echo.
    echo Startup failed. Read the message above before closing this window.
    pause
    exit /b 1
)
