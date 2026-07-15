#!/bin/sh
# pear.sh — installs the pear binary over HTTPS.
# Template use: rename to <name>.sh, set `base` + `name`,
# put os-archs and checksums.sha256 under <domain>/<name>
# host it, then install with: curl <domain>/<name>.sh | sh
# Origin: https://github.com/holepunchto/pear-install
# SPDX-License-Identifier: Apache-2.0
set -e

base="https://install.pears.com"
name="pear"

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
esac

url="$base/$name/$os-$arch/app/$name"
dest="$HOME/.local/bin"
target="$dest/$name"
tmp="$HOME/.local/$name.download"

if [ -e "$target" ]; then
  echo "Refusing to overwrite $target" >&2
  echo "Remove it and rerun to reinstall." >&2
  exit 1
fi

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

echo "Installing $name"

expect=$(curl -fsSL "$base/$name/checksums.sha256" | grep "$os-$arch" | cut -d ' ' -f 1)
if [ -z "$expect" ]; then
  echo "Missing checksums.sha256 at $base/$name" >&2
  exit 1
fi

mkdir -p "$dest"
trap 'rm -f "$tmp"' EXIT INT TERM

size=$(curl -fsSLI "$url" | grep -i '^content-length:' | tail -1 | tr -dc '0-9')
mb=$((size * 10 / 1024 / 1024))
echo "Downloading $url [ $((mb / 10)).$((mb % 10)) MB ]"
curl -fL --progress-bar "$url" -o "$tmp"

actual=$(sha256 "$tmp")

if [ "$expect" != "$actual" ]; then
  printf 'Checksum mismatch for %s\nExpect: %s\nActual: %s\n' "$url" "$expect" "$actual" >&2
  exit 1
fi

echo "Checksum OK"

chmod 755 "$tmp"
mv "$tmp" "$target"
trap - EXIT INT TERM

case ":$PATH:" in
  *":$dest:"*) ;; # already in PATH, no-op
  *) # not in PATH append to shell rc
    case "$(basename "${SHELL:-sh}")" in
      zsh) rc="$HOME/.zshrc"; line="export PATH=\"\$PATH:$dest\"" ;;
      bash) rc="$HOME/.bashrc"; line="export PATH=\"\$PATH:$dest\"" ;;
      fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path $dest" ;;
      *) rc="$HOME/.profile"; line="export PATH=\"\$PATH:$dest\"" ;;
    esac
    mkdir -p "$(dirname "$rc")"
    echo "$line" >> "$rc"
    echo "Added $dest to PATH in $rc — restart your shell."
    ;;
esac

echo "Installed $name to $target"
