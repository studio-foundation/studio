#!/usr/bin/env pwsh
# Studio installer for Windows — downloads a standalone binary from GitHub Releases.
#
#   irm https://raw.githubusercontent.com/studio-foundation/studio/main/install.ps1 | iex
#
# Environment:
#   STUDIO_VERSION      release tag to install (default: latest)
#   STUDIO_INSTALL_DIR  install directory (default: $env:LOCALAPPDATA\Programs\studio)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest renders a progress bar per chunk in Windows PowerShell, which costs
# more than the download itself.
$ProgressPreference = 'SilentlyContinue'

$repo = 'studio-foundation/studio'
$asset = 'studio-win-x64.exe'
$installDir = if ($env:STUDIO_INSTALL_DIR) { $env:STUDIO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\studio' }

function Fail($message) {
  Write-Host "studio: $message" -ForegroundColor Red
  exit 1
}

$version = $env:STUDIO_VERSION
if (-not $version) {
  try {
    $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
  } catch {
    Fail 'could not resolve the latest release'
  }
}

$base = "https://github.com/$repo/releases/download/$version"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "studio-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Host "Downloading studio $version (win-x64)..."
  try { Invoke-WebRequest "$base/$asset" -OutFile "$tmp\$asset" } catch { Fail "no binary for win-x64 in $version" }
  try { Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS" } catch { Fail "checksum manifest missing from $version" }

  $line = Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" }
  if (-not $line) { Fail "$asset is not listed in SHA256SUMS" }
  $expected = ($line -split '\s+')[0]
  $actual = (Get-FileHash "$tmp\$asset" -Algorithm SHA256).Hash
  if ($actual -ne $expected) { Fail "checksum mismatch for $asset" }

  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  Move-Item "$tmp\$asset" (Join-Path $installDir 'studio.exe') -Force
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed studio $version to $installDir\studio.exe"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir".Trim(';'), 'User')
  Write-Host "Added $installDir to your PATH — open a new terminal, then run: studio init"
} else {
  Write-Host 'Run: studio init'
}
