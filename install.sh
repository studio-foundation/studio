#!/bin/sh
# Studio installer — downloads a standalone binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/studio-foundation/studio/main/install.sh | sh
#
# Environment:
#   STUDIO_VERSION      release tag to install (default: latest)
#   STUDIO_INSTALL_DIR  install directory (default: $HOME/.local/bin)

set -eu

REPO="studio-foundation/studio"
INSTALL_DIR="${STUDIO_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "studio: $1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *)      fail "unsupported OS: $(uname -s). Install with: npm i -g @studio-foundation/cli" ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *)             fail "unsupported architecture: $(uname -m)" ;;
esac

# glibc and musl are not interchangeable; ldd names the one in use. Match musl
# positively — glibc calls itself "GLIBC" on Debian but "GNU libc" on Fedora, so a
# negative match on "glibc" hands every Fedora host the musl binary.
libc=""
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  libc="-musl"
fi

platform="${os}-${arch}${libc}"
asset="studio-${platform}"

version="${STUDIO_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" | sed 's|.*/tag/||')
  [ -n "$version" ] || fail "could not resolve the latest release"
fi

base="https://github.com/${REPO}/releases/download/${version}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading studio ${version} (${platform})..."
curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}" || fail "no binary for ${platform} in ${version}"
curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" || fail "checksum manifest missing from ${version}"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "${tmp}/${asset}" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "${tmp}/${asset}" | cut -d' ' -f1)
else
  fail "no sha256 tool available to verify the download"
fi
expected=$(grep " ${asset}\$" "${tmp}/SHA256SUMS" | cut -d' ' -f1)
[ -n "$expected" ] || fail "${asset} is not listed in SHA256SUMS"
[ "$actual" = "$expected" ] || fail "checksum mismatch for ${asset}"

mkdir -p "$INSTALL_DIR"
mv "${tmp}/${asset}" "${INSTALL_DIR}/studio"
chmod +x "${INSTALL_DIR}/studio"

echo "Installed studio ${version} to ${INSTALL_DIR}/studio"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) "${INSTALL_DIR}/studio" --version >/dev/null && echo "Run: studio init" ;;
  *) echo "Add it to your PATH:  export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
