# Running docklets in a container

A prebuilt multi-arch image is published as
`ghcr.io/harsharahul/docklets:main` (also tagged `sha-<commit>`).

The repo's `Dockerfile` builds a single image with the node-side stack:
the deployer, the sync receiver, and the tunnel connector, supervised by
tini. The frp client is baked in at build time, checksum-verified, so
container start needs no network fetch.

The image deliberately does not include the gateway. Pair it with a stock
caddy container serving the same folder; on one host they share a network,
in a pod they share localhost. That keeps the serving container read-only
and the writing container without a public port.

## What runs, and when

| Process | Runs when |
|---|---|
| deployer | always; `DOCKLETS_DRIVER` defaults to `none` in the container (status feed only, no app containers) |
| receiver | `DOCKLETS_SYNC_TOKEN_HASH_FILE` is set |
| connector | the file named by `DOCKLETS_CONNECTOR_CONFIG` (default `/etc/docklets/connector.env`) exists |

If any process exits, the container exits; let the supervisor (compose,
kubernetes, systemd) restart it.

## Environment

| Env | Default | Meaning |
|---|---|---|
| `DOCKLETS_ROOT` | required | the mounted folder |
| `DOCKLETS_DRIVER` | `none` | app runner mode; `docker` needs a docker socket, which this container does not have |
| `DOCKLETS_SYNC_TOKEN_HASH_FILE` | unset | enables the receiver (see docs/sync.md) |
| `DOCKLETS_SYNC_TOKEN_HASH_FILES` | unset | colon-separated extra hash files for additional writers |
| `DOCKLETS_RECEIVER_ADDR` | `0.0.0.0` | receiver listen address inside the container |
| `DOCKLETS_CONNECTOR_CONFIG` | `/etc/docklets/connector.env` | connector config (see docs/tunnel.md) |

## Compose example

Static serving plus sync on one host:

```yaml
services:
  gateway:
    image: caddy:2.11-alpine
    ports: ["8080:8080"]
    volumes:
      - ./folder:/srv:ro
      - ./gateway/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./folder/.gateway/routes:/etc/caddy/routes:ro
    read_only: true
    tmpfs: [/tmp, /data, /config]
  docklets:
    build: .
    environment:
      DOCKLETS_ROOT: /folder
      DOCKLETS_SYNC_TOKEN_HASH_FILE: /etc/docklets/sync-hash
    ports: ["127.0.0.1:9000:9000"]
    volumes:
      - ./folder:/folder
      - ./sync-hash:/etc/docklets/sync-hash:ro
```

Create `folder/.gateway/routes/00-placeholder.caddy` once (any comment
line) so caddy's route import always matches, mint the sync hash per
docs/sync.md, and sync from anywhere:

```sh
DOCKLETS_SYNC_URL=http://host:9000 DOCKLETS_SYNC_TOKEN=... \
  node bin/sync.mjs ~/my-folder
```

Add a connector config mount and the same container also gives the folder
a public URL through an frp edge (docs/tunnel.md).
