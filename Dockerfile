# The docklets container: deployer, sync receiver, and tunnel connector in
# one image. Pair it with a stock caddy container serving the same folder
# (the gateway); see docs/container.md.
FROM node:20-alpine

RUN apk add --no-cache bash curl tini

WORKDIR /opt/docklets
COPY bin ./bin
COPY dashboard ./dashboard
COPY gateway ./gateway
COPY LICENSE package.json ./

# Bake the checksum-verified tunnel client so container start is offline.
RUN mkdir -p /opt/docklets/connector-home \
 && DOCKLETS_CONNECTOR_HOME=/opt/docklets/connector-home bash bin/connector.sh --fetch-only \
 && chown -R node:node /opt/docklets/connector-home

USER node
ENTRYPOINT ["/sbin/tini", "--", "/opt/docklets/bin/container-run.sh"]
