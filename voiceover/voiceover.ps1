# Пуска AI войсоувъра. Извиква се от AI-voiceover*.bat
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$mode  = $args[0]
$files = @($args | Select-Object -Skip 1)

try {
  $uvDir = Join-Path $env:LOCALAPPDATA 'KinotekaTools\uv'
  $uv = Join-Path $uvDir 'uv.exe'
  if (-not (Test-Path $uv)) {
    Write-Host 'Тегля Python инструмента (еднократно)...'
    New-Item -ItemType Directory -Force $uvDir | Out-Null
    $z = Join-Path $uvDir 'uv.zip'
    Invoke-WebRequest 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile $z -UseBasicParsing
    Expand-Archive -Force $z $uvDir
  }
  if (-not (Test-Path $uv)) { throw "Не успях да изтегля uv.exe в $uvDir" }

  if ($files.Count -eq 0) {
    # Без довлачване: отваряме прозорец за избор на епизоди
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = 'Избери епизод(и) — за цял сезон маркирай всички с Ctrl+A'
    $dlg.Filter = 'Видео|*.avi;*.mkv;*.mp4;*.m4v;*.mov;*.wmv;*.ts|Всички файлове|*.*'
    $dlg.Multiselect = $true
    if (Test-Path 'D:\Movie') { $dlg.InitialDirectory = 'D:\Movie' }
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    if ($dlg.ShowDialog($owner) -ne 'OK') { Write-Host 'Нищо не е избрано.' -ForegroundColor Yellow; return }
    $files = @($dlg.FileNames)
  }
  Write-Host ("Избрани: " + $files.Count + " файла")

  $py = Join-Path $PSScriptRoot 'bg_voiceover.py'
  $extra = @()
  if ($mode -eq 'test') { $extra = @('--limit', '180', '--force') }
  Write-Host 'Подготвям Python и библиотеките (първия път отнема 1-2 минути)...'
  $deps = @('--with', 'edge-tts', '--with', 'numpy')
  if (Test-Path (Join-Path $PSScriptRoot 'voices\characters.json')) {
    $deps += @('--with', 'scipy', '--with', 'speechbrain', '--with', 'torch', '--with', 'torchaudio')
  }
  & $uv run --python 3.12 @deps $py @extra @files
  if ($LASTEXITCODE -ne 0) { Write-Host "Програмата спря с код $LASTEXITCODE" -ForegroundColor Red }
}
catch {
  Write-Host ''
  Write-Host "ГРЕШКА: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ''
Write-Host 'Готово. Можеш да затвориш прозореца.' -ForegroundColor Green
