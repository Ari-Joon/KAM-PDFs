@echo off
title KAM PDFs setup
echo Creating KAM PDFs shortcuts on your Desktop and Start Menu...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\install.ps1"
echo.
pause
