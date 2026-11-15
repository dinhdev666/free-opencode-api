# Free OpenCode API — Docker Image

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)

Container image of [Free OpenCode API](https://github.com/dinhdev666/free-opencode-api), an OpenAI-compatible gateway for the OpenCode CLI.

The image bundles Node.js 22, the project source, and the OpenCode CLI (npm package `opencode-ai`), so nothing needs to be installed on the host. Project dependencies are installed with **pnpm** (enabled through Corepack and pinned by the `packageManager` field in `package.json`) using the committed `pnpm-lock.yaml`. Point any OpenAI client at the published port and start chatting with free models such as Kimi k2.5, GLM 4.7, and MiniMax m2.1.

---

## Table of Contents

- [Image Tag](#image-tag)
- [Quick Start](#quick-start)
- [OpenCode Authentication](#opencode-authentication)
- [API Self-Check](#api-self-check)
- [Configuration](#configuration)
- [Logging](#logging)
- [Exposing the 4097 Backend Port](#exposing-the-4097-backend-port)
- [Known Issues and Compatibility Fixes](#known-issues-and-compatibility-fixes)
- [Related Links](#related-links)

---

## Image Tag

| Tag | Description |
| --- | --- |
| `dinhdev666/free-opencode-api:latest` | Newest published release — OpenAI-compatible API gateway for the OpenCode CLI |
| `dinhdev666/free-opencode-api:1.0.0` | Pinned release tag |

Both tags are multi-architecture images (`linux/amd64` and `linux/arm64`); Docker pulls the variant that matches the
host, so no `--platform` flag is needed on Intel servers or Apple Silicon machines.

---

## Quick Start

```bash
docker pull dinhdev666/free-opencode-api:1.0.0

docker run -d \
  --restart=always \
  --network common-all \
  --name free-opencode-api \
  --privileged \
  -p 8083:8083 \
  dinhdev666/free-opencode-api:1.0.0
```

The service is then reachable at `http://<your-ip>:8083`.

> The `--network common-all` flag is optional — it just attaches the container to an existing user-defined network. Drop it if you do not use one.

---

## OpenCode Authentication

The OpenCode CLI inside the container must be authenticated before it can call model providers. Choose one option:

**Option 1 — log in inside the container** (follow the prompts to pick a provider and authorize):

```bash
docker exec -it free-opencode-api opencode auth login
```

**Option 2 — mount credentials already created on the host** (`~` is the host user's home; the container runs as root):

```bash
docker run -d \
  --restart=always \
  --network common-all \
  --name free-opencode-api \
  --privileged \
  -p 8083:8083 \
  -v ~/.local/share/opencode:/root/.local/share/opencode \
  dinhdev666/free-opencode-api
```

---

## API Self-Check

Health probe (`/health` is the only unauthenticated route besides `/`):

```bash
curl http://127.0.0.1:8083/health
```

The image also declares a `HEALTHCHECK` that calls the same endpoint (it follows `-e PORT=...`), so
`docker ps` shows `healthy` once the gateway is listening and `docker inspect` reports the failure count:

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
```

Model list:

```bash
curl -H "Authorization: Bearer sk-dummy-123" http://127.0.0.1:8083/v1/models
```

Chat completion (non-streaming):

```bash
curl -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-dummy-123" \
  -d '{"model":"opencode/kimi-k2.5-free","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

> `sk-dummy-123` is the built-in default key; the container never runs without authentication.

---

## Configuration

Configuration is no longer baked in at build time. On the container's **first boot** (no `/app/config.json` inside the container), the entrypoint `docker-entrypoint.sh` generates `/app/config.json` from the `docker run -e` variables; every subsequent start reuses the existing file as-is.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8083` | Gateway listen port |
| `API_KEY` | `sk-dummy-123` | Gateway auth key; mandatory — an empty value falls back to the default key instead of disabling authentication |
| `BIND_HOST` | `0.0.0.0` | Must listen on `0.0.0.0` inside the container for port mapping to work (the program default is `127.0.0.1`; the entrypoint overrides it) |
| `DISABLE_TOOLS` | `true` | Disables OpenCode tool calls so the model cannot run commands or modify files in the container (`1`, `true`, `yes`, `on` turn it on; `0`, `false`, `no`, `off` turn it off) |
| `OPENCODE_PATH` | empty (auto-detect) | Path to the `opencode` executable; when empty it is resolved through `PATH` (npm global install puts it at `/usr/local/bin/opencode`), and the program also probes `~/.opencode/bin` and the npm/pnpm global directories |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4097` | Address of the OpenCode backend the gateway launches internally; rarely needs changing |
| `OPENCODE_USE_ISOLATED_HOME` | unset | Runs the backend with a throwaway `HOME` inside the container (the container is already isolated, so this is rarely needed) |
| `OPENCODE_BIND_HOST` | `0.0.0.0` | Listen address of the OpenCode backend (4097), `0.0.0.0` by default inside the container; the program default is `127.0.0.1` (non-container behavior unchanged). See [Exposing the 4097 Backend Port](#exposing-the-4097-backend-port) |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` (case-insensitive; invalid values fall back to `info` with a warning). **Exception: never written into `config.json` — the Node process reads the environment directly, so it takes precedence over the `LOG_LEVEL` field there.** See [Logging](#logging) |

Example with a custom API key (authentication is always on; omitting `API_KEY` uses `sk-dummy-123`):

```sh
docker run -d --restart=always --network common-all --name free-opencode-api --privileged -p 8083:8083 \
  -e PORT=8083 -e API_KEY=your-key -e DISABLE_TOOLS=true \
  dinhdev666/free-opencode-api
```

> Advanced tuning variables (`OPENCODE_PROXY_REQUEST_TIMEOUT_MS`, `OPENCODE_PROXY_HEALTH_CACHE_MS`,
> `OPENCODE_PROXY_START_RETRY_MS`, `OPENCODE_PROXY_MAX_CONCURRENCY`, `OPENCODE_PROXY_MAX_QUEUE`, `LOG_LEVEL`) are read
> from the environment at runtime and documented in the main [README](../README.md#configuration).

### Precedence rules

- `-e` values are read **only on the first boot**, when `config.json` is generated. If `/app/config.json` already exists it is used as-is and **not overwritten by `-e`** (for example a config persisted with a `-v` mount wins over `-e`).
- **`LOG_LEVEL` is the exception**: it is never written into `config.json`; the Node process reads it from the environment, so `docker run -e LOG_LEVEL=...` applies on every start (env > the `LOG_LEVEL` field in `config.json` > default `info`).
- To regenerate from new `-e` values, delete the mounted `config.json` (or drop the `-v` mount) and recreate the container.
- At runtime settings are read as **`config.json` > built-in `OPENCODE_`-prefixed environment variables (e.g. `OPENCODE_DISABLE_TOOLS`) > built-in defaults**, so the generated `config.json` is the effective configuration (`LOG_LEVEL` excepted, see above).

---

## Logging

All logs go to stdout/stderr (visible through `docker logs`), prefixed with `[gateway]`, in the format:

```text
[gateway] <ISO time> [LEVEL] message {"detail":"json"}
```

`error`/`warn` are written to stderr, `info`/`debug` to stdout. Control verbosity with `docker run -e LOG_LEVEL=<level>` (case-insensitive; invalid values fall back to `info` with a warning; the image default is `info`):

```bash
docker run -d --restart=always --name free-opencode-api -p 8083:8083 -e LOG_LEVEL=debug dinhdev666/free-opencode-api
```

| Level | Output |
| --- | --- |
| `error` | Upstream (opencode serve, 4097) request failures/errors with status code and error-body summary — always emitted — plus fatal startup problems |
| `warn` | Invalid `LOG_LEVEL` fallback warnings and self-recoverable anomalies |
| `info` (default) | Startup information (including the effective log level) and **a one-line summary per OpenAI-compatible request**: method, path, model, streaming, response status, latency in ms, request id (all lines for one request share the same id). Non-`/v1/` paths such as `/health` are only logged at `debug` to avoid noise |
| `debug` | Adds inbound requests (sensitive headers already masked), the **final payload** sent to `opencode serve`, and full responses (complete JSON for non-streaming; for SSE only an end-of-stream summary: chunk count, text length, `finish_reason`) |

Example `docker logs` output per level:

```text
# info (default: one-line summary per request + startup info)
[gateway] 2026-11-06T12:00:00.000Z [INFO] Log level: info (source: LOG_LEVEL)
[gateway] 2026-11-06T12:00:00.123Z [INFO] [Proxy] Active at http://0.0.0.0:8083
[gateway] 2026-11-06T12:00:05.456Z [INFO] POST /v1/chat/completions -> 200 3210ms [gw-m1abc2x3] model=opencode/kimi-k2.5-free stream=true
[gateway] 2026-11-06T12:00:12.789Z [INFO] POST /v1/chat/completions -> 200 4822ms [gw-n4def5y6] model=opencode/glm-4.7-free stream=false

# debug (additionally logs full request bodies and responses; sensitive headers masked)
[gateway] 2026-11-06T12:00:05.010Z [DEBUG] Incoming OpenAI request {"reqId":"gw-m1abc2x3","headers":{"authorization":"Bear***c9Zw","content-type":"application/json"},"body":{"model":"opencode/kimi-k2.5-free","messages":[...],"stream":true}}
[gateway] 2026-11-06T12:00:05.032Z [DEBUG] Upstream payload (final request body to opencode serve) {"reqId":"gw-m1abc2x3","sessionId":"ses_...","model":"opencode/kimi-k2.5-free","payload":{"path":{"id":"ses_..."},"body":{"model":{...},"system":"...","parts":[...],"tools":{...}}}}
[gateway] 2026-11-06T12:00:05.460Z [DEBUG] SSE stream summary {"reqId":"gw-m1abc2x3","chunks":12,"contentChars":866,"reasoningChars":0,"finishReason":"stop"}
[gateway] 2026-11-06T12:00:12.780Z [DEBUG] Upstream response (non-stream full JSON) {"reqId":"gw-n4def5y6","response":{"id":"chatcmpl-...","choices":[{"message":{"content":"..."}}],"finish_reason":"stop"}}

# error (always emitted on upstream failure, with status code and error-body summary)
[gateway] 2026-11-06T12:01:00.000Z [ERROR] [Proxy] API Error (upstream call failed) {"reqId":"gw-o7ghi8z9","sessionId":"ses_...","message":"Request timeout after 300000ms","status":null,"bodySummary":null}

# invalid level fallback warning
[gateway] 2026-11-06T12:02:00.000Z [WARN] Invalid LOG_LEVEL 'verbose', fallback to 'info' (valid values: error/warn/info/debug)
```

---

## Exposing the 4097 Backend Port

When the gateway (8083) starts it launches the `opencode serve` backend (4097) inside the container. The backend listen address is controlled by `OPENCODE_BIND_HOST`: `0.0.0.0` by default when the entrypoint generates the config, while the program default is `127.0.0.1` (loopback only — unreachable from outside the container).

To reach 4097 directly from outside, add the port mapping `-p 4097:4097`:

```bash
docker run -d \
  --restart=always \
  --network common-all \
  --name free-opencode-api \
  --privileged \
  -p 8083:8083 \
  -p 4097:4097 \
  dinhdev666/free-opencode-api
```

Notes:

- `OPENCODE_BIND_HOST` only controls the OpenCode backend (4097); the gateway's own listen address (8083) is controlled by `BIND_HOST` — the two are independent.
- The gateway always reaches the backend through `OPENCODE_SERVER_URL` (default `http://127.0.0.1:4097`); `OPENCODE_BIND_HOST=0.0.0.0` does not affect gateway-to-backend traffic inside the container, since `0.0.0.0` also covers loopback.
- To return to container-only access, set `OPENCODE_BIND_HOST=127.0.0.1`.
- Gotcha: `-e` is only read when `/app/config.json` is generated on the **first boot**. If the file already exists (e.g. from a `-v` mount), `-e` has no effect — edit the mounted `config.json` (set `OPENCODE_BIND_HOST` to `0.0.0.0`) or delete it and recreate the container.

---

## Known Issues and Compatibility Fixes

Two OpenCode 1.19.5 compatibility issues are fixed directly in [`src/proxy.js`](../src/proxy.js) of the source repository, not patched inside the image. The image builds straight from the repository and the Dockerfile contains no runtime patching step.

**Fix 1 — tool hang.** With opencode ≥ 1.19 and a free zen model (e.g. `opencode/deepseek-v4.1-flash-free`), `DISABLE_TOOLS=true` (the image default) disables every OpenCode tool, and as soon as either `read` or `glob` is disabled the prompt request hangs forever — the gateway never returns content. The fix keeps the two read-only tools `read` and `glob` enabled while still disabling every other tool (bash/edit/write/task/webfetch/question/grep/skill…). Both are read-only with no write or execution capability, and `stripFunctionCalls` output filtering plus the `TOOL_GUARD_MESSAGE` system prompt act as a second line of defense.

**Fix 2 — streaming SSE compatibility.** In opencode ≥ 1.19, SSE `message.part.updated` events carry no `properties.delta`, and `part.text` holds the part's **current full text**. Reading the increment via `const { part, delta } = event.properties` therefore always yielded `undefined`, so streams carried no content and only a finish chunk; worse, a fast assistant finish delivers `message.updated(finish=stop)` before the 4s first-chunk timer, resolving the collector early with empty content — a path the existing noData/idleTimeout fallbacks never covered (non-streaming responses were unaffected). The fix prefers `properties.delta` when present (older versions) and otherwise derives the increment by diffing `part.text` against what has already been accumulated (`startsWith` check followed by `slice`); when nothing has been streamed at all, it polls `pollForAssistantResponse` once for the full reply (filtered through `stripFunctionCalls`), and emits no delta if polling is also empty.

---

## Publishing a Release

The image is published by `.github/workflows/docker-publish.yml`. Pushing a version tag builds
`linux/amd64` + `linux/arm64` and pushes the version tag and `latest` (whole versions only — no floating `1` or `1.2`):

```bash
# package.json version and the tag must match; the workflow fails otherwise
git tag v1.0.1
git push origin v1.0.1
```

The workflow needs two repository secrets (Settings → Secrets and variables → Actions):
`DOCKERHUB_USERNAME` (the Docker Hub account) and `DOCKERHUB_TOKEN` (an access token with Read & Write scope, not the
account password). Builds run on GitHub-hosted runners, so no local Docker installation is required.

To publish from this machine instead:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f docker/Dockerfile -t dinhdev666/free-opencode-api:1.0.0 --push .
```

The image installs the OpenCode CLI from npm at build time. Pass `--build-arg OPENCODE_VERSION=<version>` to pin it
(the default is `latest`, so two builds of the same tag can differ); the version that ended up in a running container
is available with `docker run --rm <image> opencode --version`.

---

## Related Links

- Repository: [dinhdev666/free-opencode-api](https://github.com/dinhdev666/free-opencode-api)
- Project overview: [README.md](../README.md)
- OpenCode: [opencode.ai](https://opencode.ai)
- License: [MIT](../LICENSE)
