# Инсталатор на Кинотека за Windows
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Add-Type -AssemblyName System.IO.Compression.FileSystem

# Пълен (дълъг) път: %TEMP% често е 8.3 съкратен (C:\Users\HOMEPC~1\...), когато
# потребителското име има интервал или кирилица, и Move-Item/Copy-Item се чупят на него.
function Get-LongPath([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
  return (Get-Item -LiteralPath $p).FullName
}
# Разархивиране през .NET: работи с интервали и кирилица в пътя (tar.exe невинаги).
function Expand-Zip([string]$zip, [string]$to) {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $to)
}

$here = Get-LongPath (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dest = Join-Path (Get-LongPath $env:LOCALAPPDATA) 'Kinoteka'
$tmp  = Join-Path (Get-LongPath $env:TEMP) 'kinoteka-setup'
$electronVer = '45.2.3'

Write-Host ''
Write-Host '=== Кинотека: инсталиране ===' -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$ez = Join-Path $tmp "electron-$electronVer.zip"
if (-not (Test-Path -LiteralPath $ez)) {
  Write-Host '1/3 Изтеглям Electron (~150 MB)...'
  Invoke-WebRequest "https://github.com/electron/electron/releases/download/v$electronVer/electron-v$electronVer-win32-x64.zip" -OutFile "$ez.part"
  Move-Item -LiteralPath "$ez.part" -Destination $ez -Force
} else { Write-Host '1/3 Electron вече е изтеглен.' }

$fz = Join-Path $tmp 'ffmpeg.zip'
if (-not (Test-Path -LiteralPath $fz)) {
  Write-Host '2/3 Изтеглям ffmpeg (~90 MB)...'
  Invoke-WebRequest 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip' -OutFile "$fz.part"
  Move-Item -LiteralPath "$fz.part" -Destination $fz -Force
} else { Write-Host '2/3 ffmpeg вече е изтеглен.' }

Write-Host '3/3 Разархивирам и инсталирам...'
Get-Process Kinoteka -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Zip $ez $dest
Rename-Item -LiteralPath (Join-Path $dest 'electron.exe') -NewName 'Kinoteka.exe'
Remove-Item -LiteralPath (Join-Path $dest 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath (Join-Path $dest 'locales') -Filter *.pak | Where-Object { $_.Name -notin @('bg.pak','en-US.pak') } | Remove-Item -Force

$appDir = Join-Path $dest 'resources\app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
foreach ($item in @('main.js','preload.js','package.json','lib','renderer')) {
  Copy-Item -LiteralPath (Join-Path $here "app\$item") -Destination $appDir -Recurse -Force
}

$ffx = Join-Path $tmp 'ffx'
if (Test-Path -LiteralPath $ffx) { Remove-Item -LiteralPath $ffx -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ffx | Out-Null
Expand-Zip $fz $ffx
$ffbin = Get-ChildItem -LiteralPath $ffx -Recurse -Filter ffmpeg.exe | Select-Object -First 1
$binDir = Join-Path $dest 'resources\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item -LiteralPath (Join-Path $ffbin.DirectoryName 'ffmpeg.exe')  -Destination $binDir
Copy-Item -LiteralPath (Join-Path $ffbin.DirectoryName 'ffprobe.exe') -Destination $binDir
Get-ChildItem -LiteralPath $ffbin.DirectoryName -Filter *.dll | Copy-Item -Destination $binDir
Remove-Item -LiteralPath $ffx -Recurse -Force

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
Start-Process -FilePath $exe -WorkingDirectory $dest
