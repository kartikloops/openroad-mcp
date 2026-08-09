#!/usr/bin/env bash
# =============================================================================
# setup-macos.sh — Install OpenROAD-MCP dependencies on macOS
# =============================================================================
set -euo pipefail

echo "Setting up OpenROAD-MCP on macOS..."

if [[ -z "${CI:-}" ]]; then
    read -r -p "This script will install Node.js and project dependencies. Continue? [y/N] " response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

if ! command -v node &>/dev/null || ! node --version | grep -qE "^v22\."; then
    if ! command -v brew &>/dev/null; then
        echo "Homebrew is required to install Node.js. Install it from https://brew.sh and re-run this script." >&2
        exit 1
    fi
    echo "Installing Node.js 22..."
    brew install node@22
    export PATH="$(brew --prefix node@22)/bin:$PATH"
fi

echo "Installing project dependencies..."
(cd typescript && npm ci && npm run build)

echo ""
echo "macOS setup complete."
echo ""
echo "Next steps:"
echo "  1. Install OpenROAD (optional, for full flows):"
echo "     See: https://openroad.readthedocs.io/en/latest/main/GettingStarted.html"
echo "  2. Or use Docker:    docker run --rm -i ghcr.io/the-openroad-project/openroad-mcp:latest"
echo "  3. Run tests:        make test"
echo "  4. Start MCP server: npx -y openroad-mcp"
