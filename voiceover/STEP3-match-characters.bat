@echo off
powershell.exe -NoProfile -STA -NoExit -ExecutionPolicy Bypass -File "%~dp0voices.ps1" map
