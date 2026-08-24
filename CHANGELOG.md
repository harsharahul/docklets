# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
