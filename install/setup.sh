#!/bin/bash
# docklets setup wizard: one command from nothing to a running platform,
# and onto a public docklets.dev address when a connector configuration
# exists. Safe to re-run any time; re-running is how you apply changes.
#
#   curl -fsSL https://docklets.dev/install | bash
#
# Non-interactive use: set DOCKLETS_ROOT, DOCKLETS_PORT, DOCKLETS_SRC and
# the wizard asks nothing.
set -euo pipefail

REPO_URL="https://github.com/harsharahul/docklets"

say()  { printf '%s\n' "$*"; }
fail() { printf 'docklets setup: %s\n' "$*" >&2; exit 1; }

# ---- questions (curl|bash occupies stdin, so ask the terminal) ----
ask() { # $1 prompt, $2 default -> answer on stdout
  answer=""
  if [ -t 0 ]; then
    printf '%s [%s]: ' "$1" "$2" >&2
    read -r answer || true
  elif [ -e /dev/tty ]; then
    printf '%s [%s]: ' "$1" "$2" >&2
    read -r answer < /dev/tty || true
  fi
  printf '%s' "${answer:-$2}"
}

# ---- requirements ----
command -v git >/dev/null 2>&1 || fail "git is required. Install it and re-run."
command -v node >/dev/null 2>&1 || fail "Node 20+ is required. Install it (nodejs.org) and re-run."
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node $NODE_MAJOR found; docklets needs Node 20 or newer."
command -v docker >/dev/null 2>&1 || fail "Docker is required. Install Docker Desktop, OrbStack, or Colima and re-run."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start it and re-run."

# ---- find or fetch the platform source ----
SRC="${DOCKLETS_SRC:-}"
if [ -z "$SRC" ]; then
  # Running from a checkout? Use it. Otherwise keep a managed clone.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../bin/deployer.mjs" ]; then
    SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
  elif [ -f "$PWD/bin/deployer.mjs" ]; then
    SRC="$PWD"
  else
    SRC="$HOME/.docklets/src"
  fi
fi
if [ ! -f "$SRC/bin/deployer.mjs" ]; then
  say "Fetching docklets into $SRC ..."
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 "$REPO_URL" "$SRC"
else
  git -C "$SRC" pull --ff-only >/dev/null 2>&1 || true
fi

# ---- the two questions ----
ROOT="${DOCKLETS_ROOT:-$(ask "Where should your docklets folder live" "$HOME/docklets")}"
ROOT="${ROOT/#\~/$HOME}"
PORT="${DOCKLETS_PORT:-$(ask "Local port for the gateway" "8080")}"
case "$PORT" in (*[!0-9]*|'') fail "the port must be a number" ;; esac

# ---- tunnel mode is decided by the connector configuration ----
CONNECTOR_ENV="$HOME/.config/docklets/connector.env"
if [ -f "$CONNECTOR_ENV" ]; then
  TUNNEL_STATE="found $CONNECTOR_ENV; the connector service will run too."
else
  TUNNEL_STATE="not configured (local only for now)."
fi

say ""
say "  folder:  $ROOT"
say "  gateway: http://localhost:$PORT/"
say "  tunnel:  $TUNNEL_STATE"
say ""

# ---- install ----
case "$(uname -s)" in
  Darwin) "$SRC/install/install-macos.sh" "$ROOT" "$PORT" ;;
  Linux)  "$SRC/install/install-linux.sh" "$ROOT" "$PORT" ;;
  *) fail "unsupported platform $(uname -s); docklets runs on macOS and Linux" ;;
esac

# ---- what now ----
say ""
say "docklets is running."
say "  Publish something:   mkdir $ROOT/hello && echo '<h1>hello</h1>' > $ROOT/hello/index.html"
say "                       then open http://localhost:$PORT/hello/"
say "  Hand it to your AI:  cd $ROOT && claude   (or codex; instructions are in the folder)"
if [ -f "$CONNECTOR_ENV" ]; then
  say "  Public address:      your docklets.dev name goes live as the connector signs in."
else
  say "  Go public (opt-in):  sign in at https://docklets.dev, claim your name, use its"
  say "                       'Copy as Terminal command' button, then re-run this wizard:"
  say "                       curl -fsSL https://docklets.dev/install | bash"
fi
