# memnant installer for Windows
# Usage: irm memnant.com/install.ps1 | iex
#   or:  .\install.ps1 -Prefix "C:\custom\path"

param(
    [string]$Prefix = "$env:USERPROFILE\.memnant\bin"
)

$ErrorActionPreference = "Stop"
$Repo = "peureka/memnant"

# ── Detect platform ──

$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$Binary = "memnant-win-${Arch}.exe"

# ── Fetch latest version ──

Write-Host ""
Write-Host "  memnant - installing..."
Write-Host ""

$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Version = $Release.tag_name -replace '^v', ''
$Url = "https://github.com/$Repo/releases/download/v$Version/$Binary"

Write-Host "  version:  v$Version"
Write-Host "  platform: win/$Arch"
Write-Host "  target:   $Prefix\memnant.exe"
Write-Host ""

# ── Download ──

New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
$Dest = Join-Path $Prefix "memnant.exe"
Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing

# ── PATH integration ──

$NeedsRestart = $false
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$Prefix*") {
    [Environment]::SetEnvironmentVariable("Path", "$Prefix;$CurrentPath", "User")
    Write-Host "  Added to PATH."
    $NeedsRestart = $true
}

# ── Done ──

Write-Host "  $([char]0x2713) memnant v$Version installed"
Write-Host ""

if ($NeedsRestart) {
    Write-Host "  Restart your terminal, then run 'memnant' to get started."
} else {
    Write-Host "  Run 'memnant' to get started."
}
Write-Host ""
