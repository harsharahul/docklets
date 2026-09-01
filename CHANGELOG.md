# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Folder sync (`bin/sync.mjs` + `bin/receiver.mjs`): mirror a local folder
  to another machine over HTTPS. The client fingerprints files with sha256
  and uploads only changes; the receiver stages uploads, verifies every
  byte against the declared digest, and applies the mirror atomically
  behind a lock the deployer honors. Auth is a bearer token stored only as
  an scrypt hash. Documented in `docs/sync.md`; unit tests cover the
  protocol and CI runs a full round-trip.
- Container image (`Dockerfile`): the deployer, sync receiver, and tunnel
  connector in one image with the frp client baked in checksum-verified.
  Pairs with a stock caddy container serving the same folder. Documented
  in `docs/container.md`; CI builds the image and serves synced content
  through a tunnel end to end.
- Deployer app-runner modes (`DOCKLETS_DRIVER`): `docker` (the default,
  unchanged) or `none`, which publishes the status feed without running
  apps, for deployments without a docker socket. App folders show as
  `pending` on the dashboard in `none` mode.
- Connector `--fetch-only`: download and verify the tunnel client, then
  exit; lets images bake the binary at build time.
- Sync receiver: token hashes verify in both supported encodings
  (base64url and hex), so managed control planes can share one stored
  hash with the receiver.
- Published container image: every main push publishes the multi-arch
  image to `ghcr.io/harsharahul/docklets` (`:main` and `:sha-<commit>`).

- Not-found page: a request for a path nothing serves answers with a
  readable page naming the missing path instead of an empty response, in
  light or dark to match the visitor. An asset root's own `404.html`
  replaces it. CI covers the built-in page, its content type, and the
  override.
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
  bundle or `TUNNEL_CA_FILE` and refuses to connect unverified. CI covers
  refusal without trust and a full round-trip through a TLS-terminating
  proxy.
- Managed-edge authentication for the connector (`TUNNEL_USER`): the
  connector can authenticate as an assigned user with a per-tenant token
  sent as connection metadata, so multi-tenant edges can validate and
  revoke tenants individually. Classic edge-wide token auth is unchanged
  and remains the default. CI covers both configuration shapes and a
  managed-mode round-trip.
- The installers manage the tunnel connector as a service
  (`com.docklets.connector` on macOS, `docklets-connector.service` on
  Linux) once `~/.config/docklets/connector.env` exists; installs without
  that config are unchanged, and the uninstaller removes the service
  either way.

- Receiver read endpoints: `GET /sync/manifest` lists the live tree by
  manifest rules and `GET /sync/file?path=` returns one file, so a client
  can change a few files without re-declaring the whole folder from
  scratch. Both sit behind the same bearer check as writes.
- Extra hash files for the receiver: a hash file may hold several hashes,
  one per line, and `DOCKLETS_SYNC_TOKEN_HASH_FILES` names optional extra
  files, so a second writer holds its own token and is revoked on its own.
  CI proves a second writer through the container image.

### Fixed

- Receiver: two `POST /sync/start` requests that overlapped while the
  receiver hashed files already on disk could both proceed, and the later
  one silently replaced the first session. The slot is now reserved before
  hashing, so the second start answers 409 as documented.

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
