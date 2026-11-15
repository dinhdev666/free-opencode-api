# Free OpenCode API

[![CI](https://github.com/dinhdev666/free-opencode-api/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhdev666/free-opencode-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20compatible-412991.svg)](#api-reference)

**Free OpenCode API** turns the [OpenCode](https://opencode.ai) CLI into a standard, OpenAI-compatible REST API. It runs as a small Node.js gateway in front of `opencode serve`, so any client that understands the OpenAI protocol — Cursor, Claude Code, the official OpenAI SDKs, or your own scripts — can use free models such as **Kimi k2.5**, **GLM 4.7**, and **MiniMax m2.1** without a paid API key.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Performance](#performance)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Client Examples](#client-examples)
- [Logging](#logging)
- [Docker](#docker)
- [CI and Releases](#ci-and-releases)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **OpenAI-compatible surface** — `/v1/models`, `/v1/chat/completions`, streaming and non-streaming responses.
- **Zero extra infrastructure** — one Node.js process; the OpenCode backend is launched and supervised automatically.
- **Mandatory authentication** — every request needs `Authorization: Bearer <key>`. The default key is `sk-dummy-123`, and authentication cannot be disabled: a blank `API_KEY` simply falls back to that default.
- **Tool guard** — `DISABLE_TOOLS=true` keeps models from running commands or touching files on the host.
- **Structured logging** — `error` / `warn` / `info` / `debug` levels, one-line request summaries, secrets masked.
- **Production friendly** — configurable bind host, request timeouts, graceful shutdown, Docker image available.
- **Fast HTTP stack** — built on Fastify 5 with precompiled response schemas and no per-request middleware chain.

---

## How It Works

```text
OpenAI client  ──HTTP──▶  Free OpenCode API (default :8083)  ──▶  opencode serve (default :4097)  ──▶  model providers
```

The gateway accepts OpenAI-shaped requests, translates them into OpenCode sessions and prompts, streams the results back as standard SSE chunks or a single JSON body, and hides the lifecycle of the backend process (startup, health checks, teardown). Each completion gets its own session, which is deleted as soon as the answer has been delivered, so the backend does not accumulate history.

---

## Performance

The HTTP layer is Fastify 5 with a deliberately thin lifecycle: three `onRequest` hooks (request id/logging,
CORS, auth) and no plugin-level middleware chain. Additional choices that matter under load:

- **Precompiled response schemas** — `/health` and `/v1/models` are serialized through `fast-json-stringify`
  schemas compiled at startup instead of the generic `JSON.stringify` path.
- **Short model-list cache** — `/v1/models` results are cached for 5 s, so client startup probes do not hit the
  backend every time (failures are never cached), and a burst that arrives with a cold cache shares a single
  provider round trip instead of one per request.
- **No hidden allocations on the hot path** — header masking for debug logs is only built when `LOG_LEVEL=debug`,
  the bearer token string is precomputed once, and request paths are parsed once per request.
- **SSE written straight to the socket** — streaming replies hijack the response and write `data:` frames directly
  to the raw connection: no buffering layer, no extra copies, `X-Accel-Buffering: no` for proxy friendliness.
- **Logging without a framework logger** — Fastify's built-in request logging is disabled; summaries are emitted
  from the raw response `finish` event, which also covers hijacked streams.
- **Pre-serialized SSE envelopes** — the `chat.completion.chunk` wrapper (id, model, created, choices) is built once
  per stream, so each delta only escapes its text and appends it to a prepared prefix.
- **No 4-second stall when the event stream is silent** — the gateway subscribes to OpenCode events and, as soon as
  the prompt call returns without a single delta, it shortens the first-delta wait to ~50 ms and falls back to
  polling (the answer is already available at that point).
- **Backend health probes are cached and keep-alive** — one probe is shared across a burst of requests
  (`OPENCODE_PROXY_HEALTH_CACHE_MS`, default 2000 ms) over a reused socket; a connection failure invalidates the
  cache immediately.
- **Startup failures fail fast** — if the OpenCode process exits during startup (missing binary, bad path) the
  readiness wait is aborted instead of burning the full budget, and requests answer in milliseconds for the retry
  cooldown window (`OPENCODE_PROXY_START_RETRY_MS`, default 15000 ms).
- **Queue drains immediately** — the completion queue starts the next request on the next tick instead of after a
  fixed 100 ms pause, and `OPENCODE_PROXY_MAX_CONCURRENCY` (default `1`, i.e. one completion at a time as before)
  can be raised to run independent sessions in parallel.

Local benchmarks, `autocannon`, same machine (Node.js 26, macOS, loopback), against the smoke-test stub
(`test/stub-opencode.mjs`). The stub answers in ~1 ms and streams its answer with deliberate 5 ms gaps, so these
numbers measure this gateway plus the stub — never a model:

| Scenario | Throughput | Avg latency |
| --- | --- | --- |
| `GET /health`, `-c 100 -d 10` | ~98,700 req/s | 0.3 ms |
| `GET /` (service index), `-c 100 -d 10` | ~104,800 req/s | 0.2 ms |
| `GET /v1/models` (5 s cache), `-c 100 -d 10` | ~63,700 req/s | 1.1 ms |
| `POST /v1/chat/completions` non-stream, `-c 10 -d 8` | ~2,100 req/s | 4.3 ms |
| `POST /v1/chat/completions` non-stream, `OPENCODE_PROXY_MAX_CONCURRENCY=4` | ~4,500 req/s | 1.7 ms |
| `POST /v1/chat/completions` stream, `-c 1 -d 6` | ~28 req/s | 35 ms |
| `POST /v1/chat/completions` stream, `-c 10 -d 8` | ~28 req/s | 350 ms (mostly queue wait) |
| `POST /v1/chat/completions` stream, `OPENCODE_PROXY_MAX_CONCURRENCY=4` | ~122 req/s | 81 ms |

Read the chat rows as "one completion pipeline", not as HTTP overhead: a completion is a session create, a prompt,
the answer and a session delete, and the queue admits one at a time by default, so throughput is `1 / ≈35 ms` while
the HTTP layer's own share is about 1 ms. The stub's 5 ms gaps make the streamed answer take ~20 ms on its own, which
is where most of the 35 ms goes. Raise `OPENCODE_PROXY_MAX_CONCURRENCY` only if your provider tolerates concurrent
sessions. Numbers move with machine load; re-measure before drawing conclusions.

For reference, the Express implementation this gateway replaced measured ~74,000 req/s on `/health` in the same
harness at the time; the Fastify rewrite answers ~99,000 req/s on the same endpoint.

---

## Requirements

| Requirement | Details |
| --- | --- |
| **Node.js** | 20.0 or newer (required by Fastify 5) |
| **pnpm** | 12.0 or newer (the project's package manager) |
| **OpenCode CLI** | Installed and authenticated once (`opencode auth login`) |

Install pnpm if you do not have it yet:

```bash
corepack enable pnpm
# or
npm install -g pnpm
```

Install the OpenCode CLI if you do not have it yet:

```bash
# Windows
npm install -g opencode-ai

# Linux / macOS
curl -fsSL https://opencode.ai/install | bash
```

> npm appears above only for third-party CLI installation; the project's own dependencies are managed with pnpm.

---

## Quick Start

```bash
git clone https://github.com/dinhdev666/free-opencode-api.git
cd free-opencode-api
pnpm install
cp config.json.example config.json   # optional: edit port, API key, paths
pnpm start                           # or: node index.js
```

Verify the gateway is up (`/health` is the only unauthenticated route besides `/`):

```bash
curl http://127.0.0.1:8083/health
curl -H "Authorization: Bearer sk-dummy-123" http://127.0.0.1:8083/v1/models
```

Send your first message:

```bash
curl -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-dummy-123" \
  -d '{"model":"opencode/kimi-k2.5-free","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

> `sk-dummy-123` is the built-in default key. Change `API_KEY` (environment variable or `config.json`) for any real deployment; leaving it blank still enforces the default.

---

## Configuration

Settings are resolved in this order: **environment variables → `config.json` → built-in defaults**.

A `config.json` that exists but cannot be used stops the gateway (`exit 1`) with the reason logged: falling back to
the defaults would ignore the port and the key you wrote and serve traffic with the built-in `sk-dummy-123`. A
missing file is normal and simply means "defaults plus environment".

`config.json` (see [config.json.example](config.json.example)):

| Key | Default | Description |
| --- | --- | --- |
| `PORT` | `8083` | Gateway listen port |
| `BIND_HOST` | `127.0.0.1` | Gateway bind address; use `0.0.0.0` to expose it on all interfaces |
| `API_KEY` | `sk-dummy-123` | Bearer token clients must send. Authentication is always on — an empty or blank value falls back to `sk-dummy-123` |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4097` | Address of the OpenCode backend managed by the gateway |
| `OPENCODE_BIND_HOST` | `127.0.0.1` | Listen address of the OpenCode backend |
| `OPENCODE_PATH` | `opencode` | Path to the `opencode` executable; auto-detected in common locations when left as a bare name |
| `DISABLE_TOOLS` | `false` | Disable OpenCode tool calls so models cannot run commands or modify files |
| `USE_ISOLATED_HOME` | `false` | Run the backend with a throwaway `HOME` instead of the real one, so it cannot pick up your machine's OpenCode state |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` (case-insensitive) |

Environment variables:

| Variable | Maps to |
| --- | --- |
| `PORT` | `PORT` |
| `BIND_HOST` | `BIND_HOST` |
| `API_KEY` | `API_KEY` |
| `OPENCODE_SERVER_URL` | `OPENCODE_SERVER_URL` |
| `OPENCODE_BIND_HOST` | `OPENCODE_BIND_HOST` |
| `OPENCODE_PATH` | `OPENCODE_PATH` |
| `DISABLE_TOOLS` | `DISABLE_TOOLS` (`OPENCODE_DISABLE_TOOLS` is still read as an alias, for setups that predate the rename) |
| `LOG_LEVEL` | `LOG_LEVEL` |
| `OPENCODE_USE_ISOLATED_HOME` | `USE_ISOLATED_HOME` (`USE_ISOLATED_HOME` is read as an alias) |

Advanced tuning (environment only):

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `300000` | Upstream request timeout in milliseconds |
| `OPENCODE_PROXY_HEALTH_CACHE_MS` | `2000` | How long a successful backend health probe is trusted before the next one (`0` probes on every request) |
| `OPENCODE_PROXY_START_RETRY_MS` | `15000` | Cooldown after a failed backend start attempt; requests fail fast instead of retrying immediately |
| `OPENCODE_PROXY_MAX_CONCURRENCY` | `1` | Number of chat completions processed in parallel (1..32). `1` keeps the historical serialized behaviour; raise it only if the backend/provider tolerates concurrent sessions |
| `OPENCODE_PROXY_MAX_QUEUE` | `64` | How many completions may wait for a free slot before the gateway answers `503 queue_full` instead of accepting more work (the queue holds request bodies, so it is bounded). Counts waiting requests only: `0` rejects a completion when no slot is free instead of queueing it |
| `OPENCODE_PROXY_DEBUG` | unset | `1`/`true` promotes logging to `debug` (legacy alias; prefer `LOG_LEVEL=debug`) |
| `OPENCODE_PROXY_BIND_HOST` | unset | Fallback bind address when `BIND_HOST` is not set |

> `LOG_LEVEL` is read directly from the environment by the Node process, so it always wins over the `LOG_LEVEL` field in `config.json`.

---

## API Reference

Base URL: `http://<host>:<port>/v1` (for example `http://127.0.0.1:8083/v1`). Every `/v1` request needs `Authorization: Bearer <API_KEY>`; the default key is `sk-dummy-123` and authentication cannot be turned off. Only `/health` and `/` are unauthenticated.

Every response carries an `X-Request-Id` header, and the same id appears in the gateway's request log line, so a client-side failure can be matched to a log entry.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/` | GET | Service index (no key required): service name, status and the endpoint paths |
| `/health` | GET | Liveness probe; returns gateway status and the configured backend URL |
| `/v1/models` | GET | OpenAI-style model list |
| `/v1/models/{id}` | GET | Single model; an id the provider list does not contain is still described (the gateway does not restrict models). The slash in `opencode/<model>` may be sent raw or as `%2F` |
| `/v1/chat/completions` | POST | Chat completions; supports `stream: true` for SSE (comment-line keep-alives are sent while a stream is open but has not produced its first token, so proxies do not drop the connection). If the backend fails after frames were sent, the error arrives as a `data: {"error":…}` frame and the stream is closed with `data: [DONE]` — a stream always terminates |

**Chat completions** accepts the usual OpenAI fields; model IDs use the `opencode/<model>` form (for example `opencode/kimi-k2.5-free`).

Fields the gateway respects: `messages` (string content, or an array of parts whose `text` is concatenated), `model`,
`stream` (a boolean, or one of `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off` — hand-written clients stringify it, and a
misread `stream` used to answer JSON to a client that was parsing SSE) and `user`/`name` as prompt labels. Sampling
knobs (`temperature`, `top_p`, `max_tokens`, `stop`, `seed`, `presence_penalty`, `frequency_penalty`,
`response_format`, tools) are accepted and **ignored**: the model is served by OpenCode, which owns its own sampling
settings, so a request that relies on them gets the model's defaults. `n` is ignored too — a completion always
returns exactly one choice.

```bash
curl -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-dummy-123" \
  -d '{
        "model": "opencode/kimi-k2.5-free",
        "messages": [{"role": "user", "content": "Explain event loops in two sentences."}],
        "stream": false
      }'
```

Errors follow the OpenAI error envelope (`{"error": {"message": ..., "type": ...}}`): `400` for an invalid request
(`type: "invalid_request_error"`, with Fastify's own `code` such as `FST_ERR_CTP_INVALID_JSON_BODY` when the body could
not be parsed), `401` for a missing or wrong key (`type: "invalid_request_error"`, `code: "invalid_api_key"`), `404` for
an unknown route (`type: "not_found"`), `502` for an upstream/provider failure, `503` when the completion queue is full
(`type: "queue_full"`), `504` on timeout. Everything the gateway or the backend failed at carries
`type: "server_error"` and the upstream message (`code` keeps the upstream error name for a `502`); an internal
exception's class name is never exposed.

---

## Client Examples

**Python (official OpenAI SDK)**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8083/v1", api_key="sk-dummy-123")
response = client.chat.completions.create(
    model="opencode/kimi-k2.5-free",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

**Node.js (official OpenAI SDK)**

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8083/v1', apiKey: 'sk-dummy-123' });
const res = await client.chat.completions.create({
    model: 'opencode/kimi-k2.5-free',
    messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(res.choices[0].message.content);
```

Any other OpenAI-compatible tool works the same way: point its base URL at `http://127.0.0.1:8083/v1` and set its API key to your `API_KEY` value (`sk-dummy-123` unless you changed it) — the key is never optional.

---

## Logging

All output goes to stdout/stderr with a `[gateway]` prefix:

```text
[gateway] <ISO timestamp> [LEVEL] message {"detail":"json"}
```

| Level | Content |
| --- | --- |
| `error` | Upstream failures (with status code and error-body summary) and fatal startup problems. Always emitted, stderr. |
| `warn` | Invalid configuration fallbacks and self-recoverable anomalies. stderr. |
| `info` | Default. Startup information plus a one-line summary per request: method, path, model, streaming, status, latency, request id. stdout. |
| `debug` | Inbound request headers (secrets masked), the final payload sent to the backend, and full responses. stdout. |

Sensitive headers such as `authorization`, `x-api-key`, and `cookie` are masked before they are logged.

The startup summary prints the effective port, backend URL, tool filtering, log level and capacity
(`Concurrency: … completion(s) processed in parallel`, `Wait queue: … waiting completion(s) before 503 queue_full`). A
`OPENCODE_PROXY_MAX_CONCURRENCY` / `OPENCODE_PROXY_MAX_QUEUE` value that is not a number, or is outside its range, is
reported as a `warn` line next to it instead of being applied silently — a throughput knob that quietly falls back to
the default is indistinguishable from one that has no effect.

---

## Docker

A container image with the OpenCode CLI preinstalled is published for `linux/amd64` and `linux/arm64`; see
[docker/README.md](docker/README.md) for image tags, environment variables, and port exposure.

```bash
docker pull dinhdev666/free-opencode-api:1.0.0
docker run -d --restart=always -p 8083:8083 -e API_KEY=sk-your-key dinhdev666/free-opencode-api:1.0.0
```

Docker Hub selects the matching architecture automatically. A new image is published by
`.github/workflows/docker-publish.yml` whenever a `v*.*.*` tag is pushed — see [CI and Releases](#ci-and-releases).

---

## CI and Releases

Two GitHub Actions workflows live in `.github/workflows/`; the CI checks need no secrets at all:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | every push to `main`, every pull request, manual dispatch | Runs `pnpm run check`, `sh -n docker/docker-entrypoint.sh` and `pnpm test` (the smoke suite in `test/`, which needs no OpenCode CLI or network) on Node 20, 22 and 24; a fourth job builds the Docker image, starts the container and waits for `/health` to answer. |
| `docker-publish.yml` | pushing a `v*.*.*` tag, or a manual dispatch from a tag | Fails if the tag does not match `version` in `package.json`, then builds `linux/amd64` + `linux/arm64` and pushes `<version>` and `latest` to Docker Hub. Needs the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets. |

The four required status checks on `main` are `Test on Node 20`, `Test on Node 22`, `Test on Node 24` and
`Build the container image`, so renaming those jobs also changes the branch protection rules.

Publishing a release is therefore just a tag:

```bash
git tag v1.0.1        # must match "version" in package.json
git push origin v1.0.1
```

---

## Project Structure

```text
.
├── index.js                  # Entry point: merges config and starts the gateway
├── src/
│   ├── proxy.js              # Fastify app, OpenAI routes, OpenCode backend management
│   └── logger.js             # Zero-dependency leveled logger with secret masking
├── config.json.example       # Sample configuration
├── package.json              # Scripts, dependencies, packageManager pin (pnpm)
├── pnpm-lock.yaml            # Locked dependency tree (pnpm)
├── docker/                   # Dockerfile, entrypoint, container documentation
├── test/
│   ├── stub-opencode.mjs     # Minimal opencode serve stand-in used by the smoke suite
│   └── smoke.mjs             # Contract checks: boot stub + gateway, assert OpenAI behaviour
├── .github/workflows/
│   ├── ci.yml                # CI: syntax check, smoke suite (Node 20/22/24), Docker build
│   └── docker-publish.yml    # Release: multi-arch image to Docker Hub on a v*.*.* tag
├── AGENTS.md                 # Invariants, architecture map and verification rules for coding agents
├── CONTRIBUTING.md           # Setup, coding conventions, commit message standard, PR checklist
└── LICENSE
```

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `Cannot verify OpenCode installation` | The `opencode` binary is not on `PATH`; install the CLI or set `OPENCODE_PATH` to its absolute path. |
| `401 Unauthorized` | The request has a missing or mismatched `Authorization: Bearer …` header; send the configured `API_KEY` (default `sk-dummy-123`). |
| Requests time out | The backend is slow or unavailable; check `/health`, verify `opencode auth login` was completed, and consider raising `OPENCODE_PROXY_REQUEST_TIMEOUT_MS`. |
| Empty streaming responses | Update the OpenCode CLI; the gateway already handles the SSE event changes in opencode ≥ 1.19. |
| Port already in use | Change `PORT` in `config.json` or the environment. |
| The gateway exits immediately, `config.json is not valid JSON …` | Fix the syntax or delete `config.json`; the process refuses to start rather than ignore a key you configured. |

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, coding conventions, the
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) message standard used in this repository and
the pull request checklist. [AGENTS.md](AGENTS.md) documents the invariants (mandatory authentication, OpenAI wire
format) and the verification steps expected before a change is merged.

---

## License

Released under the [MIT License](LICENSE).  
Copyright (c) 2026 Phạm Văn Định.

---

## Related Links

- Repository: [dinhdev666/free-opencode-api](https://github.com/dinhdev666/free-opencode-api)
- OpenCode: [opencode.ai](https://opencode.ai)
