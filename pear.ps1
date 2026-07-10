# pear.ps1 — installs the pear binary over HTTPS.
# Template use: rename to <project>.ps1, set `base` + `name`,
# host it, then install with: irm <domain>/<project>.ps1 | iex
# Origin: https://github.com/holepunchto/pear-install
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = 'Stop'

$base = 'https://install.pears.com'
$name = 'pear'

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { throw "Unsupported arch: $env:PROCESSOR_ARCHITECTURE" }
}

$dir = Join-Path $env:LOCALAPPDATA "Programs\$name"
$target = Join-Path $dir "$name.exe"

if (Test-Path $target) {
  throw "Refusing to overwrite $target`nRemove it and rerun to reinstall."
}

Write-Host "Installing $name"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Invoke-WebRequest -Uri "$base/pear/win32-$arch/app/$name.exe" -OutFile $target

$path = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = $path -split ';' | Where-Object { $_ }
if ($entries -notcontains $dir) {
  $next = if ($path) { "$path;$dir" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  Write-Host "Added $dir to User PATH — restart your shell."
}

Write-Host "Installed $name to $target"
