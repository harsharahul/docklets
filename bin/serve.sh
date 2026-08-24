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
set -euo pipefail

ROOT="$(cd "${DOCKLETS_ROOT:-$PWD}" && pwd)"
PORT="${DOCKLETS_PORT:-8080}"
NET="${DOCKLETS_NETWORK:-docklets-net}"
NAME="${DOCKLETS_GATEWAY:-docklets-gateway}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDYFILE="${DOCKLETS_CADDYFILE:-$HERE/../gateway/Caddyfile}"

mkdir -p "$ROOT/.gateway/routes" "$ROOT/.data"
[ -f "$ROOT/.gateway/routes/00-placeholder.caddy" ] || \
  printf '# placeholder so the routes glob always matches\n' > "$ROOT/.gateway/routes/00-placeholder.caddy"

docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true

exec docker run --rm --name "$NAME" \
  --network "$NET" \
  -p "$PORT:8080" \
  -v "$ROOT":/srv:ro \
  -v "$CADDYFILE":/etc/caddy/Caddyfile:ro \
  -v "$ROOT/.gateway/routes":/etc/caddy/routes:ro \
  --read-only \
  --tmpfs /tmp \
  --tmpfs /data \
  --tmpfs /config \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 256m \
  caddy:2.11-alpine
