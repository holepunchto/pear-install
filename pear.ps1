# pear.ps1 — installs the pear binary over HTTPS.
# Template use: rename to <name>.ps1, set `base` + `name`,
# put os-archs and checksums.sha256 under <domain>/<name>
# host it, then install with: irm <domain>/<name>.ps1 | iex
# Origin: https://github.com/holepunchto/pear-install
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = 'Stop'

$base = 'https://install.pears.com'
$name = 'pear'

$url = "$base/$name/win32-x64/app/$name.exe"
$dir = Join-Path $env:LOCALAPPDATA "Programs\$name"
$target = Join-Path $dir "$name.exe"
$tmp = Join-Path $env:LOCALAPPDATA "Temp\$name.download.exe"

if (Test-Path $target) {
  throw "Refusing to overwrite $target`nRemove it and rerun to reinstall."
}

Write-Host "Installing $name"

$sums = Invoke-RestMethod -Uri "$base/$name/checksums.sha256"
$expect = $sums -split "`n" | Where-Object { $_ -match "win32-x64" } | ForEach-Object { ($_ -split '\s+')[0] }
if (-not $expect) {
  throw "Missing checksums.sha256 at $base/$name"
}

try {
  if (Test-Path $tmp) { Remove-Item -Force $tmp }
  Start-BitsTransfer -Source $url -Destination $tmp -Description "Downloading $name"

  $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash
  if ($expect -ne $actual) {
    throw "Checksum mismatch for $url`nExpect: $expect`nActual: $actual"
  }

  Write-Host "Checksum OK"

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Move-Item -Force $tmp $target
} finally {
  if (Test-Path $tmp) { Remove-Item -Force $tmp }
}

$path = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = $path -split ';' | Where-Object { $_ }
if ($entries -notcontains $dir) {
  $next = if ($path) { "$path;$dir" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  Write-Host "Added $dir to User PATH - restart your shell."
}

Write-Host "Installed $name to $target"
