#!/bin/bash
# docklets gateway: hardened Caddy container serving the asset root.
#
# Static slugs are served as files; dynamic slugs (app.json) are reverse-proxied
# via route files the deployer writes into $DOCKLETS_ROOT/.gateway/routes/.
#
# Runs in the foreground (service managers restart it). Configuration (env):
#   DOCKLETS_ROOT      asset root directory     (default: $PWD)
#   DOCKLETS_PORT      published gateway port   (default: 8080)
#   DOCKLETS_NETWORK   internal docker network  (default: docklets-net)
#   DOCKLETS_GATEWAY   gateway container name   (default: docklets-gateway)
#   DOCKLETS_ACCESS    access service container (default: docklets-access). The
#                      gateway asks it about every request (private docklets,
#                      docs/access.md); it sits on an internal network,
#                      DOCKLETS_ACCESS_NETWORK (default: <network>-access),
#                      that only the gateway joins.
#   DOCKLETS_DETACH    "1" runs the container detached and exits (for CI and
#                      environments that reap a step's attached processes)
set -euo pipefail

ROOT="$(cd "${DOCKLETS_ROOT:-$PWD}" && pwd)"
PORT="${DOCKLETS_PORT:-8080}"
NET="${DOCKLETS_NETWORK:-docklets-net}"
NAME="${DOCKLETS_GATEWAY:-docklets-gateway}"
ACCESS="${DOCKLETS_ACCESS:-docklets-access}"
ACCESS_NET="${DOCKLETS_ACCESS_NETWORK:-$NET-access}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDYFILE="${DOCKLETS_CADDYFILE:-$HERE/../gateway/Caddyfile}"

mkdir -p "$ROOT/.gateway/routes" "$ROOT/.data"
[ -f "$ROOT/.gateway/routes/00-placeholder.caddy" ] || \
  printf '# placeholder so the routes glob always matches\n' > "$ROOT/.gateway/routes/00-placeholder.caddy"

docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true

# The access service: read-only, capability-free, the asset root and its key
# mounted read-only, reachable only over an internal network shared with the
# gateway (never from app containers). The key signs access cookies; it is
# created once and, like every dot-entry, never served or synced.
KEY="$ROOT/.gateway/access-key"
if [ ! -f "$KEY" ]; then
  (umask 077 && head -c 32 /dev/urandom > "$KEY.tmp" && mv "$KEY.tmp" "$KEY")
fi
docker network create --internal "$ACCESS_NET" >/dev/null 2>&1 || true
docker rm -f "$ACCESS" >/dev/null 2>&1 || true
ACCESS_ENV=()
for k in DOCKLETS_ACCESS_SECURE DOCKLETS_ACCESS_CLIENT_HEADER DOCKLETS_ACCESS_MAX_FAILS DOCKLETS_ACCESS_MAX_VERIFIES; do
  if [ -n "${!k:-}" ]; then ACCESS_ENV+=(-e "$k=${!k}"); fi
done
docker run -d --name "$ACCESS" \
  --network "$ACCESS_NET" \
  --user "$(id -u):$(id -g)" \
  --restart unless-stopped --init \
  --read-only --tmpfs /tmp:rw,mode=1777 \
  -v "$ROOT":/srv:ro \
  -v "$KEY":/run/docklets/access-key:ro \
  -v "$HERE":/opt/docklets/bin:ro \
  -e DOCKLETS_ROOT=/srv -e DOCKLETS_ACCESS_ADDR=0.0.0.0 -e DOCKLETS_ACCESS_PORT=9100 \
  -e DOCKLETS_ACCESS_KEY_FILE=/run/docklets/access-key \
  ${ACCESS_ENV[@]+"${ACCESS_ENV[@]}"} \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 128m \
  node:20-alpine node /opt/docklets/bin/access.mjs >/dev/null

GW_ARGS=(
  --rm --name "$NAME"
  --network "$NET"
  -p "$PORT:8080"
  -v "$ROOT":/srv:ro
  -v "$CADDYFILE":/etc/caddy/Caddyfile:ro
  -v "$ROOT/.gateway/routes":/etc/caddy/routes:ro
  -e DOCKLETS_ACCESS_UPSTREAM="$ACCESS:9100"
  --read-only
  --tmpfs /tmp
  --tmpfs /data
  --tmpfs /config
  --cap-drop ALL
  --cap-add NET_BIND_SERVICE
  --security-opt no-new-privileges
  --pids-limit 128
  --memory 256m
  caddy:2.11-alpine
)

# Created, then joined to the access network, then started: a container gets
# one network at run time.
docker create "${GW_ARGS[@]}" >/dev/null
docker network connect "$ACCESS_NET" "$NAME"
if [ "${DOCKLETS_DETACH:-0}" = "1" ]; then
  docker start "$NAME"
else
  exec docker start -a "$NAME"
fi
