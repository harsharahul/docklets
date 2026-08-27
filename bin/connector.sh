#!/bin/bash
# docklets connector: gives a self-hosted asset root a public URL through any
# frp-compatible tunnel edge, while files, containers, and data stay local.
#
# The connector dials OUT (works behind NAT and CGNAT; no inbound ports are
# opened) and forwards edge traffic to the LOCAL GATEWAY ONLY. It refuses to
# forward the admin plane: the admin port stays reachable solely from this
# machine, tunnel or no tunnel.
#
# The tunnel credential is an INGRESS credential: leaking it lets someone
# impersonate this tunnel's route. It cannot write files, deploy anything, or
# read anything. It lives outside the asset root, like the admin token, so
# agents and apps can never touch it.
#
# Configuration: ~/.config/docklets/connector.env (created as a template on
# first run; chmod 0600), with:
#   TUNNEL_SERVER=edge.example.com   # frps host
#   TUNNEL_PORT=7000                 # frps bind port
#   TUNNEL_TOKEN=...                 # per-tenant auth token
#   TUNNEL_NAME=alice                # subdomain claim on the edge
#   LOCAL_PORT=8080                  # the docklets gateway (never the admin port)
#   TUNNEL_PROTOCOL=tcp              # tcp (default) or wss for HTTPS proxies/CDNs
#   TUNNEL_CA_FILE=                  # wss only: CA bundle (default: system bundle)
#
# Runs the tunnel client in the foreground (service managers restart it;
# reconnect with backoff is built in). Override the config path with
# DOCKLETS_CONNECTOR_CONFIG for tests.
set -euo pipefail

FRP_VERSION="0.71.0"
# sha256 of the upstream release archives, pinned. Update the version and ALL
# checksums together from frp_sha256_checksums.txt on the release. A case
# statement instead of an associative array: macOS ships bash 3.2.
frp_sha256() {
  case "$1" in
    darwin_amd64) echo "1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637" ;;
    darwin_arm64) echo "45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6" ;;
    linux_amd64)  echo "84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716" ;;
    linux_arm64)  echo "f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266" ;;
    *) echo "" ;;
  esac
}

CONF_DIR="${DOCKLETS_CONNECTOR_HOME:-$HOME/.config/docklets}"
CONF="${DOCKLETS_CONNECTOR_CONFIG:-$CONF_DIR/connector.env}"
BIN_DIR="$CONF_DIR/bin"

platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux)  os=linux ;;
    *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64)  arch=amd64 ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os}_${arch}"
}

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

ensure_frpc() {
  local plat="$1" frpc="$BIN_DIR/frpc-$FRP_VERSION"
  if [ -x "$frpc" ]; then echo "$frpc"; return; fi
  local want; want="$(frp_sha256 "$plat")"
  [ -n "$want" ] || { echo "no pinned checksum for $plat" >&2; exit 1; }
  mkdir -p "$BIN_DIR"
  local name="frp_${FRP_VERSION}_${plat}"
  local url="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${name}.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  echo "downloading frp ${FRP_VERSION} (${plat})..." >&2
  curl -fsSL -o "$tmp/frp.tar.gz" "$url"
  local got; got="$(sha256_of "$tmp/frp.tar.gz")"
  if [ "$got" != "$want" ]; then
    echo "CHECKSUM MISMATCH for $name.tar.gz" >&2
    echo "  expected $want" >&2
    echo "  got      $got" >&2
    rm -rf "$tmp"; exit 1
  fi
  tar -xzf "$tmp/frp.tar.gz" -C "$tmp" "$name/frpc"
  install -m 0755 "$tmp/$name/frpc" "$frpc"
  rm -rf "$tmp"
  echo "$frpc"
}

# ---- config ------------------------------------------------------------------
if [ ! -f "$CONF" ]; then
  mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
  umask 177
  cat > "$CONF" <<'EOF'
# docklets connector configuration. Keep this file private (0600): the token
# is an ingress credential for your tunnel route.
TUNNEL_SERVER=
TUNNEL_PORT=7000
TUNNEL_TOKEN=
TUNNEL_NAME=
LOCAL_PORT=8080
# TUNNEL_PROTOCOL=tcp        # tcp (default) or wss (dial through an HTTPS proxy or CDN)
# TUNNEL_CA_FILE=            # wss only: CA bundle path (default: system bundle)
EOF
  echo "wrote config template at $CONF; fill it in and run again" >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$CONF"

: "${TUNNEL_SERVER:?TUNNEL_SERVER missing in $CONF}"
: "${TUNNEL_TOKEN:?TUNNEL_TOKEN missing in $CONF}"
: "${TUNNEL_NAME:?TUNNEL_NAME missing in $CONF}"
TUNNEL_PORT="${TUNNEL_PORT:-7000}"
LOCAL_PORT="${LOCAL_PORT:-8080}"
TUNNEL_PROTOCOL="${TUNNEL_PROTOCOL:-tcp}"

case "$TUNNEL_PROTOCOL" in
  tcp|wss) ;;
  *) echo "TUNNEL_PROTOCOL must be tcp or wss" >&2; exit 1 ;;
esac

# wss verifies the edge certificate; frp skips verification unless a CA
# bundle is pinned, so resolve one (system bundle, or TUNNEL_CA_FILE).
CA_FILE=""
if [ "$TUNNEL_PROTOCOL" = "wss" ]; then
  CA_FILE="${TUNNEL_CA_FILE:-}"
  if [ -z "$CA_FILE" ]; then
    for c in /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt; do
      if [ -f "$c" ]; then CA_FILE="$c"; break; fi
    done
  fi
  if [ -z "$CA_FILE" ] || [ ! -f "$CA_FILE" ]; then
    echo "no CA bundle found for wss; set TUNNEL_CA_FILE" >&2; exit 1
  fi
fi

case "$TUNNEL_NAME" in
  *[!a-z0-9-]*|-*|"") echo "TUNNEL_NAME must be lowercase kebab-case" >&2; exit 1 ;;
esac

# The invariant: the tunnel carries the public gateway only. The admin plane
# must stay local, so forwarding its port is refused outright.
ADMIN_PORT="${DOCKLETS_ADMIN_PORT:-2020}"
if [ "$LOCAL_PORT" = "$ADMIN_PORT" ] || [ "$LOCAL_PORT" = "2020" ]; then
  echo "refusing to tunnel the admin plane (port $LOCAL_PORT); tunnel the gateway instead" >&2
  exit 1
fi

# ---- run ---------------------------------------------------------------------
FRPC="$(ensure_frpc "$(platform)")"
FRPC_TOML="$CONF_DIR/frpc.generated.toml"

# tcp dials the edge's tunnel port directly over TLS. wss dials it as a TLS
# websocket, which traverses HTTPS proxies and CDNs, and pins the CA bundle
# so the edge certificate is actually verified.
if [ "$TUNNEL_PROTOCOL" = "wss" ]; then
  TRANSPORT_LINES="transport.protocol = \"wss\"
transport.tls.trustedCaFile = \"$CA_FILE\""
else
  TRANSPORT_LINES="transport.tls.enable = true"
fi

umask 177
cat > "$FRPC_TOML" <<EOF
# generated by connector.sh from $CONF; do not edit
serverAddr = "$TUNNEL_SERVER"
serverPort = $TUNNEL_PORT
auth.method = "token"
auth.token = "$TUNNEL_TOKEN"
$TRANSPORT_LINES
loginFailExit = false

[[proxies]]
name = "gateway"
type = "http"
subdomain = "$TUNNEL_NAME"
localIP = "127.0.0.1"
localPort = $LOCAL_PORT
EOF

echo "tunneling 127.0.0.1:$LOCAL_PORT as subdomain '$TUNNEL_NAME' via $TUNNEL_SERVER:$TUNNEL_PORT ($TUNNEL_PROTOCOL)" >&2
exec "$FRPC" -c "$FRPC_TOML"
