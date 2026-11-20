# =====================================================================
# Free OpenCode API container image
# Source repository: https://github.com/dinhdev666/free-opencode-api
# Purpose: a lightweight gateway that turns the OpenCode CLI into an OpenAI-compatible API,
#          so standard OpenAI clients such as Cursor / Claude Code can use free models directly
# Build note: build from the repository root, e.g.
#             docker build -f docker/Dockerfile -t dinhdev666/free-opencode-api .
#             CI (.github/workflows/ci.yml) builds the same way and then checks that /health answers
# Runtime user: the container runs as the unprivileged `node` user (uid/gid 1000), never as root. Bind mounts and
#             volume permissions therefore have to match that uid - see the "Running as a Non-Root User" section of
#             docker/README.md.
# =====================================================================

# Base image: node 22 + debian bookworm slim
# slim instead of alpine: a glibc environment is more reliable for node native dependencies and the opencode binary,
# avoiding musl pitfalls
# If Docker Hub pulls are slow on your host, configure a registry mirror on the builder beforehand
# Pinned by digest as well as by tag: every GitHub action in .github/workflows is pinned by SHA and checked in CI, while
# the base image - the layer everything else is built on - was the one mutable reference left, so two builds of the same
# commit could differ by a Debian point release or a rebuilt upstream image. The digest is the multi-arch index for
# `22-bookworm-slim`; Dependabot is off for this repository (AGENTS.md), so the tag and the digest are refreshed by
# hand, together:
#   docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}'
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# OCI image metadata. The copyright holder is part of the project's invariants (AGENTS.md), and an image without any
# LABEL leaves registries, scanners and `docker inspect` with nothing to attribute it to.
LABEL org.opencontainers.image.title="free-opencode-api" \
      org.opencontainers.image.description="OpenAI-compatible HTTP gateway for the OpenCode CLI, with an OpenAI endpoint, streaming and a managed backend" \
      org.opencontainers.image.authors="Phạm Văn Định" \
      org.opencontainers.image.url="https://github.com/dinhdev666/free-opencode-api" \
      org.opencontainers.image.source="https://github.com/dinhdev666/free-opencode-api" \
      org.opencontainers.image.documentation="https://github.com/dinhdev666/free-opencode-api/blob/main/docker/README.md" \
      org.opencontainers.image.licenses="MIT"

# The slim image drops git / curl, so install them here:
#   git  -> opencode CLI repository-related features depend on git
#   curl -> for debugging inside the container / health checks (/health)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# /app itself has to belong to the runtime user: the entrypoint writes /app/config.json on first boot. The *contents*
# get their ownership from `COPY --chown` below, so this is a metadata-only layer instead of a `chown -R` that rewrote
# the already-installed node_modules into a second full copy (measured 17 MB in the published image).
RUN chown node:node /app

# Enable pnpm through Corepack (bundled with Node.js); the exact version comes from the
# "packageManager" field in package.json
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

# Copy only the manifests first so the dependency layer is cached across source changes
COPY --chown=node:node package.json pnpm-lock.yaml ./

# Install production dependencies with pnpm (pure JS dependencies, no local compilation needed)
# --frozen-lockfile guarantees the image is built from the committed lockfile
RUN pnpm install --frozen-lockfile --prod

# Install the opencode CLI inside the image (the gateway detects and launches the opencode backend on startup)
# Approach: the official npm package @opencode/cli, which installs the `opencode` executable into the npm global bin
#           directory, i.e. /usr/local/bin/opencode
# (npm is only used here to install this third-party CLI, not for the project's own dependencies)
# OPENCODE_VERSION pins it for reproducible builds AND for the API the gateway drives: the 2.x line is the one whose
# `serve` exposes the `/api/...` session routes and authenticates them with its own server password, which is what this
# gateway speaks. A 1.x release has no `/api` routes at all, so every completion in such an image failed with a 502
# naming a backend that would not start. Override to try another 2.x release:
#   docker build --build-arg OPENCODE_VERSION=2.3.2
# This step runs **before** the source is copied in, and that order is the point: it was after `COPY . .`, so every
# change to any file in the repository invalidated this layer and re-downloaded the CLI (~100 MB, and a full `npm
# install -g` of it) even though nothing about the CLI had changed. Docker can only reuse a layer while its own
# instruction and the layers before it are unchanged, and a source file is not an input to this step.
ARG OPENCODE_VERSION=2.3.2
RUN npm install -g "@opencode/cli@${OPENCODE_VERSION}" \
    && npm cache clean --force
# Alternative (if the npm package installation has problems, use the official install script):
# RUN curl -fsSL https://opencode.ai/install | bash

# Copy the rest of the source (the build context is the repository root). --chown avoids a second full copy of the tree
# in a following `RUN chown -R`, which is what the image used to carry.
COPY --chown=node:node . .

# Entry script: on first boot generates /app/config.json from `docker run -e` environment variables
# (supports PORT/API_KEY/BIND_HOST/OPENCODE_PATH/OPENCODE_SERVER_URL/OPENCODE_BIND_HOST, plus DISABLE_TOOLS and
# USE_ISOLATED_HOME under either their bare or their OPENCODE_-prefixed name; OPENCODE_SERVER_PASSWORD is written into
# that config.json like every other key, and the first-boot log dump masks it with the other secrets - when it is left
# blank the gateway generates a password for its own process and hands that value to the backend it spawns)
# This file lives in docker/ inside the repository, so the COPY below picks it up from the build context
# --chmod sets the executable bit in the layer itself: a separate `RUN chmod +x` cost another layer for one mode bit
COPY --chown=node:node --chmod=0755 docker/docker-entrypoint.sh /app/docker-entrypoint.sh

# Drop root: everything below runs as the unprivileged `node` user (uid/gid 1000) that the official base image ships.
# Without this the gateway, the `opencode serve` backend it spawns and every tool that backend runs all run as UID 0.
# The CLI install above deliberately stays before this point: `npm install -g` writes into the global prefix
# (/usr/local/lib/node_modules, /usr/local/bin), which only root can do.
# /app belongs to `node:node` (see the COPY --chown steps above) because the entrypoint writes /app/config.json into it
# on first boot (mode 0600) and because a bind-mounted config.json or an isolated backend jail must be
# readable/writable by the same uid - see docker/README.md.
# HOME resolves to /home/node (from /etc/passwd), which the base image already owns for this user; `opencode serve`
# needs it to be writable for its own state.
USER node

# Gateway listen port (matches the default PORT in the config.json generated by docker-entrypoint.sh)
EXPOSE 8083

# Standard production mode: dependencies are installed with --prod above and libraries that branch on NODE_ENV
# (Fastify included) take their production path
ENV NODE_ENV=production

# Health check uses the same /health endpoint the CI smoke suite asserts. The port is resolved with the gateway's own
# rule (`envOrFile()` plus `index.js`'s validator), not a second one: a `PORT` that is present and readable wins and is
# validated on its own, a blank or absent one falls back to /app/config.json, and anything else falls back to 8083. The
# probe used to fall through to the file when the environment value was invalid, which the gateway never does - so
# `-e PORT=8086x` with 8086 in the file made the gateway serve 8083 while the probe watched 8086, and a container that
# was serving every request reported itself unhealthy for its whole life. The value is trimmed and digit-checked with
# `[0-9]` (a `\d` reaches the shell-embedded program as a literal backslash and a `d`, so every port read as invalid).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD port=$(node -e 'const fs=require("fs");const ok=(v)=>/^[0-9]{1,5}$/.test(v)&&Number(v)>0&&Number(v)<65536;const fromEnv=String(process.env.PORT??"").trim();if(fromEnv!==""){process.stdout.write(ok(fromEnv)?fromEnv:"8083");process.exit(0)}let fromFile="";try{fromFile=String(JSON.parse(fs.readFileSync("/app/config.json","utf8")).PORT??"").trim()}catch(e){}process.stdout.write(ok(fromFile)?fromFile:"8083")') && curl -fsS "http://127.0.0.1:${port}/health" || exit 1

# Log level: one of error/warn/info/debug, case-insensitive; invalid values fall back to info with a warning. The
# precedence is the project-wide one - env > config.json > default - so no ENV line is set here: an image-level
# `ENV LOG_LEVEL=info` made the documented `LOG_LEVEL` field in config.json unreachable inside the container, because
# the environment always won and always had a value. `docker run -e LOG_LEVEL=debug` (or the file) raises the detail:
#   info: startup info + a one-line summary per request (method/path/model/streaming/status/latency/request id)
#   debug: additionally logs the final request body forwarded to opencode and full responses
#          (full JSON for non-streaming; end-of-stream summary for SSE)
#   error: upstream (4097) request failures/errors are always logged, with status code and error-body summary

# opencode serve backend port (4097)
# The backend listens on loopback by default (OPENCODE_BIND_HOST=127.0.0.1, written by the entrypoint). It is not
# unauthenticated - the 2.x server requires HTTP Basic on every /api/* route and the gateway generates the password and
# hands it to the child - but it is still not the gateway: publishing it would put the backend API and its web UI
# outside the gateway's own API key, and the password would travel to every peer that reaches the port.
# `-e OPENCODE_BIND_HOST=0.0.0.0` plus `-p 4097:4097` is the documented opt-in. The gateway itself always reaches the
# backend through OPENCODE_SERVER_URL (default http://127.0.0.1:4097) and is unaffected by this variable.
EXPOSE 4097

# Entry: the entrypoint first generates or reuses config.json from -e variables, then starts the CMD below
ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Startup command: package.json's main is index.js and the start script is `node index.js`
CMD ["node", "index.js"]
