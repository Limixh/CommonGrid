# Public certificate only. Fixed provider, verified Windows TLS and installed Root.
# This does not read credentials, export keys or change a Windows trust store.
[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows trust export requires PowerShell 7 on Windows' }
$endpoint = 'api.anthropic.com'
$client = [System.Net.Sockets.TcpClient]::new()
$tls = $null
$chain = $null
try {
    [void]$client.ConnectAsync($endpoint, 443).WaitAsync([TimeSpan]::FromSeconds(15)).GetAwaiter().GetResult()
    $tls = [System.Net.Security.SslStream]::new($client.GetStream(), $false)
    # No custom validation callback. Windows verifies hostname and chain.
    [void]$tls.AuthenticateAsClientAsync($endpoint).WaitAsync([TimeSpan]::FromSeconds(15)).GetAwaiter().GetResult()
    $peer = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($tls.RemoteCertificate)
    $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    # Matches SslStream's default revocation setting; TLS verification stays on.
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    if (-not $chain.Build($peer)) { throw 'Windows chain verification failed' }
    $rootCertificate = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
    $installed = @(Get-ChildItem -LiteralPath Cert:\CurrentUser\Root, Cert:\LocalMachine\Root) | Where-Object { $_.Thumbprint -eq $rootCertificate.Thumbprint }
    if (-not $installed -or $rootCertificate.Subject -ne $rootCertificate.Issuer) { throw 'Verified chain root is not installed' }
    $publicDer = $rootCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    $fingerprint = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($publicDer)).ToLowerInvariant()
    if ($CheckOnly) { Write-Output 'Windows TLS and installed public Root verified; no files written.'; return }
    $base64 = [Convert]::ToBase64String($publicDer, [Base64FormattingOptions]::InsertLineBreaks).Replace("`r`n", "`n")
    $pem = "-----BEGIN CERTIFICATE-----`n$base64`n-----END CERTIFICATE-----`n"
    $outputDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.local/managed-session'))
    [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
    $pemPath = Join-Path $outputDirectory 'claude-windows-root.pem'
    if ([IO.File]::Exists($pemPath)) {
        $existingDer = [Convert]::FromBase64String(([IO.File]::ReadAllText($pemPath) -replace '-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s', ''))
        $existing = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($existingDer)
        if ([Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($existing.RawData)).ToLowerInvariant() -ne $fingerprint) { throw 'Existing root differs; review before replacing it' }
    } else { [IO.File]::WriteAllText($pemPath, $pem, [Text.UTF8Encoding]::new($false)) }
    $pemFingerprint = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($pemPath))).ToLowerInvariant()
    $proof = @{windows_tls_verified=$true; installed_root=$true; private_key_exported=$false; purpose='managed_claude_optional_public_root'; certificate_sha256=$fingerprint; pem_sha256=$pemFingerprint; endpoint="${endpoint}:443"; source='operator_verified_tls_chain_and_installed_root'; checked_at=[DateTime]::UtcNow.ToString('o')}
    [IO.File]::WriteAllText((Join-Path $outputDirectory 'claude-windows-root.proof.json'), ($proof | ConvertTo-Json) + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output 'Verified public Windows root saved locally; no private key exported.'
} finally {
    if ($chain) { $chain.Dispose() }
    if ($tls) { $tls.Dispose() }
    $client.Dispose()
}
