#!/bin/bash
# docklets container entrypoint: runs the node-side stack in one container.
#
# Pairs with a plain caddy container (the gateway) that serves the same
# folder; in a pod the two share localhost. Processes here:
#   deployer   always (DOCKLETS_DRIVER defaults to none in the container)
#   receiver   when DOCKLETS_SYNC_TOKEN_HASH_FILE is set
#   connector  when the connector config file exists
# If any process exits, the container exits and the supervisor restarts it.
set -euo pipefail

ROOT="${DOCKLETS_ROOT:?DOCKLETS_ROOT is required}"
[ -d "$ROOT" ] || { echo "DOCKLETS_ROOT does not exist: $ROOT" >&2; exit 1; }
export DOCKLETS_DRIVER="${DOCKLETS_DRIVER:-none}"
export DOCKLETS_CONNECTOR_HOME="${DOCKLETS_CONNECTOR_HOME:-/opt/docklets/connector-home}"
CONNECTOR_CONF="${DOCKLETS_CONNECTOR_CONFIG:-/etc/docklets/connector.env}"

node /opt/docklets/bin/deployer.mjs &

if [ -n "${DOCKLETS_SYNC_TOKEN_HASH_FILE:-}" ]; then
  DOCKLETS_RECEIVER_ADDR="${DOCKLETS_RECEIVER_ADDR:-0.0.0.0}" \
    node /opt/docklets/bin/receiver.mjs &
fi

if [ -f "$CONNECTOR_CONF" ]; then
  DOCKLETS_CONNECTOR_CONFIG="$CONNECTOR_CONF" /opt/docklets/bin/connector.sh &
fi

wait -n
exit $?
