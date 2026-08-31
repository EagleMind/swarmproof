# The discovery engine as an HTTP service.
FROM node:22-alpine

WORKDIR /app

# Install deps first so a source change does not re-fetch the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Both caches — the DHT routing table (peerCache.js) and the crawler's index
# (dhtCrawler.js) — are written relative to the *working directory*, not to a
# configured path. So the working directory is the thing that has to move
# onto the volume; mounting some other directory would silently persist
# nothing. Source stays in /app and is addressed absolutely below.
RUN mkdir -p /app/state
WORKDIR /app/state
VOLUME /app/state

# Inside a container loopback is unreachable from outside it, so the engine
# has to bind 0.0.0.0 — which it refuses to do without the explicit flag.
# There is no authentication: put a proxy in front before exposing this.
ENV ENGINE_HOST=0.0.0.0 \
    ENGINE_ALLOW_PUBLIC=1 \
    ENGINE_PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "/app/server.js"]
