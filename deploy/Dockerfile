# Sparrow — single-container image (Node 22, zero build step)
#
# Build:  docker build -t sparrow -f deploy/Dockerfile .
# Run:    docker run -d --name sparrow \
#           -p 127.0.0.1:8080:8080 \
#           -v sparrow-data:/data \
#           -e REDEX_DATA_DIR=/data/engine \
#           -e REDEX_SQLITE_PATH=/data/control.db \
#           -e REDEX_RESP_PORT=0 \
#           --restart unless-stopped \
#           sparrow
#
# Put Caddy/nginx (or any TLS proxy) in front for HTTPS.

FROM node:22-alpine

# node:sqlite needs no native deps; the app has zero runtime dependencies
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin

ENV NODE_ENV=production \
    REDEX_HOST=0.0.0.0 \
    REDEX_PORT=8080

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
