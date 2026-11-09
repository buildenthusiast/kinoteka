# Инсталатор на Кинотека за Windows
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'Kinoteka'
$tmp  = Join-Path $env:TEMP 'kinoteka-setup'
$electronVer = '45.2.3'

Write-Host ''
Write-Host '=== Кинотека: инсталиране ===' -ForegroundColor Yellow
New-Item -ItemType Directory -Force $tmp | Out-Null

$ez = Join-Path $tmp "electron-$electronVer.zip"
if (-not (Test-Path $ez)) {
  Write-Host '1/3 Изтеглям Electron (~150 MB)...'
  Invoke-WebRequest "https://github.com/electron/electron/releases/download/v$electronVer/electron-v$electronVer-win32-x64.zip" -OutFile "$ez.part"
  Move-Item "$ez.part" $ez -Force
} else { Write-Host '1/3 Electron вече е изтеглен.' }

$fz = Join-Path $tmp 'ffmpeg.zip'
if (-not (Test-Path $fz)) {
  Write-Host '2/3 Изтеглям ffmpeg (~90 MB)...'
  Invoke-WebRequest 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip' -OutFile "$fz.part"
  Move-Item "$fz.part" $fz -Force
} else { Write-Host '2/3 ffmpeg вече е изтеглен.' }

Write-Host '3/3 Разархивирам и инсталирам...'
Get-Process Kinoteka -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force $dest | Out-Null
tar -xf $ez -C $dest
Rename-Item (Join-Path $dest 'electron.exe') 'Kinoteka.exe'
Remove-Item -Force (Join-Path $dest 'resources\default_app.asar') -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $dest 'locales') -Filter *.pak | Where-Object { $_.Name -notin @('bg.pak','en-US.pak') } | Remove-Item -Force

$appDir = Join-Path $dest 'resources\app'
New-Item -ItemType Directory -Force $appDir | Out-Null
foreach ($item in @('main.js','preload.js','package.json','lib','renderer')) {
  Copy-Item -Recurse -Force (Join-Path $here "app\$item") $appDir
}

$ffx = Join-Path $tmp 'ffx'
if (Test-Path $ffx) { Remove-Item -Recurse -Force $ffx }
New-Item -ItemType Directory -Force $ffx | Out-Null
tar -xf $fz -C $ffx
$ffbin = Get-ChildItem $ffx -Recurse -Filter ffmpeg.exe | Select-Object -First 1
$binDir = Join-Path $dest 'resources\bin'
New-Item -ItemType Directory -Force $binDir | Out-Null
Copy-Item (Join-Path $ffbin.DirectoryName 'ffmpeg.exe')  $binDir
Copy-Item (Join-Path $ffbin.DirectoryName 'ffprobe.exe') $binDir
Copy-Item (Join-Path $ffbin.DirectoryName '*.dll')       $binDir
Remove-Item -Recurse -Force $ffx

# Преки пътища: работен плот и меню Старт
$shell = New-Object -ComObject WScript.Shell
$exe = Join-Path $dest 'Kinoteka.exe'
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Кинотека.lnk'))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dest
  $lnk.Save()
}

Write-Host ''
Write-Host 'Готово! Кинотека е на работния плот.' -ForegroundColor Green
Start-Process $exe
