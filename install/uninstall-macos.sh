#!/bin/bash
# Remove the docklets launchd services and stop platform containers.
# Your asset root (sites, apps, .data) is NOT touched.
set -uo pipefail

for svc in com.docklets.gateway com.docklets.deployer; do
  launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null && echo "stopped $svc"
  rm -f "$HOME/Library/LaunchAgents/$svc.plist" && echo "removed $svc.plist"
done

docker rm -f "${DOCKLETS_GATEWAY:-docklets-gateway}" 2>/dev/null
for c in $(docker ps -aq --filter label=docklet 2>/dev/null); do docker rm -f "$c"; done
docker network rm "${DOCKLETS_NETWORK:-docklets-net}" 2>/dev/null

echo "docklets uninstalled (asset root untouched)."
