# docklets edge: frps from the pinned upstream release, checksum-verified at
# build time, on a plain alpine base. No third-party frp images in the chain.
#
# Build:  docker build -t docklets-edge edge/
# Run:    see edge/docker-compose.yml or docs/edge.md
FROM alpine:3.20
ARG FRP_VERSION=0.71.0
ARG TARGETARCH
RUN apk add --no-cache curl \
 && case "$TARGETARCH" in \
      arm64) SHA=f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266 ;; \
      *)     SHA=84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716 ;; \
    esac \
 && ARCH="${TARGETARCH:-amd64}" \
 && curl -fsSL -o /tmp/frp.tgz "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz" \
 && echo "$SHA  /tmp/frp.tgz" | sha256sum -c - \
 && tar -xzf /tmp/frp.tgz -C /tmp "frp_${FRP_VERSION}_linux_${ARCH}/frps" \
 && install -m 0755 "/tmp/frp_${FRP_VERSION}_linux_${ARCH}/frps" /usr/local/bin/frps \
 && rm -rf /tmp/frp.tgz "/tmp/frp_${FRP_VERSION}_linux_${ARCH}" \
 && apk del curl
USER nobody
ENTRYPOINT ["/usr/local/bin/frps"]
CMD ["-c", "/etc/frps/frps.toml"]
