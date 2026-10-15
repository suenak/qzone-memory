$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$health = Invoke-RestMethod 'http://127.0.0.1:8787/api/v1/health' -TimeoutSec 5
if (!$health.ok) { throw 'Local license service must be healthy before building.' }

# The local service signs tokens with its own keypair, so a build that talks to it has to carry
# the matching public key. src-tauri/qza.config.local.json holds the production key, so without
# this override the client would start fine and then reject every token the local service issues.
$serverRoot = if ($env:QZA_LICENSE_SERVER_REPO) { $env:QZA_LICENSE_SERVER_REPO } else { Join-Path (Split-Path $projectRoot -Parent) 'license-server' }
$localKeyPath = Join-Path $serverRoot 'secrets/license_public.pem'
if (!(Test-Path -LiteralPath $localKeyPath)) {
    throw "Local licence public key not found at $localKeyPath. Generate one with 'npm run gen-keys' in the licence server, or point QZA_LICENSE_SERVER_REPO at it."
}
$localKey = ([IO.File]::ReadAllText($localKeyPath) -replace "`r`n", "`n").Trim()
$localKeyBody = ($localKey -split "`n" | Where-Object { $_ -notmatch '----' } | ForEach-Object { $_.Trim() }) -join ''
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vsPath) { throw 'MSVC Build Tools missing.' }
$devCmd = Join-Path $vsPath 'Common7/Tools/VsDevCmd.bat'
$savedPath = $env:PATH
$savedServer = $env:QZA_LICENSE_SERVER
$savedKey = $env:QZA_LICENSE_PUBLIC_KEY
$cargoManifest = Join-Path $projectRoot 'src-tauri/Cargo.toml'
$originalManifest = [IO.File]::ReadAllBytes($cargoManifest)
try {
    $env:PATH = (Join-Path $env:USERPROFILE '.cargo/bin') + ';' + $env:PATH
    $env:QZA_LICENSE_SERVER = 'http://127.0.0.1:8787'
    $env:QZA_LICENSE_PUBLIC_KEY = $localKey
    Push-Location $projectRoot
    try {
        & cmd.exe /d /c ('call "' + $devCmd + '" -arch=x64 -host_arch=x64 && npm run tauri:build:windows')
        if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed.' }
    } finally { Pop-Location }
    $nativeBinary = Join-Path $projectRoot 'src-tauri/target/release/qzonearchive.exe'
    $nativeText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($nativeBinary))
    if (!$nativeText.Contains($env:QZA_LICENSE_SERVER)) { throw 'Compiled client does not contain the local license URL.' }
    if (!$nativeText.Contains($localKeyBody)) { throw 'Compiled client does not contain the local licence public key.' }
    $package = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
    $tauriConfig = Get-Content (Join-Path $projectRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
    $bundleDir = Join-Path $projectRoot 'src-tauri/target/release/bundle/nsis'
    $source = Join-Path $bundleDir "$($tauriConfig.productName)_$($package.version)_x64-setup.exe"
    $destination = Join-Path $bundleDir "qzone-memory_$($package.version)_x64-local-setup.exe"
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $export = & (Join-Path $PSScriptRoot 'export-windows-installer.ps1') -Source $destination
    $destination = $export.Path
    $reportDir = Join-Path $projectRoot 'build-output/local'
    New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
    @{ built = (Get-Date).ToString('o'); server = $env:QZA_LICENSE_SERVER; installer = $destination; bytes = (Get-Item -LiteralPath $destination).Length; sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash } | ConvertTo-Json | Set-Content (Join-Path $reportDir 'manifest.json') -Encoding UTF8
    Write-Host "Local installer: $destination"
} finally {
    $env:PATH = $savedPath
    $env:QZA_LICENSE_SERVER = $savedServer
    $env:QZA_LICENSE_PUBLIC_KEY = $savedKey
    # Tauri may normalize Cargo.toml line endings; restore only when content is identical.
    $current = [IO.File]::ReadAllText($cargoManifest).Replace("`r`n", "`n")
    $previous = [Text.Encoding]::UTF8.GetString($originalManifest).Replace("`r`n", "`n")
    if ($current -eq $previous) { [IO.File]::WriteAllBytes($cargoManifest, $originalManifest) }
}
