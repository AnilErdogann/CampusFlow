$ErrorActionPreference = 'Stop'
$adminEmail = 'admin@gmail.com'
if ($env:CAMPUSFLOW_DATA_DIR) {
  $dataDirectory = [IO.Path]::GetFullPath($env:CAMPUSFLOW_DATA_DIR)
} else {
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
  $dataDirectory = Join-Path $localAppData 'CampusFlow'
}
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$envPath = Join-Path $dataDirectory '.env'
$lines = if (Test-Path -LiteralPath $envPath) { @(Get-Content -LiteralPath $envPath) } else { @() }
$found = $false
for ($index = 0; $index -lt $lines.Count; $index++) {
  if ($lines[$index] -match '^\s*ADMIN_EMAIL\s*=') {
    $lines[$index] = "ADMIN_EMAIL=$adminEmail"
    $found = $true
    break
  }
}
if (-not $found) { $lines += "ADMIN_EMAIL=$adminEmail" }
$encoding = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllLines($envPath, [string[]]$lines, $encoding)
