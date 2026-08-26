# Running your own tunnel edge

The edge is the server half of the tunnel: connectors dial it, and it routes
`<name>.your-domain` traffic down the right tunnel. It ships in `edge/` and
scales from a single container on a small VPS to sharded deployments on a
Kubernetes cluster, with the same configuration shape at every size.

## Size 1: one container on any host

```bash
cd edge
cp frps.toml.example frps.toml     # set subdomainHost and a random token
docker compose up -d
```

Point `*.your-domain` DNS at the host and front port 8080 with any TLS proxy
(Caddy with a wildcard certificate is the usual choice; a proxying CDN also
works). Connectors dial port 7000 with the token.

The image builds from `edge/Dockerfile`: the upstream frp release binary,
pinned by version and sha256, on a plain alpine base, running as `nobody`
with capabilities dropped by the compose file.

## Size 2: Kubernetes (k3s and up)

```bash
kubectl apply -f edge/k8s/edge.yaml
kubectl -n docklets-edge create secret generic frps-auth \
  --from-literal=token="$(openssl rand -hex 24)"
kubectl -n docklets-edge rollout restart deploy/frps-shard-1
```

Edit the `subdomainHost` in the ConfigMap to your domain, expose the
`frps-tunnel` Service to your connectors (NodePort, LoadBalancer, or LAN-only)
and route your ingress, Host header preserved, to the `frps-vhost` Service.
TLS terminates wherever it already does in your stack.

## Scaling: shards, not replicas

A tunnel is a sticky TCP connection between one connector and one frps
process, so the edge does not scale by adding replicas behind a load balancer.
It scales by adding **shards**: additional single-replica Deployments
(`frps-shard-2`, ...), each with its own tunnel Service, with connectors
assigned per shard and the ingress routing each tenant's hostname to its
shard's vhost Service. A restarted shard only blips its own tenants, and
connectors reconnect automatically.

## Connecting a machine

On each machine running docklets, fill `~/.config/docklets/connector.env`
with the edge host, port, token, and a subdomain name, then run
`bin/connector.sh` (see [docs/tunnel.md](tunnel.md)). The asset root appears
at `https://<name>.your-domain/` while all files, containers, and data stay
on that machine.

## Security notes

- The token authenticates connectors, not visitors. Treat it like the ingress
  credential it is: it can claim a subdomain route, nothing more.
- The edge sees plaintext HTTP between TLS termination and the tunnel; run
  the TLS terminator and the edge on the same host or network you trust.
- The vhost port serves whatever tenants publish. If the edge is public,
  so are they; gate at your proxy if you want auth in front.
