@echo off
title KAM PDFs setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\install.ps1" -Remove
echo.
pause
