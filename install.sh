#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# NanoClaw Copilot Edition — One-line Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/install.sh | bash
#   # With local package:
#   bash <(curl -fsSL https://raw.githubusercontent.com/.../install.sh) --package ./file.tgz
#   # Or with local package:
#   ./install.sh --package /path/to/nanoclaw-github-copilot-1.2.19.tgz
#
# What it does:
#   1. Detects OS and architecture
#   2. Checks/installs Node.js (20+)
#   3. Installs nanoclaw-github-copilot via npm
#   4. Runs nanoclaw init
#   5. Runs nanoclaw doctor
# ============================================================

PACKAGE_NAME="nanoclaw-github-copilot"
LOCAL_PACKAGE=""
MIN_NODE_VERSION=20
REPO_URL="https://github.com/kenans/nanoclaw-github-copilot"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --package) LOCAL_PACKAGE="$2"; shift 2;;
    *) shift;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[nanoclaw]${NC} $1"; }
ok()    { echo -e "${GREEN}[nanoclaw]${NC} $1"; }
warn()  { echo -e "${YELLOW}[nanoclaw]${NC} $1"; }
error() { echo -e "${RED}[nanoclaw]${NC} $1"; }
fail()  { error "$1"; exit 1; }

# ─── Platform Detection ────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux*)
      if grep -qEi "(Microsoft|WSL)" /proc/version 2>/dev/null; then
        PLATFORM="wsl"
        info "Detected: Windows Subsystem for Linux (WSL)"
      else
        PLATFORM="linux"
        info "Detected: Linux"
      fi
      ;;
    Darwin*)
      PLATFORM="macos"
      info "Detected: macOS"
      ;;
    CYGWIN*|MINGW*|MSYS*)
      error "Native Windows is not supported."
      error "Please install WSL2 and run this script inside WSL."
      error "Guide: https://learn.microsoft.com/en-us/windows/wsl/install"
      exit 1
      ;;
    *)
      fail "Unsupported OS: $OS"
      ;;
  esac

  case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    armv7l) ARCH="armv7l" ;;
    *) warn "Unusual architecture: $ARCH — installation may not work" ;;
  esac

  info "Architecture: $ARCH"
}

# ─── Node.js Detection / Installation ──────────────────────────

check_node() {
  if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge "$MIN_NODE_VERSION" ]; then
      ok "Node.js v$(node -v | sed 's/v//') ✓"
      return 0
    else
      warn "Node.js v$(node -v | sed 's/v//') found, but v${MIN_NODE_VERSION}+ required"
      return 1
    fi
  else
    warn "Node.js not found"
    return 1
  fi
}

install_node() {
  info "Installing Node.js..."

  if command -v nvm &>/dev/null; then
    info "Using nvm..."
    nvm install 22
    nvm use 22
  elif [ "$PLATFORM" = "macos" ] && command -v brew &>/dev/null; then
    info "Using Homebrew..."
    brew install node@22
  elif [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "wsl" ]; then
    info "Using NodeSource..."
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v yum &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo yum install -y nodejs
    else
      fail "No supported package manager found. Please install Node.js manually: https://nodejs.org"
    fi
  else
    fail "Could not auto-install Node.js. Please install manually: https://nodejs.org"
  fi

  # Verify
  if ! check_node; then
    fail "Node.js installation failed. Please install manually: https://nodejs.org"
  fi
}

# ─── npm Check ─────────────────────────────────────────────────

check_npm() {
  if command -v npm &>/dev/null; then
    ok "npm v$(npm -v) ✓"
    return 0
  else
    fail "npm not found. It should come with Node.js. Please reinstall Node.js."
  fi
}

# ─── Install NanoClaw ──────────────────────────────────────────

install_nanoclaw() {
  info "Installing ${PACKAGE_NAME}..."

  # Check if already installed
  if command -v nanoclaw &>/dev/null; then
    CURRENT_VERSION=$(nanoclaw --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
    info "nanoclaw already installed (v${CURRENT_VERSION}). Upgrading..."
    if [ -n "$LOCAL_PACKAGE" ]; then
      npm install -g "$LOCAL_PACKAGE"
    else
      if [ -n "$LOCAL_PACKAGE" ]; then
      npm install -g "$LOCAL_PACKAGE"
    else
      npm install -g "${PACKAGE_NAME}@latest" 2>/dev/null || npm install -g "${PACKAGE_NAME}"
    fi
    fi
  else
    npm install -g "${PACKAGE_NAME}@latest" 2>/dev/null || npm install -g "${PACKAGE_NAME}"
  fi

  # Verify installation
  if command -v nanoclaw &>/dev/null; then
    ok "nanoclaw installed: $(nanoclaw --version 2>/dev/null || echo 'OK')"
  else
    # npm global bin might not be in PATH
    NPM_BIN=$(npm prefix -g)/bin
    if [ -x "$NPM_BIN/nanoclaw" ]; then
      warn "nanoclaw installed but not in PATH."
      warn "Add this to your shell profile (~/.bashrc or ~/.zshrc):"
      echo ""
      echo "  export PATH=\"${NPM_BIN}:\$PATH\""
      echo ""
      export PATH="${NPM_BIN}:$PATH"
    else
      fail "Installation failed. Try manually: npm install -g ${PACKAGE_NAME}"
    fi
  fi
}

# ─── Initialize Workspace ──────────────────────────────────────

init_workspace() {
  if [ -f "$HOME/.nanoclaw/nanoclaw.json" ]; then
    info "Workspace already exists at ~/.nanoclaw/"
    info "Skipping init. Run 'nanoclaw init --force' to reinitialize."
  else
    info "Initializing workspace..."
    nanoclaw init
  fi
}

# ─── Run Doctor ────────────────────────────────────────────────

run_doctor() {
  info "Running health check..."
  nanoclaw doctor || true

  # Auto-fallback to host mode if Docker unavailable
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    info "Docker available (sandbox mode supported)"
  else
    info "Docker not available — setting host mode"
    local config="$HOME/.nanoclaw/nanoclaw.json"
    if [ -f "$config" ] && command -v node &>/dev/null; then
      node -e "
        const fs = require('fs');
        const c = JSON.parse(fs.readFileSync('$config','utf-8'));
        if (c.agents && c.agents.defaults) { c.agents.defaults.mode = 'host'; }
        fs.writeFileSync('$config', JSON.stringify(c, null, 2) + '\\n');
        console.log('  Config set to host mode');
      " || true
    fi
  fi
}

# ─── Main ──────────────────────────────────────────────────────

main() {
  echo ""
  echo "  ╔═══════════════════════════════════════════╗"
  echo "  ║   NanoClaw Copilot Edition — Installer    ║"
  echo "  ╚═══════════════════════════════════════════╝"
  echo ""

  detect_platform

  if ! check_node; then
    install_node
  fi

  check_npm
  install_nanoclaw
  init_workspace
  run_doctor

  echo ""
  echo "  ╔═══════════════════════════════════════════╗"
  echo "  ║           Installation Complete! 🎉       ║"
  echo "  ╚═══════════════════════════════════════════╝"
  echo ""
  echo "  Next steps:"
  echo "    nanoclaw doctor  — check setup"
  echo "    nanoclaw start   — start service"
  echo "    nanoclaw tui     — chat in terminal"
  echo ""
  echo "  Docs: ${REPO_URL}"
  echo ""
}

main "$@"
