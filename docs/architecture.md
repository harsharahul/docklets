# Architecture

Three components cooperate around one directory (the asset root). Nothing else
exists: no database, no message bus, no deploy service.

## The asset root

```
<root>/
├── <slug>/                  one directory per asset
│   ├── index.html           static content, served as files
│   ├── app.json             optional manifest: makes the slug a docklet
│   └── server.js            docklet code (entry named by the manifest)
├── .data/<slug>/            per-app persistent state (host disk)
└── .gateway/
    ├── routes/*.caddy       generated route fragments, one per docklet
    └── logs/                service logs when installed via the installers
```

Slug names must match `^[a-z0-9][a-z0-9-]{0,40}$`. Dot-directories are
infrastructure and are hidden from the gateway's listings and requests.

## The gateway (`bin/serve.sh` + `gateway/Caddyfile`)

A Caddy container serves the asset root, mounted read-only at `/srv`, on one
published port (default 8080). Static slugs are served by `file_server` with a
directory index at `/`. Dynamic slugs are matched first by imported route
fragments and reverse-proxied to their app container; `reverse_proxy`
terminates matched requests, so proxied slugs never fall through to the file
server.

The container is hardened: read-only rootfs, all capabilities dropped except
`NET_BIND_SERVICE`, `no-new-privileges`, memory and pid caps. Its admin API is
bound to localhost inside the container's own network namespace and is never
published; the deployer reaches it exclusively through
`docker exec <gateway> caddy reload`, which applies route changes with zero
downtime.

Because the host filesystem does not exist inside the gateway container, a
symlink or path traversal placed in an asset resolves inside the container
(where the target is absent) and returns 404 instead of leaking host files.

## The deployer (`bin/deployer.mjs`)

A zero-dependency Node script that runs a converge loop (default every 7
seconds, or exactly once with `--once`):

1. **Desired state**: scan the asset root for slugs with a valid `app.json`.
   Each desired app gets a content hash computed from file paths, sizes, and
   mtimes (dependency directories and dot-entries excluded).
2. **Actual state**: `docker ps` filtered by the `docklet-root` label.
3. **Converge**:
   - missing, hash-changed, or port-changed app: recreate its container
   - stopped app: start it
   - container without a manifest: remove it and its route
   - orphaned route file: delete it
4. **Routes**: write one fragment per app
   (`redir` + `handle_path /<slug>/* { reverse_proxy ... }`) and reload the
   gateway only when a fragment actually changed.

Manifests are validated before anything runs (slug pattern, entry path
confinement, port range, env key pattern); symlinked manifests are ignored.

## App containers

One per docklet, named `<prefix><slug>` (default `docklet-<slug>`):

| Mount / setting | Value |
|---|---|
| `/src` | the slug directory, read-only |
| `/app` | writable copy of `/src` made at start (dependency install target) |
| `/data` | `<root>/.data/<slug>`, read-write, survives everything |
| network | internal docker network only; no published ports |
| restart | `unless-stopped` (crash recovery without the deployer) |
| hardening | `cap-drop ALL`, `no-new-privileges`, `--init`, memory and pid caps |

Start sequence: copy `/src` to `/app`, optionally run the runtime's dependency
install (`npm install --omit=dev` / `pip install -r requirements.txt`), then
exec the entry with `PORT` set from the manifest.

## Request flow

```
client → gateway :8080
           ├── /<static-slug>/...  → file_server from /srv (read-only)
           └── /<docklet-slug>/... → strip prefix → reverse_proxy →
                                     docklet container :PORT (internal network)
```

Apps therefore see prefix-stripped paths: a request to `/<slug>/api/x`
arrives at the app as `/api/x`.
