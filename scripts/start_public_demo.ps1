$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
  throw 'CampusFlow Python ortamı bulunamadı. Önce start.bat dosyasını bir kez çalıştırıp kurulumun tamamlanmasını bekle.'
}

$toolsDirectory = Join-Path $env:LOCALAPPDATA 'CampusFlow\tools'
$cloudflaredPath = Join-Path $toolsDirectory 'cloudflared.exe'
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  if (-not (Test-Path -LiteralPath $cloudflaredPath)) {
    New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null
    Write-Host 'Cloudflare Tunnel resmi sürümü indiriliyor…'
    Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cloudflaredPath
  }
  $signature = Get-AuthenticodeSignature -FilePath $cloudflaredPath
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Cloudflare') {
    throw 'Cloudflare Tunnel dosyasının imzası doğrulanamadı. Dosyayı çalıştırmadım; resmi indirme sayfasından kontrol et.'
  }
  $cloudflaredCommand = $cloudflaredPath
} else {
  $cloudflaredCommand = (Get-Command cloudflared).Source
}

$serverProcess = $null
$healthUrl = 'http://127.0.0.1:8765/health'
try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
} catch {
  $env:PYTHONUTF8 = '1'
  $serverProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8765') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  $health = $null
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    if ($serverProcess.HasExited) { throw "CampusFlow sunucusu başlatılamadı (çıkış kodu $($serverProcess.ExitCode))." }
    try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2; break } catch { }
  }
  if ($health.status -ne 'ok') { throw 'CampusFlow sunucusu 30 saniyede hazır olmadı.' }
}

try {
  Write-Host ''
  Write-Host 'CampusFlow çalışıyor. Cloudflare geçici internet adresini aşağıdaki çıktıda göreceksin.' -ForegroundColor Green
  Write-Host 'Bu PowerShell penceresi ve bilgisayar açık kaldığı sürece bağlantı çalışır.'
  Write-Host 'Durdurmak için Ctrl+C kullan.'
  Write-Host ''
  & $cloudflaredCommand tunnel --url 'http://127.0.0.1:8765'
} finally {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force
  }
}
