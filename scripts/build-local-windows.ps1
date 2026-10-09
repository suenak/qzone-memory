$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$health = Invoke-RestMethod 'http://127.0.0.1:8787/api/v1/health' -TimeoutSec 5
if (!$health.ok) { throw 'Local license service must be healthy before building.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vsPath) { throw 'MSVC Build Tools missing.' }
$devCmd = Join-Path $vsPath 'Common7/Tools/VsDevCmd.bat'
$savedPath = $env:PATH
$savedServer = $env:QZA_LICENSE_SERVER
$cargoManifest = Join-Path $projectRoot 'src-tauri/Cargo.toml'
$originalManifest = [IO.File]::ReadAllBytes($cargoManifest)
try {
    $env:PATH = (Join-Path $env:USERPROFILE '.cargo/bin') + ';' + $env:PATH
    $env:QZA_LICENSE_SERVER = 'http://127.0.0.1:8787'
    Push-Location $projectRoot
    try {
        & cmd.exe /d /c ('call "' + $devCmd + '" -arch=x64 -host_arch=x64 && npm run tauri:build:windows')
        if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed.' }
    } finally { Pop-Location }
    $nativeBinary = Join-Path $projectRoot 'src-tauri/target/release/qzonearchive.exe'
    $nativeText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($nativeBinary))
    if (!$nativeText.Contains($env:QZA_LICENSE_SERVER)) { throw 'Compiled client does not contain the local license URL.' }
    $package = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
    $bundleDir = Join-Path $projectRoot 'src-tauri/target/release/bundle/nsis'
    $source = Join-Path $bundleDir "QQ Zone Restore Archive_$($package.version)_x64-setup.exe"
    $destination = Join-Path $bundleDir "QQ Zone Restore Archive_$($package.version)_x64-local-setup.exe"
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $reportDir = Join-Path $projectRoot 'build-output/local'
    New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
    @{ built = (Get-Date).ToString('o'); server = $env:QZA_LICENSE_SERVER; installer = $destination; bytes = (Get-Item -LiteralPath $destination).Length; sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash } | ConvertTo-Json | Set-Content (Join-Path $reportDir 'manifest.json') -Encoding UTF8
    Write-Host "Local installer: $destination"
} finally {
    $env:PATH = $savedPath
    $env:QZA_LICENSE_SERVER = $savedServer
    # Tauri may normalize Cargo.toml line endings; restore only when content is identical.
    $current = [IO.File]::ReadAllText($cargoManifest).Replace("`r`n", "`n")
    $previous = [Text.Encoding]::UTF8.GetString($originalManifest).Replace("`r`n", "`n")
    if ($current -eq $previous) { [IO.File]::WriteAllBytes($cargoManifest, $originalManifest) }
}
