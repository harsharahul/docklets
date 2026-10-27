#!/bin/bash
# Install docklets as launchd user services on macOS.
#
#   ./install/install-macos.sh /path/to/asset-root [port]
#
# Writes two LaunchAgents (gateway + deployer), RunAtLoad + KeepAlive, and
# bootstraps them now. Re-run to update. Uninstall: ./install/uninstall-macos.sh
set -euo pipefail

ROOT="${1:?usage: install-macos.sh /path/to/asset-root [port]}"
PORT="${2:-8080}"
ROOT="$(mkdir -p "$ROOT" && cd "$ROOT" && pwd)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
DOCKER_DIR="$(dirname "$(command -v docker)")"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$ROOT/.gateway/logs"
mkdir -p "$AGENTS" "$LOGS"

[ -n "$NODE_BIN" ] || { echo "node >= 20 is required on PATH"; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon is not reachable"; exit 1; }

plist() { # $1 label, $2 program-args-xml, $3 logbase
cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$1</string>
    <key>ProgramArguments</key><array>$2</array>
    <key>WorkingDirectory</key><string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$DOCKER_DIR:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
        <key>DOCKLETS_ROOT</key><string>$ROOT</string>
        <key>DOCKLETS_PORT</key><string>$PORT</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOGS/$3.log</string>
    <key>StandardErrorPath</key><string>$LOGS/$3.error.log</string>
</dict>
</plist>
EOF
}

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

plist com.docklets.gateway  "<string>/bin/bash</string><string>$REPO/bin/serve.sh</string>" gateway
plist com.docklets.deployer "<string>$NODE_BIN</string><string>$REPO/bin/deployer.mjs</string>" deployer

# The tunnel connector is opt-in: it becomes a service only once its config
# exists (bin/connector.sh writes the template on first run).
SERVICES="com.docklets.gateway com.docklets.deployer"
if [ -f "$HOME/.config/docklets/connector.env" ]; then
  plist com.docklets.connector "<string>/bin/bash</string><string>$REPO/bin/connector.sh</string>" connector
  SERVICES="$SERVICES com.docklets.connector"
fi

for svc in $SERVICES; do
  launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$svc.plist"
done

# Automatic updates are opt-in: a nightly job between 3 and 5 am runs
# install/update.sh, which moves to the newest release and rolls back if the
# gateway does not come back. The choice is kept for later re-runs.
CONF="$HOME/.config/docklets"
mkdir -p "$CONF"
AUTO_UPDATE="${DOCKLETS_AUTO_UPDATE:-$(sed -n 's/^DOCKLETS_AUTO_UPDATE=//p' "$CONF/install.env" 2>/dev/null)}"
[ "$AUTO_UPDATE" = "1" ] || AUTO_UPDATE=0
printf 'DOCKLETS_ROOT=%s\nDOCKLETS_PORT=%s\nDOCKLETS_AUTO_UPDATE=%s\n' "$ROOT" "$PORT" "$AUTO_UPDATE" > "$CONF/install.env"
if [ "$AUTO_UPDATE" = "1" ]; then
  cat > "$AGENTS/com.docklets.updater.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.docklets.updater</string>
    <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/install/update.sh</string><string>--auto</string></array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$(dirname "$NODE_BIN"):$DOCKER_DIR:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>$((3 + RANDOM % 2))</integer><key>Minute</key><integer>$((RANDOM % 60))</integer></dict>
    <key>StandardOutPath</key><string>$LOGS/updater.log</string>
    <key>StandardErrorPath</key><string>$LOGS/updater.log</string>
</dict>
</plist>
EOF
  # An update re-runs this installer from the updater job itself; reloading
  # that job would stop the update halfway, so it keeps its loaded schedule.
  if [ -z "${DOCKLETS_UPDATE_RUNNING:-}" ]; then
    launchctl bootout "gui/$(id -u)/com.docklets.updater" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.docklets.updater.plist"
  fi
else
  launchctl bootout "gui/$(id -u)/com.docklets.updater" 2>/dev/null || true
  rm -f "$AGENTS/com.docklets.updater.plist"
fi

echo "docklets installed."
echo "  root:    $ROOT"
echo "  gateway: http://localhost:$PORT/"
echo "  logs:    $LOGS/"
if [ "$AUTO_UPDATE" = "1" ]; then
  echo "  updates: automatic, nightly (log: $LOGS/updater.log)"
else
  echo "  updates: run $REPO/install/update.sh, or re-run setup to turn on automatic updates"
fi
echo "Deploy something: mkdir -p $ROOT/hello && echo '<h1>hi</h1>' > $ROOT/hello/index.html"
