# Gateway image (ADR 0006 point 1): Caddy with the web client build in /srv/web. Build context: repository root.
# Updating the web client means rebuilding this image (docker compose up -d --build gateway).
FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS web

WORKDIR /app
COPY package.json package-lock.json ./
COPY services/video/package.json services/video/
COPY clients/web/package.json clients/web/
# Dev dependencies included: the build needs Vite. Only the web client's workspace is installed.
RUN npm ci --workspace clients/web --no-audit --no-fund && npm cache clean --force

COPY clients/web/ clients/web/
RUN npm run build --workspace clients/web

FROM caddy:2.11.8-alpine@sha256:70b3180738b46cd88e49b300d790ae448a0aca3f58edef0f000bb57d619a9ab3 AS gateway

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /app/clients/web/dist /srv/web
EXPOSE 8080
