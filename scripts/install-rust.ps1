$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskTools = Join-Path $taskRoot '.tools'
New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
$taskInstaller = Join-Path $taskTools 'rustup-init.exe'
$taskInstallerUrl = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
Invoke-WebRequest -Uri $taskInstallerUrl -OutFile $taskInstaller
$taskDigestResponse = (Invoke-WebRequest -Uri ($taskInstallerUrl + '.sha256')).Content
$taskDigestText = if ($taskDigestResponse -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($taskDigestResponse) } else { [string]$taskDigestResponse }
$taskExpectedDigest = ($taskDigestText.Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpectedDigest) { throw 'Rustup SHA-256 doğrulaması başarısız.' }
$taskPreviousCargo = $env:CARGO_HOME
$taskPreviousRustup = $env:RUSTUP_HOME
try {
  $env:CARGO_HOME = Join-Path $taskTools 'cargo'
  $env:RUSTUP_HOME = Join-Path $taskTools 'rustup'
  & $taskInstaller -y --no-modify-path --profile minimal --default-toolchain stable
  if ($LASTEXITCODE -ne 0) { throw 'Rust kurulumu başarısız.' }
} finally {
  $env:CARGO_HOME = $taskPreviousCargo
  $env:RUSTUP_HOME = $taskPreviousRustup
}
