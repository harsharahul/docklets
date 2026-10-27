#!/bin/bash
# Update this docklets install to the newest release.
#
#   install/update.sh           update now if a newer release exists
#   install/update.sh --check   only say whether one exists
#   install/update.sh --auto    the nightly timer: an update, with timestamps
#
# An update switches this checkout to the newest vX.Y.Z tag, re-runs the
# platform installer with the saved settings (~/.config/docklets/install.env),
# and waits for the gateway to answer. If it does not, the release that was
# running is restored the same way. A checkout with local changes, or on a
# branch other than main, is left alone. Release candidates are skipped.
#
# Test seams: DOCKLETS_UPDATE_INSTALLER (run instead of the platform
# installer), DOCKLETS_UPDATE_HEALTH_URL, DOCKLETS_UPDATE_HEALTH_TIMEOUT.
set -euo pipefail

MODE=""
log()  { if [ "$MODE" = "--auto" ]; then printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; else printf '%s\n' "$*"; fi; }
fail() { log "docklets update: $*" >&2; return 1; }

version_of() { node -p 'require(process.argv[1]).version' "$1/package.json"; }

# The newest vX.Y.Z among `git ls-remote --tags` lines on stdin, without the v.
newest_release() {
  node -e '
    const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    let best = null;
    for (const line of require("fs").readFileSync(0, "utf8").split("\n")) {
      const m = line.match(/refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/);
      if (m && (!best || cmp(m.slice(1).map(Number), best) > 0)) best = m.slice(1).map(Number);
    }
    if (best) console.log(best.join("."));'
}

# Exit 0 when release $1 is newer than version $2 (a prerelease of the same
# X.Y.Z counts as older).
is_newer() {
  node -e '
    const p = (v) => { const m = v.match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/); return m ? [...m.slice(1, 4).map(Number), m[4] ? 0 : 1] : null; };
    const [a, b] = [p(process.argv[1]), p(process.argv[2])];
    process.exit(a && b && (a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]) > 0 ? 0 : 1);' "$1" "$2"
}

healthy() { # $1 url, $2 seconds
  local deadline=$(( $(date +%s) + $2 ))
  # Give the restarted gateway a moment, so the old one never answers for it.
  sleep 2
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if node -e 'fetch(process.argv[1], { redirect: "manual", signal: AbortSignal.timeout(5000) })
        .then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))' "$1"; then
      services_running && return 0
    fi
    sleep 2
  done
  return 1
}

# The connector is a service only when its config exists; then it must be up.
services_running() {
  [ -f "$HOME/.config/docklets/connector.env" ] || return 0
  local out
  case "$(uname -s)" in
    Darwin)
      out="$(launchctl print "gui/$(id -u)/com.docklets.connector" 2>/dev/null || true)"
      case "$out" in *"state = running"*) return 0 ;; *) return 1 ;; esac ;;
    *) systemctl --user is-active --quiet docklets-connector ;;
  esac
}

# Everything runs inside main, which bash reads in full before running it:
# the checkout this script lives in changes under it mid-update.
main() {
  MODE="${1:-}"
  case "$MODE" in ""|--check|--auto) ;; *) echo "usage: update.sh [--check|--auto]" >&2; return 2 ;; esac

  local src conf current latest tags
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  conf="$HOME/.config/docklets"
  git -C "$src" rev-parse --git-dir >/dev/null 2>&1 || { fail "$src is not a git checkout"; return 1; }
  current="$(version_of "$src")"

  tags="$(git -C "$src" ls-remote --tags --refs origin 'v*')" || { fail "cannot reach $(git -C "$src" remote get-url origin)"; return 1; }
  latest="$(printf '%s\n' "$tags" | newest_release)"
  if [ -z "$latest" ] || ! is_newer "$latest" "$current"; then
    log "docklets $current is up to date"
    return 0
  fi
  if [ "$MODE" = "--check" ]; then
    log "update available: $current -> $latest (run $src/install/update.sh)"
    return 0
  fi

  local branch
  branch="$(git -C "$src" symbolic-ref -q --short HEAD || true)"
  if [ -n "$branch" ] && [ "$branch" != "main" ]; then fail "$src is on branch $branch; not updating"; return 1; fi
  if [ -n "$(git -C "$src" status --porcelain --untracked-files=no)" ]; then fail "local changes in $src; not updating"; return 1; fi

  local root="" port="" auto="" k v
  [ -f "$conf/install.env" ] || { fail "no saved install settings in $conf/install.env; re-run setup.sh once"; return 1; }
  while IFS='=' read -r k v; do
    case "$k" in
      DOCKLETS_ROOT) root="$v" ;;
      DOCKLETS_PORT) port="$v" ;;
      DOCKLETS_AUTO_UPDATE) auto="$v" ;;
    esac
  done < "$conf/install.env"
  [ -n "$root" ] && [ -n "$port" ] || { fail "$conf/install.env is missing DOCKLETS_ROOT or DOCKLETS_PORT"; return 1; }

  # One update at a time; a lock left by a run that died (its pid gone, or
  # older than two hours, in case the pid was reused) is taken over.
  local lock="$conf/update.lock" pid
  if ! mkdir "$lock" 2>/dev/null; then
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -z "$(find "$lock" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then
      log "another update is running"; return 0
    fi
    rm -rf "$lock"; mkdir "$lock"
  fi
  echo $$ > "$lock/pid"
  trap 'rm -rf "'"$lock"'"' EXIT

  local installer="${DOCKLETS_UPDATE_INSTALLER:-}"
  if [ -z "$installer" ]; then
    case "$(uname -s)" in
      Darwin) installer="$src/install/install-macos.sh" ;;
      Linux)  installer="$src/install/install-linux.sh" ;;
      *) fail "unsupported platform $(uname -s)"; return 1 ;;
    esac
  fi
  install() { (cd "$src" && DOCKLETS_AUTO_UPDATE="$auto" DOCKLETS_UPDATE_RUNNING=1 "$installer" "$root" "$port"); }

  local prev
  prev="$(git -C "$src" rev-parse HEAD)"
  log "updating docklets $current -> $latest"
  if [ "$(git -C "$src" rev-parse --is-shallow-repository)" = "true" ]; then
    git -C "$src" fetch -q --depth 1 origin "refs/tags/v$latest:refs/tags/v$latest"
  else
    git -C "$src" fetch -q origin "refs/tags/v$latest:refs/tags/v$latest"
  fi
  git -C "$src" checkout -q --detach "v$latest"

  if install && healthy "${DOCKLETS_UPDATE_HEALTH_URL:-http://127.0.0.1:$port/}" "${DOCKLETS_UPDATE_HEALTH_TIMEOUT:-180}"; then
    log "updated docklets $current -> $latest"
    return 0
  fi
  # Back to where it was: on main if it followed main, else the old commit.
  if [ -n "$branch" ] && [ "$(git -C "$src" rev-parse "$branch")" = "$prev" ]; then
    git -C "$src" checkout -q "$branch"
  else
    git -C "$src" checkout -q --detach "$prev"
  fi
  if install; then
    log "health check failed; rolled back to $current"
  else
    log "health check failed, and restoring $current failed too; see $root/.gateway/logs/"
  fi
  return 1
}

main "$@"; exit $?
