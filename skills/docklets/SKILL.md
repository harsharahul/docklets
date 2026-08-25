---
name: docklets
description: Install and operate docklets, a self-hosted app platform where one directory is the deploy API. Use when the user wants to set up docklets, publish sites or apps by writing files, check what is deployed, or enable the local admin plane. Triggers on "install docklets", "set up docklets", "deploy to my docklets folder", "docklets status".
---

# docklets setup and operations

docklets turns one directory (the asset root) into a self-hosted app platform:
a folder with `index.html` is a website at `/<slug>/`, a folder with an
`app.json` manifest runs as a sandboxed server container behind the same
route. Deploying is writing files; there is no other deploy step.

## 1. Install

Prerequisites: Docker running, Node 20 or newer. Verify both before starting:

```bash
docker info >/dev/null && node --version
```

Clone and install as user services (pick the asset root with the user; the
examples below use `~/docklets` and port 8080):

```bash
git clone https://github.com/harsharahul/docklets && cd docklets
./install/install-macos.sh ~/docklets 8080     # macOS (launchd)
./install/install-linux.sh ~/docklets 8080     # Linux (systemd --user)
```

Verify: `curl -sf http://localhost:8080/` returns the asset listing, and
`<root>/.status.json` appears within about 10 seconds.

## 2. Deploy the status dashboard (recommended)

The installers deploy the dashboard to `<asset-root>/status` automatically.
For a pre-existing install, copy it in manually:

```bash
cp -R dashboard <asset-root>/status
```

It is live at `http://localhost:8080/status/`, listing every app with its
run state. It is read-only and public like every other asset; it never asks
for a token.

## 3. Enable the admin plane (optional)

The admin plane is a token-authenticated local daemon for lifecycle actions
(restart, pause, resume, logs). It binds 127.0.0.1 only and is off by default.

1. Set `DOCKLETS_ADMIN_PORT` (e.g. `2020`) in the deployer's service
   environment (the launchd plist or systemd unit the installer wrote), then
   restart the deployer service.
2. The token is generated at `~/.config/docklets/admin-token` (mode 0600).
   **Tell the user the path. Do not read the file or echo the token into the
   conversation.** The token belongs only in the admin page at
   `http://127.0.0.1:2020/`, never on any page served from the public gateway.
3. The admin UI is at `http://127.0.0.1:2020/`. It is intentionally not
   reachable remotely; remote administration means reaching the machine over
   the operator's own VPN or tailnet first.

## 4. Publish content

Follow the repository's `AGENTS.md` for the publishing rules (slug naming,
relative links, the `app.json` manifest, persistent `/data`). The installers also
drop a filled-in `AGENTS.md` (with a `CLAUDE.md` symlink) into the asset root,
so agents that read those files from their working directory need no further
setup. If you are the agent that will publish for this user and do not work
from that directory, add the `AGENTS.md` instructions to your standing
instructions with `<ASSETS>` set to the asset root and `<HOST>` set to how the
user reaches the gateway.

## 5. Operate

```bash
docker ps --filter label=docklet          # what is deployed
docker logs docklet-<slug>                # app logs
tail -f <root>/.gateway/logs/deployer.log # deployer activity
```

Pause without undeploying: rename `<slug>/app.json` to `app.json.paused`
(or use the admin plane). Resume: rename it back. The converge loop applies
either within about 10 seconds.

## Troubleshooting

- Route 404s: confirm the slug directory exists and matches
  `^[a-z0-9][a-z0-9-]{0,40}$`, and `index.html` (static) or `app.json`
  (app) is present.
- App unreachable: `docker logs docklet-<slug>`; the app must listen on
  `$PORT` on `0.0.0.0` and receives paths with the `/<slug>/` prefix stripped.
- Nothing deploys: check the deployer service is running and its log for
  `SKIP <slug>` lines explaining manifest validation failures.
