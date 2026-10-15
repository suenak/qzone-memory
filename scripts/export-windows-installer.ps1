param(
    [Parameter(Mandatory = $true)][string]$Source,
    [string]$DestinationDirectory
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This export step requires Windows.'
}

if (-not ('QzaInstallerFileLabel' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class QzaInstallerFileLabel {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetNamedSecurityInfo(string name, int kind, uint info,
        IntPtr owner, IntPtr group, IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(
        IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string Read(string path) {
        IntPtr sacl, descriptor;
        uint error = GetNamedSecurityInfo(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero,
            IntPtr.Zero, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            IntPtr text; uint length;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 0x10, out text, out length))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            try { return Marshal.PtrToStringUni(text) ?? ""; }
            finally { LocalFree(text); }
        } finally { LocalFree(descriptor); }
    }
}
'@
}

function Assert-NormalInstallerLabel([string]$Path) {
    $label = [QzaInstallerFileLabel]::Read($Path)
    foreach ($entry in [regex]::Matches($label, '\(ML;[^)]*;;;([^;)]+)\)')) {
        $sid = $entry.Groups[1].Value
        if ($sid -in @('LW', 'UN') -or ($sid -match '^S-1-16-(\d+)$' -and [int]$Matches[1] -lt 8192)) {
            throw 'The export directory applies a low-integrity label. Choose a normal user folder such as Downloads; do not install directly from the development workspace.'
        }
    }
    return $label
}

$sourceFile = Get-Item -LiteralPath $Source
if ($sourceFile.PSIsContainer -or $sourceFile.Extension -notin @('.exe', '.msi')) {
    throw 'Source must be an existing Windows installer (.exe or .msi).'
}
if (!$DestinationDirectory) {
    $folders = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders')
    try { if ($folders) { $downloads = [string]$folders.GetValue('{374DE290-123F-4565-9164-39C4925E467B}') } }
    finally { if ($folders) { $folders.Dispose() } }
    if (!$downloads) { $downloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads' }
    $DestinationDirectory = Join-Path ([Environment]::ExpandEnvironmentVariables($downloads)) '拾忆安装包'
}
New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
$destinationRoot = (Get-Item -LiteralPath $DestinationDirectory).FullName
$null = Assert-NormalInstallerLabel $destinationRoot
$destination = Join-Path $destinationRoot $sourceFile.Name
if ($sourceFile.FullName -eq $destination) { throw 'Source and exported installer must be different files.' }

# Create a fresh file in the destination. Merely overwriting an existing file can
# retain its old integrity label. No ACL or integrity label is changed by this script.
$stagedFile = Join-Path $destinationRoot ('.qza-export-' + [Guid]::NewGuid().ToString('N') + $sourceFile.Extension)
try {
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $stagedFile
    $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
    $exportHash = (Get-FileHash -LiteralPath $stagedFile -Algorithm SHA256).Hash
    if ($sourceHash -ne $exportHash) { throw 'Installer export checksum mismatch.' }
    $label = Assert-NormalInstallerLabel $stagedFile
    Move-Item -LiteralPath $stagedFile -Destination $destination -Force
    $null = Assert-NormalInstallerLabel $destination
    [pscustomobject]@{ Path = $destination; Bytes = (Get-Item -LiteralPath $destination).Length; Sha256 = $exportHash; IntegrityLabel = $label }
} finally {
    if (Test-Path -LiteralPath $stagedFile) { Remove-Item -LiteralPath $stagedFile }
}
