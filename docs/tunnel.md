# Tunnel connector

`bin/connector.sh` gives a self-hosted asset root a public URL through any
frp-compatible tunnel edge, while files, containers, and data stay on your
machine. The connector dials out (it works behind NAT and CGNAT; no inbound
ports are opened on your network) and forwards edge traffic to your local
gateway.

## Security properties

- The connector forwards to the gateway port only. It refuses to tunnel the
  admin plane: the admin port stays reachable solely from your machine.
- The tunnel token is an ingress credential. Leaking it lets someone
  impersonate your tunnel route; it cannot write files, deploy anything, or
  read anything. It lives in `~/.config/docklets/connector.env` (mode 0600),
  outside the asset root, so agents and deployed apps can never touch it.
- The frp client binary is downloaded from the upstream GitHub release, pinned
  to an exact version with sha256 verification per platform. A checksum
  mismatch aborts the run.
- The frpc-to-frps transport runs with TLS enabled.

## Setup

You need an frp server (frps) somewhere with a public address: any VPS works.
Minimal `frps.toml` on the server:

```toml
bindPort = 7000
vhostHTTPPort = 80
subdomainHost = "example.com"      # you own this; *.example.com points here
auth.method = "token"
auth.token = "<random token>"
```

For HTTPS, front the vhost port with any TLS proxy (Caddy with a wildcard
certificate is the usual choice).

On the machine running docklets:

```bash
./bin/connector.sh          # first run writes the config template and exits
$EDITOR ~/.config/docklets/connector.env
./bin/connector.sh          # runs in the foreground, reconnects automatically
```

Config fields:

| Field | Meaning |
|---|---|
| `TUNNEL_SERVER` | frps host |
| `TUNNEL_PORT` | frps bind port (default 7000) |
| `TUNNEL_TOKEN` | the auth token from the server config |
| `TUNNEL_NAME` | your subdomain claim, lowercase kebab-case |
| `LOCAL_PORT` | the docklets gateway port (default 8080; the admin port is refused) |
| `TUNNEL_PROTOCOL` | `tcp` (default) or `wss`; wss dials the edge as a TLS websocket, so it traverses HTTPS proxies and CDNs |
| `TUNNEL_CA_FILE` | wss only: CA bundle used to verify the edge certificate (default: the system bundle) |

Your asset root is then served at `http(s)://<TUNNEL_NAME>.<subdomainHost>/`,
with every slug at its usual `/<slug>/` route. New apps and sites appear on
the public URL the moment their files are written, exactly as they do locally.

## Dialing over websocket

When the edge sits behind an HTTPS ingress, reverse proxy, or CDN instead of
exposing a raw TCP port, set `TUNNEL_PROTOCOL=wss` and point `TUNNEL_SERVER`
and `TUNNEL_PORT` (usually 443) at that HTTPS front. The tunnel then rides as
an ordinary TLS websocket, which also works from networks that only allow
outbound HTTPS.

In wss mode the connector verifies the edge's certificate against the system
CA bundle, or against `TUNNEL_CA_FILE` for private CAs, and refuses to
connect if verification fails. The tunnel client sends heartbeats every 30
seconds, so any proxy on the path needs its read timeout above that;
90 seconds or more is a safe setting. See
[docs/edge.md](edge.md) for the matching edge-side ingress route.

## Running as a service

The connector runs in the foreground so any service manager can own it. macOS
launchd and Linux systemd both work with the same shape used by the installer
services: run `bash /path/to/docklets/bin/connector.sh`, restart always.

## Power-user alternative

If you prefer plain SSH over frp, a reverse tunnel achieves the single-tenant
version of the same thing without subdomain routing:

```bash
ssh -N -R 8080:127.0.0.1:8080 you@your-vps
```

and proxy your domain to that port on the VPS. The connector exists because
frp adds subdomain routing, token auth, and built-in reconnection on top.
