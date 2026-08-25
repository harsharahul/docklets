#!/bin/bash
# Install docklets as systemd user services on Linux.
#
#   ./install/install-linux.sh /path/to/asset-root [port]
#
# Uninstall: systemctl --user disable --now docklets-gateway docklets-deployer
#            rm ~/.config/systemd/user/docklets-*.service
set -euo pipefail

ROOT="${1:?usage: install-linux.sh /path/to/asset-root [port]}"
PORT="${2:-8080}"
ROOT="$(mkdir -p "$ROOT" && cd "$ROOT" && pwd)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
UNITS="$HOME/.config/systemd/user"
mkdir -p "$UNITS" "$ROOT/.gateway/logs"

[ -n "$NODE_BIN" ] || { echo "node >= 20 is required on PATH"; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon is not reachable"; exit 1; }

# Drop publishing instructions into the asset root so any coding agent opened
# there (Codex, Claude Code, Cursor, and other AGENTS.md-aware tools) knows how
# to publish without setup. CLAUDE.md is a symlink for harnesses that read that
# name. Both are hidden from public serving by the gateway. Never overwrite.
if [ ! -e "$ROOT/AGENTS.md" ]; then
  sed -e "s|<ASSETS>|$ROOT|g" -e "s|<HOST>|http://localhost:$PORT|g" \
    "$REPO/AGENTS.md" | grep -v '^>' > "$ROOT/AGENTS.md"
fi
[ -e "$ROOT/CLAUDE.md" ] || ln -s AGENTS.md "$ROOT/CLAUDE.md"

# Deploy the read-only status dashboard so the root redirect (/ -> /status/)
# always has a target. Never overwrite a dashboard the operator customized.
if [ ! -e "$ROOT/status" ]; then
  cp -R "$REPO/dashboard" "$ROOT/status"
fi

cat > "$UNITS/docklets-gateway.service" <<EOF
[Unit]
Description=docklets gateway (hardened Caddy container)
After=docker.service

[Service]
Environment=DOCKLETS_ROOT=$ROOT
Environment=DOCKLETS_PORT=$PORT
ExecStart=/bin/bash $REPO/bin/serve.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

cat > "$UNITS/docklets-deployer.service" <<EOF
[Unit]
Description=docklets deployer (manifest -> container converger)
After=docklets-gateway.service

[Service]
Environment=DOCKLETS_ROOT=$ROOT
ExecStart=$NODE_BIN $REPO/bin/deployer.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now docklets-gateway docklets-deployer

echo "docklets installed. root: $ROOT · gateway: http://localhost:$PORT/"
