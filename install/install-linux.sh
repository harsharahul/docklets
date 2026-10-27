#!/bin/bash
# Install docklets as systemd user services on Linux.
#
#   ./install/install-linux.sh /path/to/asset-root [port]
#
# Uninstall: systemctl --user disable --now docklets-gateway docklets-deployer docklets-updater.timer
#            rm ~/.config/systemd/user/docklets-*.service ~/.config/systemd/user/docklets-*.timer
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
  sed -e "s|<ASSETS>|$ROOT|g" -e "s|<HOST>|http://localhost:$PORT|g" -e "s|<DOCKLETS>|$REPO|g" \
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

# The tunnel connector is opt-in: it becomes a service only once its config
# exists (bin/connector.sh writes the template on first run).
UNITS_TO_ENABLE="docklets-gateway docklets-deployer"
if [ -f "$HOME/.config/docklets/connector.env" ]; then
  cat > "$UNITS/docklets-connector.service" <<EOF
[Unit]
Description=docklets tunnel connector (public URL, data stays local)
After=docklets-gateway.service

[Service]
ExecStart=/bin/bash $REPO/bin/connector.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  UNITS_TO_ENABLE="$UNITS_TO_ENABLE docklets-connector"
fi

# Automatic updates are opt-in: a nightly timer between 3 and 5 am runs
# install/update.sh, which moves to the newest release and rolls back if the
# gateway does not come back. The choice is kept for later re-runs.
CONF="$HOME/.config/docklets"
mkdir -p "$CONF"
AUTO_UPDATE="${DOCKLETS_AUTO_UPDATE:-$(sed -n 's/^DOCKLETS_AUTO_UPDATE=//p' "$CONF/install.env" 2>/dev/null)}"
[ "$AUTO_UPDATE" = "1" ] || AUTO_UPDATE=0
printf 'DOCKLETS_ROOT=%s\nDOCKLETS_PORT=%s\nDOCKLETS_AUTO_UPDATE=%s\n' "$ROOT" "$PORT" "$AUTO_UPDATE" > "$CONF/install.env"
if [ "$AUTO_UPDATE" = "1" ]; then
  cat > "$UNITS/docklets-updater.service" <<EOF
[Unit]
Description=docklets updater (newest release, rolls back on failure)

[Service]
Type=oneshot
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $REPO/install/update.sh --auto
EOF
  cat > "$UNITS/docklets-updater.timer" <<EOF
[Unit]
Description=docklets nightly update check

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=2h
Persistent=true

[Install]
WantedBy=timers.target
EOF
fi

systemctl --user daemon-reload
# shellcheck disable=SC2086  # word-splitting the unit list is intended
systemctl --user enable $UNITS_TO_ENABLE
# Re-running is how changes (and updates) apply, so running services restart.
# shellcheck disable=SC2086
systemctl --user restart $UNITS_TO_ENABLE
if [ "$AUTO_UPDATE" = "1" ]; then
  systemctl --user enable --now docklets-updater.timer
else
  systemctl --user disable --now docklets-updater.timer 2>/dev/null || true
  rm -f "$UNITS/docklets-updater.service" "$UNITS/docklets-updater.timer"
fi

echo "docklets installed. root: $ROOT · gateway: http://localhost:$PORT/"
if [ "$AUTO_UPDATE" = "1" ]; then
  echo "updates: automatic, nightly (journalctl --user -u docklets-updater)"
else
  echo "updates: run $REPO/install/update.sh, or re-run setup to turn on automatic updates"
fi
