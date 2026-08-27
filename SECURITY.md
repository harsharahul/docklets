# Security model

docklets exists to let **untrusted code generators** (AI agents) ship running
web apps without ever holding deploy credentials or Docker access. The design
goal is not "apps cannot be malicious"; it is "a malicious app, or a malicious
agent, is trapped with a small, well-defined blast radius."

## The core idea: no network control plane

Cloud function platforms are driven by control-plane APIs and credentials;
cluster platforms by a gateway REST API and registry pushes. Both are
privileged *network* surfaces: things that can be phished, leaked, or scanned.

The docklets control plane is a **directory**. Deploy authority equals write
access to the asset root. There are no deploy tokens to steal and no admin
endpoint listening anywhere. Sandboxing an agent down to "may write one
folder" is the entire permission model, and it composes with whatever sandbox
your agent framework already has.

## Boundaries (defense in depth)

```
1. AGENT BOUNDARY      agent sandbox mounts ONLY the asset root read-write.
                       No docker socket, no host FS. A fully compromised
                       agent's strongest move is deploying an app, which
                       lands in boundary 2.

2. APP SANDBOX         per docklet: runs as the deployer's uid, not root ·
                       cap-drop ALL · no-new-privileges ·
                       memory & pid caps · --init · code read-only at /src ·
                       writable ONLY its own /data · NO published ports ·
                       reachable only via the gateway's internal network.

3. GATEWAY SANDBOX     Caddy in a container: read-only rootfs, caps dropped,
                       asset tree mounted read-only, admin API bound to
                       localhost INSIDE the container's network namespace
                       (used solely for `docker exec ... caddy reload`).

4. HOST                the deployer is the only Docker-privileged component:
                       a script of about 250 lines owned by the operator, not
                       written or writable by agents, listening on nothing.
```

### Blast-radius table

| Fully compromised…    | Attacker gains                          | Attacker does **not** gain |
|-----------------------|-----------------------------------------|----------------------------|
| a deployed app        | its own `/data`, its RAM/pid budget, outbound net | host FS, other apps' data, docker, the gateway |
| the agent             | ability to write/overwrite assets and manifests | docker, host FS, the deployer, any credentials |
| the gateway (0-day)   | read-only view of the asset tree        | host FS, any writes, admin from outside |
| a gateway with a deploy API (the comparison point) | deploy-anything admin surface | |

### Why file-serving is containerized at all

A static file server running *on the host* follows symlinks: an asset
containing `ln -s ~/.ssh/id_rsa steal` would serve your SSH key to the
internet. (We verified this failure mode against a host-run file server before
adopting the container design.) Inside the gateway container the host
filesystem simply does not exist: the same symlink dangles and returns 404.
Path traversal likewise dead-ends at `/srv`.

### Manifest validation

The deployer validates before running anything: slug must match
`^[a-z0-9][a-z0-9-]{0,40}$`, `entry` may not be absolute or contain `..`,
`port` must be 1-65535, env keys must be `[A-Za-z_][A-Za-z0-9_]*`, and
symlinked manifests are ignored. Unknown runtimes are skipped, never guessed.

## Admin plane

Off by default. When enabled (`DOCKLETS_ADMIN_PORT`), a daemon inside the
deployer serves a token-authenticated UI and API on `127.0.0.1` only. It is
designed against these attackers: deployed apps (which can reach host
loopback through `host.docker.internal`), agents (which write the asset
root), and hostile pages in the operator's browser.

| Attack | Defense |
|---|---|
| App or agent reads the token | Token at `~/.config/docklets/admin-token` (0600), outside the asset root; never in env or argv; generated once, atomically |
| Shared-origin JS steals the token | Admin UI is served from its own origin (`127.0.0.1:<port>`), never from the public gateway |
| DNS rebinding | Strict Host-header allowlist; foreign hosts get 403 |
| CSRF / cross-origin calls | No cookies at all; bearer header forces a preflight; zero CORS headers are ever sent |
| Container brute-forces the token | 32 random bytes, constant-time comparison; failures logged (rate-limited); deliberately no lockout, which would let an app deny the operator service |
| Injection via slug parameters | Slug pattern validation plus existence check; all docker invocations are argument arrays, never shells |
| Token file unreadable | Fails closed: every request 503s; the converge loop keeps running |
| Reverse proxy exposes the port | Binds loopback only; do not proxy the admin port. Remote administration means reaching the machine over your own VPN or tailnet |

The action set is lifecycle-only (restart, pause, resume, log tail). Pause and
resume are filesystem operations (`app.json` renamed to `app.json.paused` and
back) that the converge loop applies. There is no deploy, delete, or
config-change endpoint.

Residual risks, stated plainly: an operator can be phished into pasting the
token into a lookalike page (the real UI exists only at `127.0.0.1:<port>`,
and the public dashboard states it never asks for a token); and any process
already running as the operator's user can read the token file, which is the
same class of compromise as reading any other credential on the machine.

## Tunnel connector

The connector (`bin/connector.sh`) only ever dials out, and it forwards edge
traffic to the gateway port alone; tunneling the admin port is refused
outright, so the admin plane stays local with or without a tunnel. The tunnel
token is an ingress credential: leaking it lets someone impersonate the
tunnel's route, never write files or deploy anything. The frp client binary
is version-pinned and sha256-verified per platform before first use.

Transport security: in the default tcp mode the client-to-edge connection
runs with TLS enabled. In wss mode (`TUNNEL_PROTOCOL=wss`, for edges behind
an HTTPS proxy or CDN) the connector verifies the edge certificate against
the system CA bundle, or against `TUNNEL_CA_FILE` when set, and refuses to
connect if verification fails. CI asserts both the refusal without trust and
end-to-end traffic through a TLS-terminating proxy.

## Known limitations

1. **Apps have outbound internet.** Needed for `npm install` and for apps that
   call external APIs. A malicious app can exfiltrate *its own* data outward.
   Per-app egress policy is the top roadmap item; until then, do not feed
   secrets to apps you did not review.
2. **Apps share one origin.** Every slug lives under one host:port, so
   malicious JS in one app can read another app's `localStorage`/cookies in a
   visitor's browser. Host-side isolation is unaffected. If you serve
   untrusted users next to sensitive apps, use separate roots today or the
   subdomain mode on the roadmap.
3. **All apps run as the same non-root user.** App processes run as the
   deployer's uid (never container root), which removes root-in-container
   from the attack surface. The uid is shared across apps, so isolation
   between apps rests on the container boundary and per-app mounts, not on
   distinct users. A container-escape-class kernel/runtime vulnerability
   remains the escalation path out of the sandbox.
4. **No auth on the gateway.** Everything served is public to whoever can
   reach the port. Gate it at your reverse proxy, or keep it LAN/tailnet-only.
5. **The deployer trusts its own code.** It runs `docker` on the host. Protect
   the repo checkout like you would protect any host software; never place it
   inside the agent-writable asset root.
6. **Resource caps are per-app, not global.** Many manifests means many
   containers. The slug namespace is bounded (41 chars, one level), but an
   agent spamming manifests can still start many 512 MB containers; cap the
   agent, or watch `docker ps`, if that is a concern.

## Reporting

Open a GitHub issue (or a private security advisory) with reproduction steps.
The deployer is deliberately small; patches welcome.
