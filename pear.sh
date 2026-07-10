#!/bin/sh
# pear.sh — installs the pear binary over HTTPS.
# Template use: rename to <project>.sh, set `base` + `name`,
# host it, then install with: curl <domain>/<project>.sh | sh
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

dest="$HOME/.local/bin"
target="$dest/$name"

if [ -e "$target" ]; then
  echo "Refusing to overwrite $target" >&2
  echo "Remove it and rerun to reinstall." >&2
  exit 1
fi

echo "Installing $name"
mkdir -p "$dest"
curl -fsSL "$base/pear/$os-$arch/app/$name" -o "$target"
chmod 755 "$target"

case ":$PATH:" in
  *":$dest:"*) ;;
  *)
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
