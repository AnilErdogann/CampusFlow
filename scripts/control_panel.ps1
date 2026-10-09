$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
$serverPort = 8765
$appUrl = "http://127.0.0.1:$serverPort/"
$healthUrl = "http://127.0.0.1:$serverPort/health"
$stateDirectory = Join-Path $projectRoot 'work\control-panel'
$statePath = Join-Path $stateDirectory 'server.json'
$logDirectory = Join-Path $stateDirectory 'logs'
$tunnelScript = Join-Path $PSScriptRoot 'start_public_demo.ps1'
$script:restartPending = $false
$script:serverStdout = $null
$script:serverStderr = $null
$env:PYTHONUTF8 = '1'
$packagedAppDirectory = Join-Path (Split-Path $projectRoot -Parent) '02_Windows_Uygulamasi'
if (Test-Path -LiteralPath (Join-Path $packagedAppDirectory 'CampusFlow-Setup.exe')) {
  $env:CAMPUSFLOW_DOWNLOADS_DIR = $packagedAppDirectory
}


New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Get-ManagedServerProcess {
  if (-not (Test-Path -LiteralPath $statePath) -or -not (Test-Path -LiteralPath $pythonPath)) { return $null }
  try {
    $entry = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$entry.pid)" -ErrorAction Stop
    $process = Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
    $expectedPython = [IO.Path]::GetFullPath($pythonPath)
    $actualPython = [IO.Path]::GetFullPath($cimProcess.ExecutablePath)
    $command = [string]$cimProcess.CommandLine
    $expectedStart = [DateTime]::Parse([string]$entry.started_utc).ToUniversalTime()
    $actualStart = $process.StartTime.ToUniversalTime()
    if ($actualPython -ine $expectedPython -or -not $command.Contains('app.main:app') -or -not $command.Contains("--port $serverPort")) { return $null }
    if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 2) { return $null }
    $script:serverStdout = [string]$entry.stdout
    $script:serverStderr = [string]$entry.stderr
    return $process
  } catch { return $null }
}

function Test-CampusFlowServer {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 -ErrorAction Stop
    return $health.status -eq 'ok'
  } catch { return $false }
}

function Get-PortListener {
  try { return Get-NetTCPConnection -State Listen -LocalPort $serverPort -ErrorAction Stop | Select-Object -First 1 }
  catch { return $null }
}

function Start-CampusFlowServer {
  if (Test-CampusFlowServer) { return }
  if (Get-PortListener) {
    $script:panelMessage = "8765 portu başka bir program tarafından kullanılıyor. Önce o programı kapat."
    return
  }
  if (-not (Test-Path -LiteralPath $pythonPath)) {
    $script:panelMessage = 'Python ortamı kurulamadı. start.bat dosyasını yeniden çalıştır.'
    return
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $logDirectory "server-$stamp-out.log"
  $stderrPath = Join-Path $logDirectory "server-$stamp-error.log"
  try {
    $process = Start-Process -FilePath $pythonPath `
      -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', [string]$serverPort) `
      -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    Start-Sleep -Milliseconds 300
    $process.Refresh()
    if ($process.HasExited) {
      $script:panelMessage = "Sunucu açılamadı. Ayrıntılar: $stderrPath"
      return
    }
    $processInfo = Get-Process -Id $process.Id -ErrorAction Stop
    $state = @{
      pid = $process.Id
      started_utc = $processInfo.StartTime.ToUniversalTime().ToString('o')
      stdout = $stdoutPath
      stderr = $stderrPath
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    $script:serverStdout = $stdoutPath
    $script:serverStderr = $stderrPath
    $script:panelMessage = 'CampusFlow başlatılıyor…'
  } catch {
    $script:panelMessage = "Sunucu başlatılamadı: $($_.Exception.Message)"
  }
}

function Stop-CampusFlowServer {
  $process = Get-ManagedServerProcess
  if (-not $process) {
    $script:panelMessage = 'Bu panelin başlattığı bir sunucu bulunamadı; başka bir sürece dokunmadım.'
    return
  }
  try {
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    $script:panelMessage = 'Sunucu durduruluyor…'
  } catch {
    $script:panelMessage = "Sunucu durdurulamadı: $($_.Exception.Message)"
  }
}

function Get-LanAddresses {
  try {
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } |
      Select-Object -ExpandProperty IPAddress -Unique)
  } catch { return @() }
}

function Get-RecentServerLog {
  $parts = @()
  foreach ($path in @($script:serverStdout, $script:serverStderr)) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      try { $parts += Get-Content -LiteralPath $path -Tail 12 -ErrorAction Stop } catch { }
    }
  }
  if ($parts.Count) { return ($parts -join [Environment]::NewLine) }
  return 'Sunucu kayıtları henüz oluşmadı.'
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'CampusFlow · Kontrol Paneli'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(790, 615)
$form.MinimumSize = New-Object System.Drawing.Size(790, 615)
$form.MaximumSize = New-Object System.Drawing.Size(790, 615)
$form.BackColor = [Drawing.Color]::FromArgb(244, 247, 251)
$form.Font = New-Object Drawing.Font('Segoe UI', 9)

$header = New-Object System.Windows.Forms.Panel
$header.Location = New-Object Drawing.Point(0, 0)
$header.Size = New-Object Drawing.Size(790, 78)
$header.BackColor = [Drawing.Color]::FromArgb(24, 34, 55)
$form.Controls.Add($header)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'CampusFlow'
$title.Location = New-Object Drawing.Point(24, 13)
$title.Size = New-Object Drawing.Size(260, 32)
$title.ForeColor = [Drawing.Color]::White
$title.Font = New-Object Drawing.Font('Segoe UI Semibold', 19)
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Sunucu kontrol paneli'
$subtitle.Location = New-Object Drawing.Point(27, 48)
$subtitle.Size = New-Object Drawing.Size(300, 20)
$subtitle.ForeColor = [Drawing.Color]::FromArgb(194, 204, 222)
$header.Controls.Add($subtitle)

$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Location = New-Object Drawing.Point(22, 94)
$statusPanel.Size = New-Object Drawing.Size(730, 82)
$statusPanel.BackColor = [Drawing.Color]::White
$statusPanel.BorderStyle = 'FixedSingle'
$form.Controls.Add($statusPanel)

$statusTitle = New-Object System.Windows.Forms.Label
$statusTitle.Text = '● Sunucu kontrol ediliyor…'
$statusTitle.Location = New-Object Drawing.Point(17, 12)
$statusTitle.Size = New-Object Drawing.Size(680, 27)
$statusTitle.Font = New-Object Drawing.Font('Segoe UI Semibold', 14)
$statusTitle.ForeColor = [Drawing.Color]::FromArgb(79, 91, 112)
$statusPanel.Controls.Add($statusTitle)

$statusDescription = New-Object System.Windows.Forms.Label
$statusDescription.Text = 'Durum bilgisi alınırken bekle.'
$statusDescription.Location = New-Object Drawing.Point(19, 45)
$statusDescription.Size = New-Object Drawing.Size(695, 23)
$statusDescription.ForeColor = [Drawing.Color]::FromArgb(104, 117, 139)
$statusPanel.Controls.Add($statusDescription)

$localUrlLabel = New-Object System.Windows.Forms.Label
$localUrlLabel.Text = 'Bu bilgisayarda'
$localUrlLabel.Location = New-Object Drawing.Point(26, 194)
$localUrlLabel.Size = New-Object Drawing.Size(120, 20)
$localUrlLabel.ForeColor = [Drawing.Color]::FromArgb(91, 104, 126)
$form.Controls.Add($localUrlLabel)

$urlBox = New-Object System.Windows.Forms.TextBox
$urlBox.Text = $appUrl
$urlBox.ReadOnly = $true
$urlBox.Location = New-Object Drawing.Point(26, 216)
$urlBox.Size = New-Object Drawing.Size(598, 27)
$urlBox.BackColor = [Drawing.Color]::White
$form.Controls.Add($urlBox)

$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Text = 'Adresi kopyala'
$copyButton.Location = New-Object Drawing.Point(637, 214)
$copyButton.Size = New-Object Drawing.Size(115, 31)
$copyButton.FlatStyle = 'Flat'
$copyButton.BackColor = [Drawing.Color]::FromArgb(232, 238, 250)
$copyButton.ForeColor = [Drawing.Color]::FromArgb(55, 83, 153)
$form.Controls.Add($copyButton)
$copyButton.Add_Click({ [Windows.Forms.Clipboard]::SetText($appUrl); $script:panelMessage = 'Adres kopyalandı.' })

$lanLabel = New-Object System.Windows.Forms.Label
$lanLabel.Location = New-Object Drawing.Point(26, 251)
$lanLabel.Size = New-Object Drawing.Size(726, 22)
$lanLabel.ForeColor = [Drawing.Color]::FromArgb(104, 117, 139)
$form.Controls.Add($lanLabel)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = 'Sunucuyu başlat'
$startButton.Location = New-Object Drawing.Point(23, 289)
$startButton.Size = New-Object Drawing.Size(145, 40)
$startButton.FlatStyle = 'Flat'
$startButton.FlatAppearance.BorderSize = 0
$startButton.BackColor = [Drawing.Color]::FromArgb(49, 105, 203)
$startButton.ForeColor = [Drawing.Color]::White
$form.Controls.Add($startButton)
$startButton.Add_Click({ Start-CampusFlowServer; Update-ControlPanel })

$stopButton = New-Object System.Windows.Forms.Button
$stopButton.Text = 'Durdur'
$stopButton.Location = New-Object Drawing.Point(177, 289)
$stopButton.Size = New-Object Drawing.Size(95, 40)
$stopButton.FlatStyle = 'Flat'
$stopButton.BackColor = [Drawing.Color]::FromArgb(255, 238, 239)
$stopButton.ForeColor = [Drawing.Color]::FromArgb(179, 56, 66)
$form.Controls.Add($stopButton)
$stopButton.Add_Click({ Stop-CampusFlowServer; Update-ControlPanel })

$restartButton = New-Object System.Windows.Forms.Button
$restartButton.Text = 'Yeniden başlat'
$restartButton.Location = New-Object Drawing.Point(280, 289)
$restartButton.Size = New-Object Drawing.Size(123, 40)
$restartButton.FlatStyle = 'Flat'
$restartButton.BackColor = [Drawing.Color]::FromArgb(232, 238, 250)
$restartButton.ForeColor = [Drawing.Color]::FromArgb(55, 83, 153)
$form.Controls.Add($restartButton)
$restartButton.Add_Click({
  if (Get-ManagedServerProcess) {
    $script:restartPending = $true
    Stop-CampusFlowServer
    Update-ControlPanel
  } else {
    [Windows.Forms.MessageBox]::Show('Bu sunucu bu panel tarafından başlatılmadı. Güvenlik için başka bir işlemi durdurmadım. Sunucuyu başlattığın pencereden kapatıp yeniden dene.', 'Sunucu yeniden başlatılamadı', 'OK', 'Information') | Out-Null
  }
})

$openButton = New-Object System.Windows.Forms.Button
$openButton.Text = 'Uygulamayı aç'
$openButton.Location = New-Object Drawing.Point(411, 289)
$openButton.Size = New-Object Drawing.Size(123, 40)
$openButton.FlatStyle = 'Flat'
$openButton.BackColor = [Drawing.Color]::FromArgb(232, 238, 250)
$openButton.ForeColor = [Drawing.Color]::FromArgb(55, 83, 153)
$form.Controls.Add($openButton)
$openButton.Add_Click({ Start-Process $appUrl })

$tunnelButton = New-Object System.Windows.Forms.Button
$tunnelButton.Text = 'İnternetten paylaş'
$tunnelButton.Location = New-Object Drawing.Point(542, 289)
$tunnelButton.Size = New-Object Drawing.Size(210, 40)
$tunnelButton.FlatStyle = 'Flat'
$tunnelButton.BackColor = [Drawing.Color]::FromArgb(233, 246, 240)
$tunnelButton.ForeColor = [Drawing.Color]::FromArgb(35, 119, 88)
$form.Controls.Add($tunnelButton)
$tunnelButton.Add_Click({
  if (-not (Test-CampusFlowServer)) {
    [Windows.Forms.MessageBox]::Show('Önce sunucunun çalışmasını bekle.', 'CampusFlow henüz hazır değil', 'OK', 'Information') | Out-Null
    return
  }
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$tunnelScript`"") -WorkingDirectory $projectRoot -WindowStyle Normal | Out-Null
})

$logTitle = New-Object System.Windows.Forms.Label
$logTitle.Text = 'Sunucu kayıtları'
$logTitle.Location = New-Object Drawing.Point(26, 350)
$logTitle.Size = New-Object Drawing.Size(300, 20)
$logTitle.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
$logTitle.ForeColor = [Drawing.Color]::FromArgb(48, 60, 80)
$form.Controls.Add($logTitle)

$logsButton = New-Object System.Windows.Forms.LinkLabel
$logsButton.Text = 'Kayıt klasörünü aç'
$logsButton.Location = New-Object Drawing.Point(625, 351)
$logsButton.Size = New-Object Drawing.Size(127, 20)
$logsButton.TextAlign = 'MiddleRight'
$form.Controls.Add($logsButton)
$logsButton.Add_Click({ Start-Process explorer.exe $logDirectory })

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Location = New-Object Drawing.Point(24, 375)
$logBox.Size = New-Object Drawing.Size(728, 149)
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.WordWrap = $false
$logBox.Font = New-Object Drawing.Font('Consolas', 9)
$logBox.BackColor = [Drawing.Color]::FromArgb(255, 255, 255)
$form.Controls.Add($logBox)

$footer = New-Object System.Windows.Forms.Label
$footer.Text = 'Sunucu açıkken paneli kapatabilirsin; sunucu çalışmayı sürdürür.'
$footer.Location = New-Object Drawing.Point(25, 538)
$footer.Size = New-Object Drawing.Size(725, 23)
$footer.ForeColor = [Drawing.Color]::FromArgb(117, 129, 149)
$form.Controls.Add($footer)

function Update-ControlPanel {
  $healthy = Test-CampusFlowServer
  $managed = Get-ManagedServerProcess
  $listener = Get-PortListener
  $lanAddresses = Get-LanAddresses
  if ($lanAddresses.Count) {
    $lanLabel.Text = 'Aynı Wi-Fi ağındaki cihazlar: ' + (($lanAddresses | ForEach-Object { "http://${_}:$serverPort" }) -join '   ·   ')
  } else { $lanLabel.Text = 'Yerel ağ adresi bulunamadı. Bu bilgisayardaki bağlantı yine kullanılabilir.' }

  if ($healthy) {
    $statusTitle.Text = '● Sunucu çalışıyor'
    $statusTitle.ForeColor = [Drawing.Color]::FromArgb(31, 143, 102)
    if ($managed) { $statusDescription.Text = 'Bu kontrol paneli yönetiyor. Uygulama yerel ağdan erişime açık.' }
    else { $statusDescription.Text = 'Sunucu zaten çalışıyor; başka bir pencereden başlatıldığı için bu panel onu durdurmayacak.' }
    $startButton.Enabled = $false
    $stopButton.Enabled = [bool]$managed
    $restartButton.Enabled = [bool]$managed
    $openButton.Enabled = $true
    $tunnelButton.Enabled = $true
    $script:restartPending = $false
  } elseif ($managed) {
    $statusTitle.Text = '● Sunucu başlatılıyor…'
    $statusTitle.ForeColor = [Drawing.Color]::FromArgb(196, 134, 43)
    $statusDescription.Text = 'İlk açılışta veritabanı hazırlanıyor olabilir.'
    $startButton.Enabled = $false
    $stopButton.Enabled = $true
    $restartButton.Enabled = $true
    $openButton.Enabled = $false
    $tunnelButton.Enabled = $false
  } elseif ($listener) {
    $statusTitle.Text = '● 8765 portu kullanımda'
    $statusTitle.ForeColor = [Drawing.Color]::FromArgb(191, 71, 79)
    $statusDescription.Text = "Kontrol paneli başka bir uygulamayı kapatmadı. Portu kullanan programı kapatıp Yenile veya Başlat düğmesine bas."
    $startButton.Enabled = $false
    $stopButton.Enabled = $false
    $restartButton.Enabled = $false
    $openButton.Enabled = $false
    $tunnelButton.Enabled = $false
  } else {
    $statusTitle.Text = '● Sunucu durduruldu'
    $statusTitle.ForeColor = [Drawing.Color]::FromArgb(126, 137, 155)
    $statusDescription.Text = if ($script:panelMessage) { $script:panelMessage } else { 'Başlat düğmesine basarak CampusFlow sunucusunu aç.' }
    $startButton.Enabled = $true
    $stopButton.Enabled = $false
    $restartButton.Enabled = $false
    $openButton.Enabled = $false
    $tunnelButton.Enabled = $false
    if ($script:restartPending) {
      $script:restartPending = $false
      Start-CampusFlowServer
    }
  }
  if ($script:panelMessage -and -not $healthy -and -not $managed -and -not $listener) {
    $statusDescription.Text = $script:panelMessage
  }
  $logBox.Text = Get-RecentServerLog
  $logBox.SelectionStart = $logBox.TextLength
  $logBox.ScrollToCaret()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Update-ControlPanel })
$form.Add_Shown({
  Update-ControlPanel
  if (-not (Test-CampusFlowServer) -and -not (Get-PortListener) -and -not (Get-ManagedServerProcess)) {
    Start-CampusFlowServer
    Update-ControlPanel
  }
  $timer.Start()
})
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
[void]$form.ShowDialog()
