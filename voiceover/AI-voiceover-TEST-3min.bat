@echo off
powershell.exe -NoProfile -STA -NoExit -ExecutionPolicy Bypass -File "%~dp0voiceover.ps1" test %*
