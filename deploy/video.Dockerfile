# Video Service image (ADR 0001, ADR 0006). Build context: repository root.
# Node 26 LTS runs TypeScript directly (type stripping): no build step.
FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS runtime

# jellyfin-ffmpeg 8 (H10: CUDA/NVENC/tonemap_cuda available when the GPU override is used).
# fonts-dejavu-core: the font libass falls back to for a burn-in (SRT, or ASS without attachments); named
# here rather than left to fontconfig's dependency choice.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian trixie main" > /etc/apt/sources.list.d/jellyfin.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends jellyfin-ffmpeg8=8.1.3-2-trixie fonts-dejavu-core \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/lib/jellyfin-ffmpeg/ffmpeg \
    FFPROBE_PATH=/usr/lib/jellyfin-ffmpeg/ffprobe \
    DATA_DIR=/data \
    PORT=8096

WORKDIR /app
COPY package.json package-lock.json ./
COPY services/video/package.json services/video/
COPY clients/web/package.json clients/web/
RUN npm ci --omit=dev --workspace services/video --no-audit --no-fund && npm cache clean --force

# Owned by the runtime user, so `docker compose watch` can sync into src and contract/dist (its tar runs as node).
COPY --chown=node:node services/video/ services/video/

# Mount points owned by the runtime user (uid 1000, as compose.yaml runs it), so named volumes are initialised
# writable (m2). /data/secrets holds the profile-token signing key: owner only.
RUN mkdir -p /data/db /data/cache /data/artwork /data/thumbnails /data/scratch /data/backup /data/secrets /media \
 && chown -R node:node /data \
 && chmod 700 /data/secrets

USER node
WORKDIR /app/services/video
EXPOSE 8096
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8096/video/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
