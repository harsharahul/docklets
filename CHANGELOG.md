# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
