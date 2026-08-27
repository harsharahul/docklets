<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-horizontal-dark.svg">
  <img src="docs/assets/logo-horizontal.svg" alt="docklets" width="280">
</picture>

**A filesystem is your deploy API: one directory becomes a self-hosted app platform where writing files is the only deploy step.**

[![CI](https://github.com/harsharahul/docklets/actions/workflows/ci.yml/badge.svg)](https://github.com/harsharahul/docklets/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Built for AI agents that can write code but should never touch Docker, and for
humans who want function-platform ergonomics on their own machine without
running a cluster.

```
you (or your agent) write:                       what happens automatically:

assets/blog/index.html                 ──►      https://host/blog/        (static, instant)

assets/poll/app.json                   ──►      a hardened container runs poll/server.js,
assets/poll/server.js                           routed at https://host/poll/ , with
                                                persistent /data , auto-restart on crash,
                                                auto-redeploy on file change
```

No CLI to learn, no YAML pipelines, no image builds, no registry, no deploy
credentials. Delete the folder and the app is gone. Edit a file and it
redeploys.

## How it works

You get a **magic folder**. Anything you (or your AI) drop into it becomes a
live website or app at a web address, instantly.

**Publish a website**: make a folder, drop in a page. There is no step 2:

```
~/my-apps/wedding/index.html      →      http://localhost:8080/wedding/
```

Edit the file, refresh, updated. Delete the folder and the site is gone. The
folder *is* the deployment.

**Publish a real app**: need a backend that remembers things? Add one small
file next to your code:

```
~/my-apps/chores/
├── app.json     ← {"runtime":"node", "entry":"server.js", "port":3000}
└── server.js    ← saves state to /data
```

Within about 10 seconds the platform notices the manifest, starts a
locked-down container for it, and `http://localhost:8080/chores/` is a live
app. It auto-restarts on crash, auto-redeploys when you edit the code, and its
data in `/data` survives everything: crashes, redeploys, reboots.

> **No `app.json` = website. With `app.json` = app.**

**Let your AI do it**: give the agent write access to the magic folder (and
nothing else) plus the instructions in [`AGENTS.md`](AGENTS.md). Then just talk:

```
You:  "build me a poll so the family can vote on vacation spots"
AI:   writes  ~/my-apps/vote/app.json + server.js
      "Done, published at /vote/"
```

The AI never holds server passwords, Docker access, or deploy keys. It can
only write files into one folder. If it ships something buggy or malicious,
the app is trapped in its sandbox: no host files, no other apps' data.
*Being allowed to write in the folder IS the credential.*

**Share with the world** (optional): point any reverse proxy or tunnel at the
one gateway port and paths map 1:1: `family.example.com/vote/` → `/vote/`.

| You do | You get |
|---|---|
| make folder + `index.html` | a website at `/folder-name/` |
| add `app.json` + `server.js` | a running app at `/folder-name/` |
| edit files | auto-update |
| delete `app.json` | back to plain website |
| delete folder | unpublished |

Folders are apps. Files are deploys. The AI is a very fast intern who is only
allowed in one room.

## Why this exists

AI agents (Claude, GPT, local models, anything that can write files) are good
at producing small web apps and unsafe things to hand Docker access. Function
platforms are typically driven by a *network control plane* (a gateway API,
cloud credentials, kubectl), which is exactly the kind of privileged surface
you do not want reachable from an agent sandbox.

docklets inverts it: **the control plane is a directory.** Deploy authority is
write access to that directory. There is nothing to phish and no admin
endpoint to scan, and agent sandboxing (mount one folder read-write) becomes
the entire permission model.

## How it compares

|                      | Azure Functions | OpenFaaS            | **docklets**        |
|----------------------|-----------------|---------------------|---------------------|
| Control plane        | cloud API + creds | gateway REST API + registry | **the filesystem** |
| Deploy step          | build + publish | `docker build` + push + deploy | **write files** |
| Runs on              | Azure           | Kubernetes / faasd  | one machine with Docker |
| Per-app isolation    | managed sandbox | pod                 | hardened container (caps dropped, RO code, no ports) |
| Scale-to-zero / autoscale | yes        | yes                 | no (apps are small and always-on) |
| Route                | function host   | `/function/<name>`  | `/<slug>/`          |
| Good for             | production cloud| clusters            | agent-built apps, homelabs, personal tools |

Same architectural pattern (manifest → controller → sandboxed runtime →
gateway route) with the trusted surface shrunk to a deployer of about 250
lines you can read in one sitting.

## Architecture

```
            (only thing an agent needs: write access to the root)
                                │
   ┌────────────────────────────▼────────────────────────────┐
   │  ASSET ROOT                                             │
   │   blog/index.html            ← static slug              │
   │   poll/app.json + server.js  ← dynamic slug (docklet)   │
   │   .data/poll/                ← persistent app state     │
   │   .gateway/routes/*.caddy    ← generated routes         │
   └───────────────┬─────────────────────────┬───────────────┘
        watches    │                         │  serves (read-only)
   ┌───────────────▼───────────┐   ┌─────────▼───────────────────┐
   │  DEPLOYER (host daemon)   │   │  GATEWAY (Caddy container)  │
   │  polls manifests, runs    │   │  read-only rootfs, caps     │
   │  one hardened container   │   │  dropped, admin bound       │
   │  per docklet, writes      │──►│  container-internal only    │
   │  routes, hot-reloads ─────┘   │  :8080 → static + /slug/ ───┼──► your reverse proxy
   └───────────────┬───────────┘   └─────────▲───────────────────┘
                   │ docker run              │ internal network only
   ┌───────────────▼─────────────────────────┴───────────────┐
   │  docklet-poll        docklet-guestbook       ...        │
   │  code RO at /src · writable /app · persistent /data     │
   │  cap-drop ALL · no-new-privileges · mem/pid caps        │
   │  NO published ports · NO docker socket · NO host FS     │
   └─────────────────────────────────────────────────────────┘
```

Deeper detail lives in [docs/architecture.md](docs/architecture.md).

## Quickstart

Requirements: Docker (or OrbStack/Colima), Node 20 or newer, macOS or Linux.

```bash
git clone https://github.com/harsharahul/docklets && cd docklets

# macOS (launchd user services)
./install/install-macos.sh ~/docklets 8080

# Linux (systemd user services)
./install/install-linux.sh ~/docklets 8080
# (re-run an installer after filling ~/.config/docklets/connector.env and it
#  also manages the tunnel connector as a service)

# deploy the example app
cp -R examples/guestbook ~/docklets/
open http://localhost:8080/guestbook/      # live within ~10 seconds
```

Or run it by hand, no services:

```bash
DOCKLETS_ROOT=~/docklets ./bin/serve.sh &          # gateway
DOCKLETS_ROOT=~/docklets node bin/deployer.mjs     # deployer (--once for a single pass)
```

## The manifest

A slug directory is **static** by default. Add `app.json` and it becomes a
**docklet**, a running server behind the same route:

```json
{
  "runtime": "node",       // "node" (node:20-alpine) or "python" (python:3.12-alpine)
  "entry":   "server.js",  // relative path in the slug dir
  "port":    3000,         // your app listens here (also passed as $PORT)
  "env":     { "X": "y" }, // optional non-secret env vars
  "install": false         // true → npm install / pip install at container start
}
```

Rules your app lives by:

- Listen on `$PORT`. Requests arrive with the `/<slug>/` prefix **stripped**
  (`/<slug>/api/x` → your app sees `/api/x`). Use relative URLs in any HTML
  you serve.
- Persist state in **`/data`**. It maps to `.data/<slug>/` on the host and
  survives crashes, redeploys, and reboots. Everything else is throwaway.
- Your code is mounted **read-only**; a writable copy lives at `/app` inside
  the container (that is where `install` puts dependencies).
- Crash → auto-restart. File change → auto-redeploy. `app.json` deleted →
  back to static. Folder deleted → route and container removed.

Full specification: [docs/manifest.md](docs/manifest.md).

## Using it with an AI agent

The installers drop a filled-in `AGENTS.md` (and a `CLAUDE.md` symlink to it)
into the asset root, hidden from public serving. Any agent that reads those
files from its working directory picks up the publishing rules automatically.
The whole integration is: give the agent the folder.

Quick start per harness:

| Your agent | What to do |
|---|---|
| **Codex, Cursor, Jules, Zed, Amp** (AGENTS.md-aware) | Open the agent in the asset root (e.g. `cd ~/docklets && codex`). Nothing else; it reads `AGENTS.md` on its own |
| **Claude Code** | Same: run it in the asset root. The `CLAUDE.md` symlink points at the same instructions. The repo also ships `skills/docklets/SKILL.md` for a skill-driven install |
| **NanoClaw** | Mount the asset root read-write into the agent group and paste `AGENTS.md` into the group's `instructions.prepend.md` |
| **Anything else** (custom SDK agent, other CLIs) | Paste `AGENTS.md` into its system prompt / standing instructions, with `<ASSETS>` set to the mounted path and `<HOST>` to the gateway URL |

Then just talk: "build me a poll and publish it". The agent writes files; the
platform does the rest. Give the agent **read-write access to the asset root
and nothing else**; that mount is the entire permission model. Developed for
and running in production under
[NanoClaw](https://github.com/qwibitai/nanoclaw) agents, but nothing here is
agent-framework-specific.

## Exposing it to the internet

The gateway binds one port (default 8080). Point any reverse proxy at it
(Caddy, nginx, Cloudflare Tunnel, Tailscale Funnel). Path routing maps 1:1, so
`https://you.example/poll/` → `/poll/` with zero rewriting. Nothing else is
reachable from outside: not the deployer, not the admin endpoint, not the app
containers.

## Dashboard and admin plane

**Status dashboard** (read-only, public): the deployer writes a minimal
`.status.json` into the asset root each pass (slug and coarse run state only:
no ports, paths, or hashes). The bundled dashboard renders it and is itself
just a static asset. The installers deploy it to `/status/` automatically, and
the gateway root (`/`) redirects there, so hitting the site shows a curated
status view rather than a raw file listing of every slug. To deploy or
refresh it manually:

```bash
cp -R dashboard <asset-root>/status     # live at /status/
```

It never asks for a credential; anything that does is not this dashboard.

**Admin plane** (opt-in, local-only): set `DOCKLETS_ADMIN_PORT=2020` in the
deployer's environment and it serves a token-authenticated UI and API at
`http://127.0.0.1:2020/` with lifecycle actions (restart, pause, resume) and
log tailing. The token lives at `~/.config/docklets/admin-token`, outside the
asset root, so agents and apps can never read it. The daemon binds loopback
only, enforces a strict Host allowlist (DNS rebinding), sends no CORS grants,
and uses no cookies. Deploying and deleting remain filesystem operations;
there is no deploy-over-HTTP anywhere. Details in
[SECURITY.md](SECURITY.md#admin-plane).

## Agent setup skill

`skills/docklets/SKILL.md` lets a coding agent (Claude Code and similar)
install and operate docklets end to end: prerequisite checks, installer,
dashboard, admin plane, and wiring `AGENTS.md` into the agent's own
instructions. Point your agent at the file, or copy it into your skills
directory.

## Public URL without the cloud: the tunnel connector

`bin/connector.sh` connects your asset root to any frp-compatible tunnel edge:
you get a public URL while files, containers, and data stay on your machine.
It dials out (NAT and CGNAT friendly, no inbound ports), refuses to tunnel the
admin plane, verifies the pinned frp binary by sha256, and keeps its ingress
token outside the asset root where agents and apps can never reach it. With
`TUNNEL_PROTOCOL=wss` it dials the edge as an ordinary TLS websocket, so it
works through HTTPS ingresses and CDNs and from networks that only allow
outbound HTTPS. Setup and security details: [docs/tunnel.md](docs/tunnel.md).

The connector speaks standard frp, so the server side is any frp server you
already run or rent: a minimal `frps.toml` for a VPS is in
[docs/tunnel.md](docs/tunnel.md).

Or skip running a server entirely: [docklets.dev](https://docklets.dev) is
the managed edge run by the docklets project, currently in invite-only
preview. Your subdomain, your token, your data at home. The traffic path is
explained in [How docklets works](https://harsharahul.com/how-docklets-works/).

## Security model

Read [SECURITY.md](SECURITY.md) for the full threat model, verified boundary
tests, and known limitations. The one-paragraph version: a malicious or buggy
app is trapped in a capability-dropped container with no host filesystem, no
published ports, and only its own `/data` writable; a compromised gateway
holds a read-only view of the asset tree; a compromised *agent* can at most
deploy another app into the same trap. The only Docker-privileged component is
the deployer, fixed code on the host that agents cannot write to.

## Operations

```bash
# what's deployed
docker ps --filter label=docklet

# app logs
docker logs docklet-<slug>

# deployer log
tail -f <root>/.gateway/logs/deployer.log

# stop everything (asset root untouched; includes the connector service if present)
./install/uninstall-macos.sh          # or systemctl --user disable --now docklets-{gateway,deployer,connector}
```

## Roadmap

- Per-app egress policy (offline-by-default apps, allowlisted hosts)
- Read-only app rootfs once dependency install moves to a build step
- More runtimes (bun, deno, static binaries)
- Optional basic-auth / OIDC on the gateway
- Subdomain-per-app mode (origin isolation between apps)

## License

MIT
