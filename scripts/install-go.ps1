$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskTools = Join-Path $taskRoot '.tools'
New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
$taskReleases = Invoke-RestMethod -Uri 'https://go.dev/dl/?mode=json'
$taskRelease = $taskReleases | Where-Object stable | Select-Object -First 1
$taskArchive = $taskRelease.files | Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'amd64' -and $_.kind -eq 'archive' }
$taskZip = Join-Path $taskTools $taskArchive.filename
Invoke-WebRequest -Uri ('https://go.dev/dl/' + $taskArchive.filename) -OutFile $taskZip
$taskDigest = (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($taskDigest -ne $taskArchive.sha256) { throw 'Go arşivi SHA-256 doğrulamasından geçemedi.' }
if (Test-Path -LiteralPath (Join-Path $taskTools 'go')) { throw '.tools/go zaten var; mevcut kuruluma dokunulmadı.' }
Expand-Archive -LiteralPath $taskZip -DestinationPath $taskTools
& (Join-Path $taskTools 'go/bin/go.exe') version
