#!/bin/sh
set -e

# memnant installer
# Usage: curl -fsSL memnant.com/install.sh | sh
#   or:  curl -fsSL memnant.com/install.sh | sh -s -- --prefix /custom/path

REPO="peureka/memnant"
PREFIX="${HOME}/.memnant/bin"

# ── Parse args ──

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    *) echo "Usage: $0 [--prefix /custom/path]" >&2; exit 1 ;;
  esac
done

# ── Detect downloader ──

DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget"
else
  echo "Error: curl or wget is required but neither is installed." >&2
  exit 1
fi

download_file() {
  url="$1"
  output="$2"
  if [ "$DOWNLOADER" = "curl" ]; then
    if [ -n "$output" ]; then
      curl -fsSL -o "$output" "$url"
    else
      curl -fsSL "$url"
    fi
  else
    if [ -n "$output" ]; then
      wget -q -O "$output" "$url"
    else
      wget -q -O - "$url"
    fi
  fi
}

# ── Detect platform ──

case "$(uname -s)" in
  Darwin)  OS="darwin" ;;
  Linux)   OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "On Windows, use PowerShell instead:" >&2
    echo "  irm memnant.com/install.sh.ps1 | iex" >&2
    exit 1 ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Detect Rosetta 2 — prefer native arm64 binary on Apple Silicon
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    ARCH="arm64"
  fi
fi

BINARY="memnant-${OS}-${ARCH}"

# ── Fetch latest version ──

echo ""
echo "  memnant — installing..."
echo ""

LATEST=$(download_file "https://api.github.com/repos/${REPO}/releases/latest" "" | grep '"tag_name"' | sed 's/.*"v\(.*\)".*/\1/')
if [ -z "$LATEST" ]; then
  echo "Error: failed to fetch latest release from GitHub." >&2
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/v${LATEST}/${BINARY}"

echo "  version:  v${LATEST}"
echo "  platform: ${OS}/${ARCH}"
echo "  target:   ${PREFIX}/memnant"
echo ""

# ── Download ──

mkdir -p "$PREFIX"

TMP_FILE=$(mktemp)
trap 'rm -f "$TMP_FILE"' EXIT

if ! download_file "$URL" "$TMP_FILE"; then
  echo "Error: download failed." >&2
  exit 1
fi

mv "$TMP_FILE" "${PREFIX}/memnant"
chmod +x "${PREFIX}/memnant"

# ── Shell integration ──

add_to_path() {
  SHELL_NAME="$(basename "${SHELL:-sh}")"
  case "$SHELL_NAME" in
    zsh)  RC="$HOME/.zshrc" ;;
    bash) RC="$HOME/.bashrc" ;;
    fish) RC="$HOME/.config/fish/config.fish" ;;
    *)    RC="$HOME/.profile" ;;
  esac

  if [ -f "$RC" ] && grep -q "$PREFIX" "$RC" 2>/dev/null; then
    return 0
  fi

  if [ "$SHELL_NAME" = "fish" ]; then
    mkdir -p "$(dirname "$RC")"
    printf '\n# memnant\nfish_add_path %s\n' "$PREFIX" >> "$RC"
  else
    printf '\n# memnant\nexport PATH="%s:$PATH"\n' "$PREFIX" >> "$RC"
  fi

  echo "  Added to PATH in ${RC}"
  NEEDS_SOURCE="$RC"
}

if ! echo "$PATH" | tr ':' '\n' | grep -q "^${PREFIX}$"; then
  add_to_path
fi

# ── Done ──

echo "  ✓ memnant v${LATEST} installed"
echo ""

if [ -n "$NEEDS_SOURCE" ]; then
  echo "  To start using memnant, run:"
  echo ""
  echo "    source ${NEEDS_SOURCE}"
  echo ""
else
  echo "  Run 'memnant' to get started."
  echo ""
fi
