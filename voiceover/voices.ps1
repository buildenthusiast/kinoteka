# Гласовете от дублажа: collect | map | train | all
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$mode = $args[0]
$here = $PSScriptRoot
$voices = Join-Path $here 'voices'
$applio = Join-Path $env:USERPROFILE 'Applio'
$ML = @('--with', 'numpy', '--with', 'scipy', '--with', 'speechbrain', '--with', 'torch', '--with', 'torchaudio')

function Get-Uv {
  $uvDir = Join-Path $env:LOCALAPPDATA 'KinotekaTools\uv'
  $uv = Join-Path $uvDir 'uv.exe'
  if (-not (Test-Path $uv)) {
    Write-Host 'Тегля Python инструмента (еднократно)...'
    New-Item -ItemType Directory -Force $uvDir | Out-Null
    $z = Join-Path $uvDir 'uv.zip'
    Invoke-WebRequest 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile $z -UseBasicParsing
    Expand-Archive -Force $z $uvDir
  }
  return $uv
}

function Get-Owner { Add-Type -AssemblyName System.Windows.Forms; return (New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }) }

function Select-Folders($title, $start, [bool]$multi) {
  $owner = Get-Owner
  $folders = @()
  while ($true) {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "$title (избрани досега: $($folders.Count))"
    if ($start -and (Test-Path $start)) { $dlg.SelectedPath = $start }
    if ($dlg.ShowDialog($owner) -ne 'OK') { break }
    $folders += $dlg.SelectedPath
    Write-Host "  + $($dlg.SelectedPath)"
    if (-not $multi) { break }
    $start = Split-Path $dlg.SelectedPath -Parent
    $more = [System.Windows.Forms.MessageBox]::Show($owner, "Добавена:`n$($dlg.SelectedPath)`n`nДа добавя ли още папка?", 'Гласове', 'YesNo', 'Question')
    if ($more -ne 'Yes') { break }
  }
  return ,$folders
}

function Invoke-Collect($folders) {
  $uv = Get-Uv
  Write-Host "`n=== Събирам гласовете на актьорите (около час) ===  $(Get-Date -Format HH:mm)" -ForegroundColor Cyan
  & $uv run --python 3.12 --with faster-whisper @ML (Join-Path $here 'prepare_voices.py') @folders
  if ($LASTEXITCODE -ne 0) { throw 'Събирането на гласовете се провали.' }
}

function Invoke-Map($folder) {
  $uv = Get-Uv
  & $uv run --python 3.12 @ML (Join-Path $here 'map_characters.py') $folder
}

function Install-Applio {
  if (Test-Path (Join-Path $applio 'env\python.exe')) { return }
  Write-Host 'Инсталирам Applio (програмата за обучение на гласове). Тегли около 5-6 GB, 15-40 минути...' -ForegroundColor Yellow
  $tmp = Join-Path $env:TEMP 'applio-main.zip'
  Invoke-WebRequest 'https://github.com/IAHispano/Applio/archive/refs/heads/main.zip' -OutFile $tmp -UseBasicParsing
  $ex = Join-Path $env:TEMP 'applio-extract'
  if (Test-Path $ex) { Remove-Item -Recurse -Force $ex }
  Expand-Archive -Force $tmp $ex
  $src = Get-ChildItem $ex -Directory | Select-Object -First 1
  if (Test-Path $applio) { Remove-Item -Recurse -Force $applio }
  Move-Item $src.FullName $applio
  Push-Location $applio
  cmd /c "echo.| run-install.bat"
  Pop-Location
  if (-not (Test-Path (Join-Path $applio 'env\python.exe'))) { throw 'Инсталацията на Applio не мина. Виж текста отгоре.' }
}

# копира до $minutes минути от записите на гласа в отделна папка (по-малко = много по-бързо обучение)
function New-TrainSet($src, $label, [double]$minutes) {
  $dst = Join-Path $voices "_train\$label"
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $sum = 0.0
  foreach ($f in (Get-ChildItem $src -Filter *.wav | Sort-Object Name)) {
    $b = New-Object byte[] 44
    $fs = [IO.File]::OpenRead($f.FullName); [void]$fs.Read($b, 0, 44); $fs.Close()
    $sr = [BitConverter]::ToInt32($b, 24); $bps = [BitConverter]::ToInt16($b, 34) / 8; $ch = [BitConverter]::ToInt16($b, 22)
    if ($sr -le 0 -or $bps -le 0) { continue }
    $sum += ($f.Length - 44) / ($sr * $bps * [Math]::Max(1, $ch))
    Copy-Item $f.FullName $dst
    if ($sum -ge $minutes * 60) { break }
  }
  Write-Host ("  за обучение: {0:N1} минути запис" -f ($sum / 60))
  return $dst
}

function Invoke-Train([int]$maxVoices) {
  Install-Applio
  $py = Join-Path $applio 'env\python.exe'
  Push-Location $applio
  try {
    Write-Host 'Тегля нужните модели (еднократно)...' -ForegroundColor Yellow
    & $py core.py prerequisites
    $cores = [Math]::Max(1, [Environment]::ProcessorCount - 2)
    $stats = Get-Content (Join-Path $voices 'stats.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $used = @()
    $cj = Join-Path $voices 'characters.json'
    if (Test-Path $cj) {
      $used = @((Get-Content $cj -Raw -Encoding UTF8 | ConvertFrom-Json).characters | Where-Object { $_.model -and $stats.($_.actor).model -eq $_.model } | ForEach-Object { $_.actor } | Sort-Object -Unique)
    }
    # кандидати: избраните за герои, иначе най-големите гласове
    $cands = @($stats.PSObject.Properties | Where-Object { $_.Value.minutes -ge 5 } | Sort-Object { -[double]$_.Value.minutes })
    if ($used.Count) { $cands = @($cands | Where-Object { $used -contains $_.Name }) }
    elseif ($maxVoices -gt 0) { $cands = @($cands | Select-Object -First $maxVoices) }
    $todo = @()
    foreach ($c in $cands) {
      $name = $c.Value.model
      $ld = Join-Path $applio "logs\$name"
      if (Get-ChildItem $ld -Recurse -Filter *.index -ErrorAction SilentlyContinue) {
        Write-Host "$($c.Name) вече е обучен." -ForegroundColor Green; continue
      }
      # има готов модел от прекъснато обучение -> само индекс, без ново обучение
      $done = @(Get-ChildItem $ld -Filter *.pth -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^[GD]_' })
      if ($done.Count) {
        Write-Host "$($c.Name): ползвам вече тренирания $($done[0].Name), правя само индекса." -ForegroundColor Green
        & $py core.py index --model-name $name
        continue
      }
      $todo += $c
    }
    $gpu = & $py -c "import torch;print(torch.cuda.is_available())" 2>$null
    if ("$gpu".Trim() -ne 'True') { Write-Host 'ВНИМАНИЕ: видеокартата (NVIDIA) не се вижда, обучението ще върви на процесора и ще е МНОГО бавно.' -ForegroundColor Red }
    else { Write-Host 'Видеокартата се вижда, обучавам на нея.' -ForegroundColor Green }
    Write-Host "`nЩе обучавам $($todo.Count) гласа: $(($todo | ForEach-Object { $_.Name }) -join ', '). Около 2-3 часа на глас." -ForegroundColor Cyan
    $i = 0
    foreach ($c in $todo) {
      $i++
      $name = $c.Value.model
      $ds = New-TrainSet (Join-Path $voices $c.Name) $c.Name 10
      Write-Host "`n=== [$i/$($todo.Count)] Обучавам $($c.Name) ===  $(Get-Date -Format HH:mm)" -ForegroundColor Cyan
      & $py core.py preprocess --model-name $name --dataset-path $ds --sample-rate 40000 --cpu-cores $cores
      if ($LASTEXITCODE -ne 0) { throw "preprocess се провали за $($c.Name)" }
      & $py core.py extract --model-name $name --f0-method rmvpe --gpu 0 --sample-rate 40000 --cpu-cores $cores
      if ($LASTEXITCODE -ne 0) { throw "extract се провали за $($c.Name)" }
      & $py core.py train --model-name $name --sample-rate 40000 --total-epoch 25 --save-every-epoch 5 --save-only-latest --batch-size 4 --gpu 0
      if ($LASTEXITCODE -ne 0) { throw "train се провали за $($c.Name)" }
      & $py core.py index --model-name $name
    }
  } finally { Pop-Location }
}

function Invoke-Voiceover($folder) {
  $uv = Get-Uv
  Write-Host "`n=== Озвучавам $folder ===  $(Get-Date -Format HH:mm)" -ForegroundColor Cyan
  & $uv run --python 3.12 --with edge-tts @ML (Join-Path $here 'bg_voiceover.py') $folder
}

try {
  if ($mode -eq 'collect') {
    $f = Select-Folders 'Избери папка с дублиран сезон' 'D:\Movie\bbt' $true
    if ($f.Count -eq 0) { Write-Host 'Нищо не е избрано.' -ForegroundColor Yellow; return }
    Invoke-Collect $f
    Start-Process explorer.exe $voices
  }
  elseif ($mode -eq 'map') {
    $f = Select-Folders 'Избери папката на сезона за озвучаване (с .srt)' 'D:\Movie\bbt\4' $false
    if ($f.Count -eq 0) { Write-Host 'Нищо не е избрано.' -ForegroundColor Yellow; return }
    Invoke-Map $f[0]
  }
  elseif ($mode -eq 'train') {
    Invoke-Train 4
    Write-Host "`nГласовете са обучени." -ForegroundColor Green
  }
  elseif ($mode -eq 'all') {
    Write-Host 'ВСИЧКО НАВЕДНЪЖ: избери папките, после остави лаптопа включен в контакта.' -ForegroundColor Yellow
    # гласовете вече са събрани -> не ги събираме наново (иначе обучените гласове стават невалидни)
    $have = Test-Path (Join-Path $voices 'stats.json')
    if ($have) {
      Write-Host 'Гласовете вече са събрани, продължавам от обучението. (За ново събиране пусни STEP1.)' -ForegroundColor Green
    } else {
      $dub = Select-Folders '1) Избери папка с ДУБЛИРАН сезон (1, 2, 3...)' 'D:\Movie\bbt' $true
      if ($dub.Count -eq 0) { Write-Host 'Нищо не е избрано.' -ForegroundColor Yellow; return }
    }
    $target = Select-Folders 'Избери папката на сезона за ОЗВУЧАВАНЕ (напр. 4)' 'D:\Movie\bbt\4' $false
    if ($target.Count -eq 0) { Write-Host 'Нищо не е избрано.' -ForegroundColor Yellow; return }
    $t0 = Get-Date
    if (-not $have) { Invoke-Collect $dub }
    Invoke-Train 4
    Invoke-Voiceover $target[0]
    Write-Host "`nВСИЧКО Е ГОТОВО за $([int]((Get-Date) - $t0).TotalMinutes) минути. Пусни епизодите в Кинотека." -ForegroundColor Green
  }
}
catch {
  Write-Host ''
  Write-Host "ГРЕШКА: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ''
Write-Host 'Край. Можеш да затвориш прозореца.' -ForegroundColor Green
