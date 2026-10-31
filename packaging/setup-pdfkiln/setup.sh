#!/usr/bin/env bash
# The setup-pdfkiln action: the release archive of the runner's platform,
# checked against the release's SHA256SUMS, unpacked in the tool cache, its
# programs put on the PATH. Linux x64 and ARM64, macOS ARM64, Windows x64
# (ARM in emulation).
#
#   PDFKILN_VERSION=<version|latest> [PDFKILN_TOKEN=<token>] setup.sh
set -euo pipefail
repo=https://github.com/pdfkiln/pdfkiln
version="${PDFKILN_VERSION:-latest}"
if [ "$version" = latest ]; then
  api=https://api.github.com/repos/pdfkiln/pdfkiln/releases/latest
  if [ -n "${PDFKILN_TOKEN:-}" ]; then json=$(curl -fsSL -H "Authorization: Bearer $PDFKILN_TOKEN" "$api"); else json=$(curl -fsSL "$api"); fi
  version=$(printf '%s\n' "$json" | sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || { echo "::error::no latest release of pdfkiln found"; exit 1; }
fi

case "${RUNNER_OS:-$(uname -s)}-${RUNNER_ARCH:-$(uname -m)}" in
  Linux-X64 | Linux-x86_64) platform=linux-x64 ext=tar.gz ;;
  Linux-ARM64 | Linux-aarch64) platform=linux-arm64 ext=tar.gz ;;
  macOS-ARM64 | Darwin-arm64) platform=macos-arm64 ext=tar.gz ;;
  Windows-X64 | Windows-ARM64 | MINGW*) platform=windows-x64 ext=zip ;;
  *) echo "::error::pdfkiln has no build for ${RUNNER_OS:-$(uname -s)} on ${RUNNER_ARCH:-$(uname -m)}"; exit 1 ;;
esac
file="pdfkiln-$version-$platform.$ext"
dest="${RUNNER_TOOL_CACHE:-${RUNNER_TEMP:-/tmp}}/pdfkiln/$version/$platform"

if [ ! -e "$dest/.complete" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$file" "$repo/releases/download/$version/$file" \
    || { echo "::error::no $file in the releases of pdfkiln: $repo/releases"; exit 1; }
  curl -fsSL -o "$tmp/SHA256SUMS" "$repo/releases/download/$version/SHA256SUMS"
  sum=$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$sum" ] || { echo "::error::$file is not in the SHA256SUMS of pdfkiln $version"; exit 1; }
  if command -v sha256sum > /dev/null; then got=$(sha256sum "$tmp/$file" | cut -d ' ' -f 1); else got=$(shasum -a 256 "$tmp/$file" | cut -d ' ' -f 1); fi
  [ "$got" = "$sum" ] || { echo "::error::$file: SHA-256 $got, where the release says $sum"; exit 1; }
  rm -rf "$dest" && mkdir -p "$dest"
  if [ "$ext" = zip ]; then unzip -q "$tmp/$file" -d "$dest"; else tar -xzf "$tmp/$file" -C "$dest" --strip-components=1; fi
  touch "$dest/.complete"
  rm -rf "$tmp"
fi
bin="$dest"
[ "$platform" = windows-x64 ] && bin="$dest/wkhtmltopdf/bin"

# Ubuntu 23.10 and later refuse unprivileged user namespaces, which
# Chromium's sandbox needs, to programs no AppArmor profile allows.
if [ "${platform%-*}" = linux ] && [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2> /dev/null || echo 0)" = 1 ]; then
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile pdfkiln-chromium %s flags=(unconfined) {\n  userns,\n}\n' "$bin/chromium/chrome-headless-shell" \
    | sudo tee /etc/apparmor.d/pdfkiln-chromium > /dev/null
  sudo apparmor_parser -r /etc/apparmor.d/pdfkiln-chromium
fi

"$bin/wkhtmltopdf" --version
[ "$platform" = windows-x64 ] && bin=$(cygpath -w "$bin")
[ -n "${GITHUB_PATH:-}" ] && echo "$bin" >> "$GITHUB_PATH"
[ -n "${GITHUB_OUTPUT:-}" ] && { echo "version=$version"; echo "path=$bin"; } >> "$GITHUB_OUTPUT"
exit 0
