$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Önce proje sanal ortamını oluşturun: py -m venv .venv ve .venv\Scripts\python.exe -m pip install -r requirements.txt"
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".venv\Scripts\pyinstaller.exe"))) {
    & $python -m pip install "pyinstaller>=6.20,<7"
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller kurulamadı." }
}

$compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $compiler) {
    $possiblePaths = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 7\ISCC.exe"),
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe"
    )
    $compilerPath = $possiblePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
} else {
    $compilerPath = $compiler.Source
}
if (-not $compilerPath) { throw "Inno Setup bulunamadı. Windows'ta 'winget install --id JRSoftware.InnoSetup --scope user' komutunu çalıştırıp yeniden deneyin." }

$oldInstaller = Join-Path $projectRoot "dist\CampusFlow-Setup.exe"
$oldBundle = Join-Path $projectRoot "dist\CampusFlow"
if (Test-Path -LiteralPath $oldInstaller) { Remove-Item -LiteralPath $oldInstaller -Force }
if (Test-Path -LiteralPath $oldBundle) { Remove-Item -LiteralPath $oldBundle -Recurse -Force }

& $python -m PyInstaller --noconfirm (Join-Path $projectRoot "desktop\CampusFlow.spec")
if ($LASTEXITCODE -ne 0) { throw "CampusFlow Windows paketi oluşturulamadı." }

& $compilerPath /Qp (Join-Path $projectRoot "desktop\CampusFlow.iss")
if ($LASTEXITCODE -ne 0) { throw "CampusFlow kurulum dosyası derlenemedi." }

$downloads = Join-Path $projectRoot "downloads"
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
Copy-Item -LiteralPath $oldInstaller -Destination (Join-Path $downloads "CampusFlow-Setup.exe") -Force
Write-Host "Kurulum dosyası: $oldInstaller"
Write-Host "Web indirme dosyası: $(Join-Path $downloads 'CampusFlow-Setup.exe')"
