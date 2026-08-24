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

plist com.docklets.gateway  "<string>/bin/bash</string><string>$REPO/bin/serve.sh</string>" gateway
plist com.docklets.deployer "<string>$NODE_BIN</string><string>$REPO/bin/deployer.mjs</string>" deployer

for svc in com.docklets.gateway com.docklets.deployer; do
  launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$svc.plist"
done

echo "docklets installed."
echo "  root:    $ROOT"
echo "  gateway: http://localhost:$PORT/"
echo "  logs:    $LOGS/"
echo "Deploy something: mkdir -p $ROOT/hello && echo '<h1>hi</h1>' > $ROOT/hello/index.html"
