# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tunnel edge (`edge/`): the server half of the tunnel, deployable as a
  single hardened container (`edge/Dockerfile` + compose file, upstream frp
  pinned by sha256 at build, runs as nobody with capabilities dropped) or on
  Kubernetes (`edge/k8s/edge.yaml`, single-replica shards that scale by
  adding shards). CI builds the image and runs the tunnel round-trip against
  it, and validates the compose and Kubernetes manifests. Documented in
  `docs/edge.md`.
- Tunnel connector (`bin/connector.sh`): exposes a self-hosted asset root
  through any frp-compatible edge while files, containers, and data stay
  local. Dials out only, refuses to tunnel the admin plane, pins the frp
  client by version and per-platform sha256, keeps the ingress token outside
  the asset root, and reconnects automatically. Documented in
  `docs/tunnel.md`; CI runs a full tunnel round-trip (static asset and
  docklet API through a local edge, admin-port refusal, unknown-tenant 404).
- Websocket transport for the connector (`TUNNEL_PROTOCOL=wss`): the tunnel
  dials the edge as a TLS websocket, so it enters through HTTPS ingresses,
  reverse proxies, and CDNs, and works from networks that only allow
  outbound HTTPS. wss verifies the edge certificate against the system CA
  bundle or `TUNNEL_CA_FILE` and refuses to connect unverified. The edge
  docs gain the matching ingress dial-hostname pattern (`docs/edge.md`); CI
  covers refusal without trust and a full round-trip through a
  TLS-terminating proxy.

## [0.3.0] - 2026-08-25

### Added

- The installers drop a filled-in `AGENTS.md` (plus a `CLAUDE.md` symlink)
  into the asset root, so any coding agent opened in that folder picks up the
  publishing instructions automatically. Both files are hidden from public
  serving. The README gains per-harness quick-start instructions.

## [0.2.1] - 2026-08-25

### Changed

- The gateway root (`/`) now redirects to the status dashboard instead of
  serving a browsable file index, so a public deployment no longer enumerates
  every slug. Individual routes are unaffected. The installers deploy the
  dashboard to `/status/` by default so the redirect always resolves.

### Security

- `admin-ui.html` is added to the gateway hide list, so installs that keep the
  deployer inside the asset root do not serve the admin UI shell publicly.

## [0.2.0] - 2026-08-25

### Added

- Public status feed: the deployer writes a minimal `.status.json` (slug and
  coarse run state only) into the asset root on every converge pass.
- Read-only status dashboard shipped in `dashboard/`, deployable as a plain
  static asset.
- Opt-in local admin plane (`DOCKLETS_ADMIN_PORT`): token-authenticated UI
  and API on 127.0.0.1 with restart, pause, resume, and capped log tailing.
  Token stored outside the asset root; strict Host allowlist; no cookies and
  no CORS grants. Pause and resume are manifest renames applied by the
  converge loop.
- Agent setup skill at `skills/docklets/SKILL.md` covering install, dashboard,
  admin plane, and publishing wiring.

### Security

- CI now asserts the admin plane's properties: 401 without the token, 403 on
  foreign Host headers, absence of CORS grants, slug validation, log tail cap,
  and that the public status feed carries no ports, paths, or hashes.

## [0.1.0] - 2026-08-24

### Added

- Gateway: hardened Caddy container serving an asset root read-only, with
  directory-per-route static hosting, security headers, and infrastructure
  files hidden from listings and requests.
- Deployer: host daemon that converges Docker to the `app.json` manifests in
  the asset root. One hardened container per dynamic asset (capabilities
  dropped, no-new-privileges, memory and pid caps, code mounted read-only,
  persistent `/data`), route files hot-reloaded into the gateway with zero
  downtime, redeploy on content change, cleanup on manifest removal.
- Runtimes: `node` (node:20-alpine) and `python` (python:3.12-alpine), with
  optional dependency install at container start.
- `--once` deployer mode for single-pass converge in tests and CI.
- Installers for macOS (launchd user services) and Linux (systemd user
  services), plus a macOS uninstaller that leaves the asset root untouched.
- `AGENTS.md`: drop-in publishing instructions for AI agents.
- Examples: static site and a zero-dependency guestbook app with a JSON API
  and persistent storage.
