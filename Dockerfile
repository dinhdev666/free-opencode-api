# syntax=docker/dockerfile:1
#
# Container image for the OpenAI-compatible opencode proxy.
#
# The image is deliberately small and does not write any log files.

FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Install dependencies first so the layer is cached.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod


FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Free OpenCode API" \
      org.opencontainers.image.description="OpenAI-compatible REST API proxy that reuses the AI models authenticated in the opencode CLI" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/dinhdev666/free-opencode-api"

# `curl` is only used by the health check, `tini` reaps the opencode child
# process.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=20128 \
    LOG_LEVEL=silent \
    SPAWN_OPENCODE=true \
    OPENCODE_HOST=127.0.0.1 \
    OPENCODE_PORT=4096

COPY --from=deps /app/node_modules ./node_modules
COPY package.json opencode.json ./
COPY src ./src

# The opencode CLI writes its state (sessions, credentials, logs) under
# $XDG_DATA_HOME/opencode and its configuration under $XDG_CONFIG_HOME/opencode.
# Mount a volume on /data to keep the provider credentials across restarts.
#
# NOTE: there is deliberately no VOLUME instruction here. Railway rejects a
# Dockerfile that contains VOLUME ("The Dockerfile failed validation"); the
# volume has to be attached in the Railway dashboard instead.
ENV XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data/config \
    OPENCODE_DISABLE_AUTOUPDATE=1
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 20128

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
