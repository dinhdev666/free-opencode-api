# Free OpenCode API

[![CI](https://github.com/dinhdev666/free-opencode-api/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhdev666/free-opencode-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20compatible-412991.svg)](#api-reference)

**Free OpenCode API** turns the [OpenCode](https://opencode.ai) CLI into a standard, OpenAI-compatible REST API. It runs as a small Node.js gateway in front of `opencode serve`, so any client that understands the OpenAI protocol — Cursor, Claude Code, the official OpenAI SDKs, or your own scripts — can use the free models your OpenCode installation currently serves, without a paid API key.

> OpenCode rotates its free lineup, so this README only names `opencode/big-pickle`, the one id that stays put. It is an
> **alias**, not a model of its own: OpenCode routes it to whichever model it currently serves and never says which one,
> so its capabilities (context size, tool support, reasoning) can change without notice. It is the gateway's built-in
> default, so a chat request that omits `model` goes to it. Every other id comes and goes — `GET /v1/models` returns
> what your installation serves right now.

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
- **Mandatory authentication** — every request needs `Authorization: Bearer <key>` (the scheme is case-insensitive, and `X-Api-Key: <key>` works as an alias). The default key is `sk-dummy-123`, and authentication cannot be disabled: a blank `API_KEY` simply falls back to that default.
- **Tool guard** — `DISABLE_TOOLS=true` switches off every OpenCode tool that can execute something or write a file
  (`edit`, `shell`, `write`, `task`, `webfetch`…). On the 2.x server that is a **permission ruleset** handed to
  `session.create()`, so a denied tool is refused by the backend itself instead of being a request the model is asked
  to obey. The two read-only tools `read` and `glob` stay enabled on purpose: denying either of them hangs prompt
  requests with the free zen models, and they can only read.
- **The backend never sees the gateway key** — the `opencode serve` child is spawned without `API_KEY` in its
  environment (it authenticates nothing with it), and its throwaway working directory is created with mode `0700`, so
  neither the credential nor the backend's sandbox is exposed to other local users. That is hygiene, not a boundary:
  the child runs as the same user, so a model-directed tool can still read a custom `API_KEY` from `config.json` or
  this process's environment. When that combination is in force (a key that is not the built-in default, with tools
  enabled) startup logs a `[Security]` warning naming the file to protect and `DISABLE_TOOLS=true` as the fix — it never
  prints the key. With tools enabled, the built-in default key gets its own warning too: it is public, so a model-directed
  tool behind it is reachable from any page.
- **Structured logging** — `error` / `warn` / `info` / `debug` levels, one-line request summaries, secrets masked.
- **Production friendly** — configurable bind host, request timeouts (a body that never arrives is cut off, not held open),
  graceful shutdown, Docker image available.
- **Fast HTTP stack** — built on Fastify 5 with precompiled response schemas and no per-request middleware chain.

---

## How It Works

```text
OpenAI client  ──HTTP──▶  Free OpenCode API (default :8083)  ──▶  opencode serve (default :4097)  ──▶  model providers
```

The gateway accepts OpenAI-shaped requests, translates them into OpenCode sessions and prompts, streams the results back as standard SSE chunks or a single JSON body, and hides the lifecycle of the backend process (startup, health checks, teardown). Each completion gets its own session, which is deleted as soon as the answer has been delivered, so the backend does not accumulate history (a completion that `SIGINT`/`SIGTERM` interrupts is deleted by the shutdown sequence before the gateway exits, which matters when the backend is an external one it does not own).

### The OpenCode 2.x backend

The gateway is a client of the 2.x server's own HTTP API, so it is worth knowing what that API looks like when a
completion succeeds — and when one fails:

- **Every route lives under `/api/...`**: `POST /api/session`, `POST /api/session/{id}/prompt`,
  `GET /api/session/{id}/message`, `DELETE /api/session/{id}`, `GET /api/model`, `GET /api/provider`,
  `GET /api/event` (SSE) and `GET /api/info`. A 1.x server has no `/api` route at all, which is what a 404 there means.
- **Responses are enveloped**: a single resource is `{"data": …}` (sometimes `{"location": …, "data": …}`), a
  collection is `{"data": […]}`. The gateway reads the envelope, which is how it tells a payload it cannot read from an
  error body instead of reporting an empty answer.
- **Authentication is HTTP Basic**, username `opencode`, with the server's own password. When `OPENCODE_SERVER_PASSWORD`
  is blank (the default) the gateway generates a random password for its own process and hands it to the child it
  spawns through the same-named environment variable — the variable the server itself reads, which also suppresses its
  printed `server password …` line, so no secret is ever scraped out of the backend's output. Set it only to drive an
  *external* 2.x server, and set the same value there; the value is registered as sensitive and masked wherever it is
  printed (including the container's first-boot config dump), and it is never logged.
- **The readiness probe asks `GET /api/info` and requires a JSON body** (the first non-whitespace character must be `{`
  or `[`). 2.x serves the HTML web UI from `GET /` and `/health` with `200`, so the earlier "any 200 is healthy" rule
  accepted a backend that then answered every API call with `401` or `404`: the probe passed, the child was considered
  up, and every completion failed.
- **A prompt answers with the user inbox item, not the answer.** `POST /api/session/{id}/prompt` returns the message it
  just enqueued; the assistant's answer is written afterwards and read from the SSE event stream, or by polling
  `GET /api/session/{id}/message?type=assistant&order=desc&limit=1`. The message list is **newest first** unless
  `order=asc` is asked for (`cursor` cannot be combined with `order`), and an assistant message is flat —
  `{id, type:'assistant', content:[{type:'text'|'reasoning'|'tool', text}], finish, rawFinish, time, cost, tokens, error}`
  — where 1.x nested those fields under `info` and kept the fragments in `parts`.
- **A delete answers `204` with an empty body**, and a second delete answers
  `404 {"_tag":"SessionNotFoundError"}`. The gateway treats 404/410 as "already gone", which is what its session
  cleanup and its shutdown drain both rely on.
- **Failures are thrown, not resolved.** The 2.x client throws a typed error carrying a `_tag`
  (`SessionNotFoundError`, `UnauthorizedError`, `InvalidRequestError`, `ConflictError`, …) but **no HTTP status**, so
  the gateway maps the tag back onto the status the server sent before it reports one; a refused connection surfaces as
  `ClientError("Transport: fetch failed")` wrapping Node's `fetch` error, with the `ECONNREFUSED` code two `cause`
  levels down.
- **The event stream names its events with dots**: `session.text.delta` / `session.reasoning.delta` (each carries a real
  `delta` increment), `session.text.ended` / `session.reasoning.ended` (each carries the part's full cumulative `text`),
  `session.step.ended` (`finish`, `rawFinish`), `session.execution.failed` / `session.step.failed` (each carries
  `error`), `session.idle` and `session.execution.succeeded`. The envelope is `{id, type, data}` and every payload names
  its `sessionID`, so an event belonging to another session cannot move a completion.
- **There is no tool-list route and no `tools`/`parts`/`system` field on the prompt.** `DISABLE_TOOLS` is a session
  `permissions` ruleset passed at session creation (see [Configuration](#configuration)), and the tool-ids cache the
  1.x gateway kept for its per-tool override map is gone with the route it read.

---

## Performance

The HTTP layer is Fastify 5 with a deliberately thin lifecycle: a single `onRequest` hook (trace id and log
summary, CORS headers, bearer auth) and no plugin-level middleware chain. Additional choices that matter under load:

- **Precompiled response schemas** — `/health` and `/v1/models` are serialized through `fast-json-stringify`
  schemas compiled at startup instead of the generic `JSON.stringify` path, and a cached model listing is a body built
  once when the cache was filled: re-running the serializer for bytes that cannot have changed measured +2.7 % on the
  route (100.1k → 102.8k req/s).
- **Short model-list cache** — `/v1/models` results are cached for 5 s, so client startup probes do not hit the
  backend every time, and a burst that arrives with a cold cache shares a single provider round trip instead of one
  per request. An **expired** entry is still served (for up to 60 s) while the refresh runs in the background, so the
  request that crosses the 5 s boundary no longer waits for a provider round trip: a listing measured 5.0 ms with the
  blocking refresh and 0.6 ms from a warm cache. A failure is not cached either, but it is held for 1 s, so a provider
  that answers 500 is not asked once per listing (measured 72.4k → 101.2k req/s on the route, +40 %).
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
- **A silent backend gap does not truncate the answer** — when the event stream goes quiet for the idle timeout while
  a slow model is still writing, the gateway recovers through polling and appends only the part the client does not
  have. The recovery waits a full idle window of further silence before it accepts a message the backend never marks
  finished, so a provider that pauses mid-answer is not mistaken for one that is done. A stream cut while
  `DISABLE_TOOLS` is filtering is recovered from the unfiltered remainder, so an answer interrupted inside a
  `<function_calls>` block still arrives with everything that followed it.
- **Backend health probes are cached and keep-alive** — one probe is shared across a burst of requests
  (`OPENCODE_PROXY_HEALTH_CACHE_MS`, default 2000 ms) over a reused socket; a connection failure invalidates the
  cache immediately. A backend that was already known to be healthy but whose cache window has expired is re-probed
  **in the background**, so the request that arrives after a quiet period does not pay for the health round trip
  before its own work starts (a backend that died in the meantime is still recovered by the request that hits it).
- **Polling starts fast, then settles** — the first polls of a completion run at 25/50/100/200 ms and then at the
  normal interval, because an answer that lands a few tens of milliseconds after the prompt returned used to wait a
  full 500 ms interval before it was seen. The "the text stopped growing" guard is measured in time (~1.5 s), not in
  poll count, so the shorter early polls cannot make it accept a half-written answer. It watches the reasoning as well
  as the text, so a provider that streams reasoning only — and never marks its message finished — is served as soon as
  it goes quiet instead of answering `504` on the request budget, and only string parts count as answer text (a part
  carrying a number is not stringified into the reply).
- **One budget per completion** — session creation, the prompt, the event stream and the polling fallback share the
  request budget (`OPENCODE_PROXY_REQUEST_TIMEOUT_MS`) instead of each starting a fresh one, so a stalled stream ends
  within the advertised timeout instead of after roughly twice it, and a request that waited in the queue does not get
  a full extra budget for its setup.
- **Startup failures fail fast** — if the OpenCode process exits during startup (missing binary, bad path) the
  readiness wait is aborted instead of burning the full budget, and requests answer in milliseconds for the retry
  cooldown window (`OPENCODE_PROXY_START_RETRY_MS`, default 15000 ms).
- **Queue drains immediately** — the completion queue starts the next request on the next tick instead of after a
  fixed 100 ms pause, and `OPENCODE_PROXY_MAX_CONCURRENCY` (default `1`, i.e. one completion at a time as before)
  can be raised to run independent sessions in parallel.
- **A client that gives up frees its slot** — when the client closes the connection, a streaming request aborts its
  event subscription and a non-streaming one stops polling at the next tick, so the queue moves on instead of
  holding a slot for an answer nobody will read. A client that stops *reading* without closing is dropped after 30 s
  instead of parking the slot forever, and no single backend call is left without a deadline.
- **The answer is read where 2.x writes it** — `POST /api/session/{id}/prompt` answers with the *user inbox item* it
  just enqueued, so the assistant's answer is read from the SSE event stream (streaming mode) or by polling
  `GET /api/session/{id}/message?type=assistant&order=desc&limit=1` (non-streaming mode: the newest assistant message is
  the one just produced, where `order=asc` with no `type` returned the oldest step of the page — a stale one in any
  session longer than the page, and the user's own message when the page held one) rather than out of the prompt
  response. A finished
  message in the prompt response is still served directly when one arrives — the 1.x shape is recognised on purpose, so
  a proxy translating the two APIs keeps the round trip it saves — but a 2.x server never spends a call on an answer it
  already holds, and a message that is still being written keeps the poll loop, so a partial answer is never served.

Local benchmarks, `autocannon`, same machine (Node.js 26, macOS 27 on an Apple M4, loopback), against the
smoke-test stub (`test/stub-opencode.mjs`). The stub answers in ~1 ms and streams its answer with deliberate 5 ms
gaps, so these numbers measure this gateway plus the stub — never a model. The request log is **off**
(`LOG_LEVEL=error`): at the default `info` every `/v1/*` request writes a line, and on a redirected stdout (a file, as
in a container) those writes are synchronous, so the log — not the handler — sets the ceiling. Measured on the same
machine, `GET /v1/models` answers ~104,900 req/s at 0.08 ms with the log off and ~71,600 req/s at 1.02 ms with the
default line; `/health` and `/` log at `debug` and are unaffected. Keep the log on in production and read the table as
what the request path costs, not as a promise with stdout in the way:

| Scenario | Throughput | Avg latency |
| --- | --- | --- |
| `GET /health`, `-c 100 -d 10` | ~109,600 req/s | 0.04 ms |
| `GET /` (service index), `-c 100 -d 10` | ~115,400 req/s | 0.03 ms |
| `GET /v1/models` (5 s cache), `-c 100 -d 10` | ~103,200 req/s | 0.09 ms |
| `POST /v1/chat/completions` non-stream, `-c 10 -d 8` | ~3,400 req/s | 2.4 ms |
| `POST /v1/chat/completions` non-stream, `OPENCODE_PROXY_MAX_CONCURRENCY=4` | ~3,900 req/s | 2.0 ms |
| `POST /v1/chat/completions` stream, `-c 1 -d 6` | ~33 req/s | 29 ms |
| `POST /v1/chat/completions` stream, `-c 10 -d 8` | ~28 req/s | 344 ms (mostly queue wait) |
| `POST /v1/chat/completions` stream, `OPENCODE_PROXY_MAX_CONCURRENCY=4` | ~137 req/s | 72 ms |

Read the chat rows as "one completion pipeline", not as HTTP overhead: a completion is a session create, a prompt,
the answer and a session delete, and the queue admits one at a time by default, so throughput is `1 / ≈30 ms` while
the HTTP layer's own share is about 0.4 ms. The stub's 5 ms gaps make the streamed answer take ~20 ms on its own, which
is where most of the 29 ms goes. A queue slot is freed as soon as the answer is written, so the session deletion that
follows does not delay the next completion. Raise `OPENCODE_PROXY_MAX_CONCURRENCY` only if your provider tolerates concurrent
sessions. Numbers move with machine load; re-measure before drawing conclusions.

**No rate limiter, by design.** The gateway bounds *concurrency* (`OPENCODE_PROXY_MAX_CONCURRENCY`), the *wait queue*
(`OPENCODE_PROXY_MAX_QUEUE`: a full queue answers `503` with `Retry-After: 1`) and the *body*
(`OPENCODE_PROXY_MAX_BODY_MB`), and nothing else. A request rate per client is deliberately absent: the only identity
the gateway has is one shared API key, and it keeps no cross-process counter. If several callers share one instance, put
a reverse proxy in front of it (`nginx limit_req`, a load-balancer rate policy) - that is where a per-address limit
belongs, and it survives a restart.

For reference, the Express implementation this gateway replaced measured ~74,000 req/s on `/health` in the same
harness at the time; the Fastify rewrite answers ~110,000 req/s on the same endpoint today, as the table above says.

---

## Requirements

| Requirement | Details |
| --- | --- |
| **Node.js** | 20.0 or newer (required by Fastify 5; `index.js` refuses to start on an older major version and says so) |
| **pnpm** | 12.0 or newer (the project's package manager) |
| **OpenCode CLI** | A **2.x** release (the client the gateway uses, `@opencode/client`, drives the 2.x `opencode serve` API), installed and authenticated once (`opencode auth login`) |

Install pnpm if you do not have it yet:

```bash
corepack enable pnpm
# or
npm install -g pnpm
```

Install the OpenCode CLI if you do not have it yet — a **2.x** release, which is what the gateway drives:

```bash
# Every platform with npm: installs the newest published release (2.x today)
npm install -g @opencode/cli

# Linux / macOS alternative: the install script fetches the newest release, so check what you got
curl -fsSL https://opencode.ai/install | bash
opencode --version   # must report 2.x; if it reports 1.x, use the npm command above
```

`npm install -g @opencode/cli` installs whatever is newest — 2.3.2 today, and the version the Docker image pins
itself. If a later major ever changes the `serve` API, name the line this gateway is written against instead:
`npm install -g "@opencode/cli@2"`.

> npm appears above only for third-party CLI installation; the project's own dependencies are managed with pnpm.

2.x is a **different upstream** from the 1.x line, not a newer build of it: 1.x was the npm package `opencode-ai`
(repository `opencode-ai`), while 2.x is `@opencode/cli` (repository `github.com/anomalyco/opencode`, a native binary).
The executable is still `opencode`, so `OPENCODE_PATH` and the `PATH` lookup are unchanged.

A 1.x binary is a different server: its `opencode serve` predates the `/api/*` routes this gateway drives (there is no
`/api` route on it at all), so a 1.x binary on `PATH` makes every completion fail with
`502 … rejected session creation` while the readiness probe never passes. Install a 2.x release (for example
`npm install -g @opencode/cli`) or point `OPENCODE_PATH` at one; at startup the gateway reads `opencode --version`
and warns when the major version is below 2.

---

## Quick Start

```bash
git clone https://github.com/dinhdev666/free-opencode-api.git
cd free-opencode-api
pnpm install
cp config.json.example config.json   # optional: edit port, API key, paths
pnpm start                           # or: node index.js
```

Verify the gateway is up (`OPTIONS`, `/health` and `/` are the only unauthenticated routes), and list the models it can
serve right now:

```bash
curl http://127.0.0.1:8083/health
curl -H "Authorization: Bearer sk-dummy-123" http://127.0.0.1:8083/v1/models
```

Send your first message — `opencode/big-pickle` is a stable alias for whatever model OpenCode is serving right now; any
other id from that list works too:

```bash
curl -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-dummy-123" \
  -d '{"model":"opencode/big-pickle","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

> `sk-dummy-123` is the built-in default key. Change `API_KEY` (environment variable or `config.json`) for any real deployment; leaving it blank still enforces the default.

---

## Configuration

Settings are resolved in this order: **environment variables → `config.json` → built-in defaults**. An environment
variable that is present but **blank** counts as unset, so `PORT= API_KEY= npm start` (a unit file's
`Environment=API_KEY=`, an empty Helm or compose value) cannot replace the port and the key written in `config.json`
with the defaults — a blank `API_KEY` used to fall through to the public `sk-dummy-123` while the file named a secret.

A `config.json` that exists but cannot be used stops the gateway (`exit 1`) with the reason logged: falling back to
the defaults would ignore the port and the key you wrote and serve traffic with the built-in `sk-dummy-123`. A
missing file is normal and simply means "defaults plus environment". The file is read from the **application
directory** — next to `index.js` (in the container, `/app/config.json`) — not from the directory you start the process
in; if a `config.json` sits in that working directory instead, startup says so:
`[Config] config.json is read from …; the file at … is ignored`.

The file must be a regular file of at most 1 MiB; a UTF-8 BOM (which a Windows editor writes) is tolerated. A key the
gateway knows but whose value has the wrong type stops it with the key named and the type it found
(`[Config] config.json API_KEY must be a string, found a boolean`) instead of being coerced: a boolean `API_KEY` would
make the literal string `true` the gateway's credential, which every client can guess while the startup summary still
reports a custom key. The message names the type each key actually takes — a string (`API_KEY`, `BIND_HOST`,
`OPENCODE_BIND_HOST`, `OPENCODE_SERVER_URL`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_PATH`, `LOG_LEVEL`) or a number
(`PORT` and the `OPENCODE_PROXY_*` tuning keys, which are also accepted as a numeric string).

A key the gateway does **not** read is reported and ignored, because a misspelled key used to change nothing at all
while the gateway ran the default you thought you had replaced:

```
[Config] config.json has an unknown key 'APIKEY' (did you mean 'API_KEY'?) - it is ignored
```

`config.json` (see [config.json.example](config.json.example)):

| Key | Default | Description |
| --- | --- | --- |
| `PORT` | `8083` | Gateway listen port |
| `BIND_HOST` | `127.0.0.1` | Gateway bind address; use `0.0.0.0` to expose it on all interfaces |
| `API_KEY` | `sk-dummy-123` | Bearer token clients must send. Authentication is always on — an empty or blank value falls back to `sk-dummy-123` |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4097` | Address of the OpenCode backend managed by the gateway; a trailing slash is stripped and a missing scheme is read as `http://` (both are reported in the startup log, *before* the summary, so the `Backend:` line always shows the value the gateway actually uses). Surrounding whitespace is trimmed silently. A credential in the URL (`http://user:secret@host:4097`, a proxy in front of the backend) is sent to the backend as a Basic `Authorization` header — the SDK calls every endpoint through `fetch`, which refuses a URL that carries credentials, so such a URL could not work at all — and it is masked wherever the value is logged or returned (`/health`), including inside an upstream error message |
| `OPENCODE_SERVER_PASSWORD` | *(blank — generate one per process)* | The password the OpenCode 2.x server requires on every `/api/*` route (HTTP Basic, username `opencode`). Left blank, the gateway generates a random password for its own process and passes it to the backend it spawns through the same-named environment variable — the variable the server itself reads, which also suppresses its printed `server password …` line — so a self-hosted backend needs no configuration and no secret is ever scraped out of the backend's output. Set it only to drive an **external** 2.x server, and set the same value there; it is registered as a sensitive value and masked wherever it is printed (including the container's first-boot config dump), and it is never logged |
| `OPENCODE_BIND_HOST` | `127.0.0.1` | Listen address of the OpenCode backend. Keep it on loopback: the 2.x server authenticates its `/api/*` routes with `OPENCODE_SERVER_PASSWORD`, but publishing the port still exposes the backend (and its web UI) outside the gateway, so it bypasses the gateway's key |
| `OPENCODE_PATH` | `opencode` | Path to the `opencode` executable; auto-detected in common locations when left as a bare name. A path that names a file is resolved against the gateway's working directory before it is used, so `OPENCODE_PATH=./bin/opencode` runs the file you configured rather than whatever of that name `PATH` holds |
| `DISABLE_TOOLS` | `false` | Disable OpenCode tool calls so models cannot run commands or modify files. On the 2.x server it is a session **permission ruleset** passed at session creation: every action the default agent can use is denied (`edit`, `shell`, `write`, `grep`, `webfetch`, `websearch`, `subagent`, `external_directory`, `question`, `skill`, `task`, `todowrite`, `todoread`, `lsp`, `browser`, `patch`, `multiedit`, `invalid`), then `*` catches an action a newer server grows, and the two read-only tools `read` and `glob` are re-allowed last as the single exception — denying either of them hangs prompt requests with the free zen models. With a custom `API_KEY` and tools enabled, a model-directed tool can read that key from the same host, so startup warns (`[Security]`) and names this switch; `true` is the recommended setting whenever the gateway is exposed. Booleans accept `true`/`false` (JSON) or `1`/`0`, `yes`/`no`, `y`/`n`, `on`/`off` (environment or string); a value none of those match is reported in a `[Config]` warning together with the value actually used (`DISABLE_TOOLS='maybe' is not a boolean …, using false`), for `DISABLE_TOOLS`, `USE_ISOLATED_HOME` and `DEBUG` alike |
| `USE_ISOLATED_HOME` | `false` | Run the backend with a throwaway `HOME` instead of the real one, so it cannot pick up your machine's OpenCode state. `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `TMPDIR`, `TMP` and `TEMP` point inside the same throwaway directory, because the CLI resolves them before `HOME` and an inherited value would otherwise send it back to your real store, config and cache. **Not honoured on Windows**: `spawnBackend()` gives the child the real user profile there, because the 2.x CLI resolves its storage paths against it and a synthetic home breaks them (`[Proxy] Running on Windows, using standard user home directory` in the log, and the startup summary prints `Yes (ignored on Windows)`). The child still gets its own empty working directory and `OPENCODE_PROJECT_DIR` |
| `DEBUG` | `false` | Switch logging to `debug` **when no explicit `LOG_LEVEL` is set** (an explicit level wins and the switch is ignored with a `[Config]` warning; the environment name for the same switch is `OPENCODE_PROXY_DEBUG`, and `LOG_LEVEL=debug` is the preferred way) |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` (case-insensitive) |

Environment variables:

| Variable | Maps to |
| --- | --- |
| `PORT` | `PORT` |
| `BIND_HOST` | `BIND_HOST` |
| `API_KEY` | `API_KEY` |
| `OPENCODE_SERVER_URL` | `OPENCODE_SERVER_URL` |
| `OPENCODE_SERVER_PASSWORD` | `OPENCODE_SERVER_PASSWORD` |
| `OPENCODE_BIND_HOST` | `OPENCODE_BIND_HOST` |
| `OPENCODE_PATH` | `OPENCODE_PATH` |
| `DISABLE_TOOLS` | `DISABLE_TOOLS` (`OPENCODE_DISABLE_TOOLS` is still read as an alias, for setups that predate the rename) |
| `LOG_LEVEL` | `LOG_LEVEL` |
| `OPENCODE_USE_ISOLATED_HOME` | `USE_ISOLATED_HOME` (`USE_ISOLATED_HOME` is read as an alias) |

Advanced tuning (environment or `config.json`; the environment wins when both set the same key):

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `300000` | Upstream request timeout in milliseconds, shared by every phase of a completion (session creation, prompt, event stream, poll fallback). It also bounds how long a request body may take to arrive, up to 30 s (see [Request bodies](#request-bodies)). Values above `2147483647` are clamped to it and reported: that is the largest delay `setTimeout` can hold, so a larger one fired immediately and turned every completion into an instant `504` |
| `OPENCODE_PROXY_HEALTH_CACHE_MS` | `2000` | How long a successful backend health probe is trusted before the next one (`0` probes on every request). An expired-but-known-healthy backend is re-probed in the background, so a request after a quiet period does not wait for it |
| `OPENCODE_PROXY_START_RETRY_MS` | `15000` | Cooldown after a failed backend start attempt; requests fail fast instead of retrying immediately |
| `OPENCODE_PROXY_MAX_CONCURRENCY` | `1` | Number of chat completions processed in parallel (1..32). `1` keeps the historical serialized behaviour; raise it only if the backend/provider tolerates concurrent sessions |
| `OPENCODE_PROXY_MAX_QUEUE` | `64` | How many completions may wait for a free slot before the gateway answers `503 queue_full` instead of accepting more work (the queue holds request bodies, so it is bounded). Counts waiting requests only: `0` rejects a completion when no slot is free instead of queueing it. A slot frees as soon as its response is written (the session cleanup that follows does not hold it) |
| `OPENCODE_PROXY_MAX_BODY_MB` | `50` | Largest accepted request body in MiB (1..200). It is the other half of the memory bound: a waiting completion pins its parsed body, so the worst case is this value times `OPENCODE_PROXY_MAX_QUEUE`. Prompts are small, so lowering it is the cheap way to bound a gateway whose clients are not trusted. A larger body is refused with `413` naming this limit, after the upload is drained (bounded to 5 s) so the client reads that error instead of a reset connection. Bytes are only half the bound: a 20 MiB body of empty message objects parsed into about 12x its size in heap, so `messages` over 10 000 entries and a `content` array over 10 000 parts are refused with a `400` naming the limit and what arrived (both far above any real conversation) |
| `OPENCODE_PROXY_DEBUG` | unset | `1`/`true` promotes logging to `debug` **when no explicit `LOG_LEVEL` is set** — an explicit level wins and the switch is then ignored with a `[Config]` warning. This is the **environment name** of the switch (the `config.json` key is `DEBUG`, and the environment variable `DEBUG` has no effect); `LOG_LEVEL=debug` is the preferred way |
| `OPENCODE_PROXY_BIND_HOST` | unset | Fallback bind address when `BIND_HOST` is not set — **environment only**: `config.json` has just `BIND_HOST`, and this name in the file is reported as an unknown key and ignored |

A tuning value that cannot be used (a typo, a negative number) is **reported at startup** —
`[Config] OPENCODE_PROXY_REQUEST_TIMEOUT_MS='abc' is not a positive number, using 300000` — instead of being replaced
by the default in silence, so the log always says which value is actually in force.

> `LOG_LEVEL` is read directly from the environment by the Node process, so it always wins over the `LOG_LEVEL` field in `config.json`.

---

## API Reference

Base URL: `http://<host>:<port>/v1` (for example `http://127.0.0.1:8083/v1`). Every `/v1` request needs `Authorization: Bearer <API_KEY>` — the scheme is case-insensitive (`bearer`, `Bearer   <key>` both work) and `X-Api-Key: <API_KEY>` is accepted as an alias for clients configured with an api-key header; when both are present the `Authorization` header decides. The default key is `sk-dummy-123` and authentication cannot be turned off. Only `OPTIONS` (a preflight cannot carry credentials), `/health` and `/` are unauthenticated.

Every response carries an `X-Request-Id` header, and the same id appears in the gateway's request log line, so a client-side failure can be matched to a log entry.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/` | GET | Service index (no key required): service name, status and the endpoint paths |
| `/health` | GET | Liveness probe; returns gateway status and the configured backend URL, with any credentials in it masked (`http://***@host:4097`). The endpoint needs no key, so it must not be a way to read one |
| `/v1/models` | GET | OpenAI-style model list |
| `/v1/models/{id}` | GET | Single model; an id the provider list does not contain is still described (the gateway does not restrict models). The slash in `opencode/<model>` may be sent raw or as `%2F`. A blank id (`/v1/models//`) is a `404` |
| `/v1/chat/completions` | POST | Chat completions; supports `stream: true` for SSE. Every frame is a `chat.completion.chunk` with the same `id`/`object`/`created`/`model` envelope, the first one carrying `delta.role: "assistant"` like OpenAI's, the last one carrying `finish_reason: "stop"` before `data: [DONE]`. Comment-line keep-alives are sent whenever a stream has been silent for 15 s — before the first token and between deltas — so a proxy does not drop a connection while the model is still thinking. If the backend fails after frames were sent, the error arrives as a `data: {"error":…}` frame and the stream is closed with `data: [DONE]` — a stream always terminates |

A provider call that stops answering is bounded by its own deadline (10 s at most, and never longer than the request
budget), so `/v1/models` still answers — with the single static fallback model — instead of hanging. The same fallback
covers a backend that reports no models at all: an empty list would leave a client with nothing to choose from.
A fallback answer is held for **1 s**: the failing provider is not asked again for every listing that arrives in that
window (it used to cost one backend round trip per request, which is most of the route's throughput), and a backend
that recovers is still picked up within the second — not pinned by the 5 s cache a real listing gets.

**Chat completions** accepts the usual OpenAI fields; model IDs use the `opencode/<model>` form. `opencode/big-pickle`
is a stable alias that OpenCode routes to the model it currently serves (the target is not published), and it is the
gateway's built-in default, used when `model` is omitted; every other id is one that `GET /v1/models` lists for your
installation right now.

Fields the gateway respects: `messages` (string content, or an array of parts whose `text` is concatenated — see
[Request bodies](#request-bodies) for the parts that are refused), `model`,
`stream` (a boolean, or one of `true`/`false`/`1`/`0`/`yes`/`no`/`y`/`n`/`on`/`off` — hand-written clients stringify it, and a
misread `stream` used to answer JSON to a client that was parsing SSE), `stream_options.include_usage` (adds the
OpenAI usage chunk — `choices: []` plus a zeroed `usage` block — as the last frame before `data: [DONE]`; the counts
are zero for the same reason the non-streaming `usage` is) and `messages[].name` as a prompt label. Sampling
knobs (`temperature`, `top_p`, `max_tokens`, `stop`, `seed`, `presence_penalty`, `frequency_penalty`,
`response_format`, tools) and the request-level `user` (OpenAI's abuse-tracking field, which is not forwarded into the
prompt) are accepted and **ignored**: the model is served by OpenCode, which owns its own sampling
settings, so a request that relies on them gets the model's defaults. `n` is ignored too — a completion always
returns exactly one choice.

A `stream` or `stream_options.include_usage` value that is **present but cannot be read** (`"stream": "ture"`,
`"stream": {}`, `"include_usage": "ture"`) is refused with a `400` naming the field and what arrived
(`stream must be a boolean (or one of true/false, yes/no, on/off, 1/0), found an object`). Such a value used to keep the
non-streaming default in silence, so a typo answered `200 application/json` to a client that was parsing SSE, or
dropped the usage chunk its SDK was waiting for. A missing, blank or `null` value still means "not streaming", and
every spelling listed above keeps working; `stream_options` itself must be an object when it is sent.

`stream_options` only means something on a stream. A body that sends `stream_options` with `stream` false (or absent)
is answered as **JSON**, and the option is ignored rather than refused: the usage chunk it asks for exists to carry
numbers a streaming client cannot get any other way, a non-streaming body already carries `usage`, and answering `400`
would refuse a request whose payload is otherwise valid. A client that sets the option on a shared body and sometimes
sends `stream: false` should read `usage` from the JSON it gets back.

The request body is JSON, but a JSON body sent under `application/x-www-form-urlencoded` (what `curl -d '{…}'` labels
it when you omit the header) or `text/plain` is parsed from the string it carries and served all the same. A leading
UTF-8 BOM is tolerated there as well — PowerShell 5.1 and most Windows editors write one, and it made a valid body
answer `request body is not valid JSON`. An unparsable body is a `400` whose message names the content type; an
unrelated type (`application/xml`) is a `415`, and so is a compressed body (`Content-Encoding: gzip`): the gateway does
not decompress, and answering "not valid JSON" would blame the one part of the request that was correct.

A body that parses but is **not a JSON object** (`"hi"`, `42`, `true`, `[]`) is a `400` naming what arrived
(`request body must be a JSON object, found an array`) on every path, JSON and text alike. A JSON string body used to
be read as unparsed text and answered "request body is not valid JSON" about a body that parses perfectly, while a
scalar or an array carried by a `text/plain` request was replaced by an empty object and blamed on `messages`.

A body that is **not there at all** is not invalid JSON either: an empty body (a retry that lost its payload) answers
`request body is empty; send a JSON object with a messages array` — under `Content-Type: application/json`, where the
parser refuses it first and the `FST_ERR_CTP_EMPTY_JSON_BODY` code is kept, and under the text types, where an empty
(whitespace-only included) string used to be reported as a syntax error about nothing — instead of telling the reader
about the content type it had set correctly.

```bash
curl -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-dummy-123" \
  -d '{
        "model": "opencode/big-pickle",
        "messages": [{"role": "user", "content": "Explain event loops in two sentences."}],
        "stream": false
      }'
```

Every response carries `X-Request-Id`: the gateway's own `gw-…` id, or the value of an `X-Request-Id` header you send
(a short token of `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-`, up to 64 characters — anything else is replaced). The same id
ends the request's log line, so a client report can be matched to a log entry, and it is exposed over CORS so browser
clients can read it. Every response also carries `X-Content-Type-Options: nosniff`: the gateway only writes JSON and
SSE, so a browser must not re-interpret a body its own guess disagrees with (on the CORS paths, on streamed responses
and on the parser-level rejections alike).

Errors follow the OpenAI error envelope (`{"error": {"message": ..., "type": ...}}`): `400` for an invalid request
(`type: "invalid_request_error"`, with Fastify's own `code` such as `FST_ERR_CTP_INVALID_JSON_BODY` when the body could
not be parsed), `401` for a missing or wrong key (`type: "invalid_request_error"`, `code: "invalid_api_key"`; the
message names which of the three causes it saw — no key at all, a wrong `Authorization` header, a wrong `X-Api-Key`
header — and never the value that was sent), `404` for
an unknown route (`type: "not_found"`; the message echoes the method and path and names the endpoints this gateway
serves with their methods, so a client pointed at `/v1/completions` is told the URL it needs and a client that used
`PUT` is told it wants `POST`), `408`/`431` for a request the HTTP parser rejected (a timeout, an oversized
header block; ordinary parse errors are `400`) — those also answer the envelope, with CORS headers and an
`X-Request-Id`, `413` for a body over `OPENCODE_PROXY_MAX_BODY_MB` (50 MiB by default; the message names the limit it
enforced, since sending less or raising the knob is the fix), `415` for a content type or content encoding the
gateway cannot read, `502` for an upstream/provider failure (streaming requests included: a
provider failure that arrives before the first token is an HTTP error, not an empty answer, and a backend that dies
mid-request is an upstream failure rather than a `500` — the next request starts it again, a backend that refuses
to create a session reports its status and reason in the message instead of a bare `500`, a backend the gateway cannot
start at all (a missing CLI, a 1.x release, a port already taken, a restart cooldown after a failed attempt, an
`OPENCODE_SERVER_URL` that names no port or that the URL parser rejects — the child can only listen on a numbered
port, so the gateway refuses the value before it spawns anything) is the
same upstream failure, and a backend that keeps failing while the answer is polled gives up after 5 consecutive
failures instead of waiting out the whole request budget), `503` in two cases — the completion queue is full
(`type: "queue_full"`) or the gateway is shutting down (`code: "gateway_shutting_down"`), both with a `Retry-After: 1`
header so SDKs retry instead of failing — and `504` on timeout — including a backend that accepts the connection and then
never answers the request (it is reported as a gateway timeout with the budget that was exceeded instead of leaving the
client without a response). Everything the gateway or the backend failed at carries
`type: "server_error"` and the upstream message (`502` carries a `code` too: `ProviderError` when the provider
reported the failure, `backend_unreachable` when the backend could not be reached or started, `upstream_error`
otherwise); an
internal exception's class name is never exposed. Once a stream has started, errors are delivered in-band
(`data: {"error": …}` then `data: [DONE]`) — never as assistant text.

### Request bodies

**Content parts must be text.** A `content` array may carry strings and parts that have a `text` field (`text`, and
the Responses-API spelling `input_text`). Any other part — `image_url`, `input_audio`, `file` — is refused with a `400`
that names its position and type, because the gateway forwards text to a CLI session and cannot carry an image:

```json
{"error":{"message":"messages[0].content[1] uses an unsupported content part type \"image_url\"; this gateway forwards text only","type":"invalid_request_error"}}
```

A part whose `text` field is missing is told which field is missing rather than which type is unsupported
(`messages[0].content[0].text is required for a text part`), and an object with neither a `type` nor a `text`
(`{}`, `{"type":5}`) is refused as one (`… must be a string or an object with a text field, found an object without a
text field`) — neither quotes a type the client did not send.

Dropping those parts instead (the previous behaviour) answered a question the backend never received, and a request
whose only part was an image was reported as missing text it had never been asked for.

A part whose `text` field is present but not a string is named by that field
(`messages[0].content[1].text must be a string, found a number`) instead of being called an unsupported type — `text` is
the part type the gateway does forward. A part that is not a part at all (`42`, `null`, `true`) is refused the same way
(`messages[0].content[0] must be a string or an object with a text field, found a number`), because dropping it left the
request failing the "no text at all" check and blaming the client's text.

A `content` that is a **single object instead of an array** follows the same three rules, reported without a part index
(`messages[0].content uses an unsupported content part type "image_url"; this gateway forwards text only`,
`messages[0].content.text must be a string, found a number`). Such a message used to be read as empty and dropped in
silence: a request that also carried text was answered from that text alone (a confidently wrong answer), and a
`system`/`developer` message written that way lost its instructions instead. A single object with a string `text` is a
shape some clients send and is still forwarded.

A `content` that is a **bare scalar** (`42`, `true`) is refused the same way
(`messages[0].content must be a string or an object with a text field, found a number`): it is not text the client
wrote, and stringifying it sent the model the number as the question — a template that lost a field asked something
nobody asked and was answered. OpenAI refuses the type as well.

**A message `name` is a label, not prompt text.** It is used as `USER(name): …` only when it is a string, with control
characters replaced, so a non-string name cannot reach the model as `[object Object]` and a name carrying a newline
cannot forge a second conversation line.

**A body must arrive.** A request that announces a body (`Content-Length`, `Transfer-Encoding: chunked`) has to
deliver it within 30 s or the shared request budget, whichever is shorter — and that window is about *silence*, not
about the size of the upload: it renews while the socket is making progress, so a slow client that is genuinely sending
is served, up to a total of that window plus one request budget. On expiry the client receives the `408`
envelope (`request body was not received within …ms; send the declared body or close the connection`, or, when the
upload was still progressing, the window and the upload budget it exceeded) and the
connection is closed; a request that was already refused (an unauthenticated one, for example) is simply
disconnected, because the client is not waiting for another answer.
Without that deadline a client could send `Content-Length: 4096`, write four bytes and hold the socket open for as long
as it liked — no credential required, since the `401` is written from the headers alone while the connection stays
alive to drain a body that will never arrive.

---

## Client Examples

**Python (official OpenAI SDK)**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8083/v1", api_key="sk-dummy-123")
response = client.chat.completions.create(
    model="opencode/big-pickle",  # stable alias; any id from GET /v1/models works
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

**Node.js (official OpenAI SDK)**

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8083/v1', apiKey: 'sk-dummy-123' });
const res = await client.chat.completions.create({
    model: 'opencode/big-pickle', // stable alias; any id from GET /v1/models works
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
| `info` | Default. Startup information plus a one-line summary for every `/v1/*` request: method, path, model, streaming, status, latency, request id. Other paths (a health probe, the index page) are summarised at `debug`, so a probe loop cannot flood the log. The model id in that line is normalised (control characters replaced, length capped): it comes from the request body, and a newline in it must not be able to start a second log line. A value the operator configured (a path, a log level, a bind host, a tuning value) is normalised the same way wherever a startup line quotes it, including the `[Config]` note that names a value it could not use. stdout. |
| `debug` | Inbound request headers and body (credential-shaped values masked), the final payload sent to the backend, and full responses. stdout. |

A request body that carries `__proto__` or `constructor` as a property name is refused with `400` before it reaches
the handler (Fastify's prototype-poisoning guard); the message names that reason rather than claiming the JSON is
invalid, because a body with one of those keys parses fine and the fix is to remove the key, not the comma. A `415`
likewise names what it refused: `unsupported content type "application/xml"; send Content-Type: application/json`, and
`the request has a body but no Content-Type header; send Content-Type: application/json` when the header is missing.
The type is client input echoed into a response body, so it is bounded and masked like any other echoed value: a client
that sent `application/json; api_key=…` is told the type it sent and not handed its secret back.

Sensitive headers such as `authorization`, `x-api-key`, `cookie` and any name carrying a credential segment —
`token`, `secret`, `session`, `password`/`passwd`/`pwd`, `key`, `code`, `sig`/`signature`, `credential`, `bearer` — are
masked before they are logged, and so are
credential values sent in a query string (`?api_key=…`, and the spellings other clients use for the same secret:
Google's `?key=…`, an OAuth `?code=…`, an Azure SAS `?sig=`/`?signature=…` — in a fragment too, since a raw client can
send `GET /v1/models#access_token=…`, which `curl` and browsers strip but a socket does not) and a credential carried
by the configured backend URL
(`http://user:secret@host:4097`, a proxy in front of the backend): the startup summary, the `[Config]` notes and
`/health` show `http://***@host:4097` instead. An upstream reason that quotes the same credential back — a proxy in
front of the backend reporting the `Authorization: Basic …` header it refused — is masked as `Basic ***` before it
reaches a `502` body or a log line, the configured backend credential is masked even when the upstream quotes it
base64-encoded and shorter than 16 characters, and a `user:pass@` inside the URL of a request log line is masked too. The same sentence is masked in a **stack trace** and in a debug dump of a request
body: a stack's first line is the message it repeats, so a record that masked `message` and printed `stack` verbatim
published the credential the masking had just removed. A string in that dump is cut at 32 KB *before* it is masked,
the length the finished line is cut to: a body at the 50 MiB limit cost 688 ms of event loop per debug line while
only the first 32 KB of it could ever be printed. The container's first-boot line prints the API key as its
length and, above 16 characters, a 4-character prefix — `docker logs` is collected as often as not. Masking replaces
the value of a header or key and never drops it: an odd name such as `__proto__` is still shown (masked like any
other), because the debug dump is what you read to see what a client actually sent. Two shapes are masked that are not
headers or query strings at all: a credential that carries a **space** (`http://user:pass phrase@host:4097`, which Node's
own "URL that includes credentials" sentence quotes verbatim) is masked inside a sentence, and a bare `name=value` pair
whose name is a credential (`api_key=…`, `application/x-api-key=…`) is masked in the values echoed back into a response
body, such as the `Content-Type` a `415` names.

The startup summary prints the effective port, backend URL, tool filtering, log level and capacity
(`Concurrency: … completion(s) processed in parallel`, `Wait queue: … waiting completion(s) before 503 queue_full`). The
`opencode` version follows it as its own line: it is read beside the running server, because a `--version` that hangs
(a wrapper script, a cold npm shim) must not keep the gateway from binding. A
`OPENCODE_PROXY_MAX_CONCURRENCY` / `OPENCODE_PROXY_MAX_QUEUE` / `OPENCODE_PROXY_MAX_BODY_MB` value that is not a
number, or is outside its range, is
reported as a `warn` line next to it instead of being applied silently — a throughput knob that quietly falls back to
the default is indistinguishable from one that has no effect.

---

## Docker

A container image with the OpenCode CLI preinstalled is published for `linux/amd64` and `linux/arm64`; see
[docker/README.md](docker/README.md) for image tags, environment variables, and port exposure.

```bash
docker pull dinhdev666/free-opencode-api:latest
docker run -d --restart=always -p 8083:8083 -e API_KEY=sk-your-key dinhdev666/free-opencode-api:latest
```

Docker Hub selects the matching architecture automatically. The image runs as the unprivileged `node` user
(uid/gid 1000), not as root: a bind-mounted `config.json` or credential directory has to be readable by that user (see
[the container README](docker/README.md#running-as-a-non-root-user)). A new image is published by
`.github/workflows/docker-publish.yml` whenever a `v*.*.*` tag is pushed — see [CI and Releases](#ci-and-releases).

---

## CI and Releases

Two GitHub Actions workflows live in `.github/workflows/`; the CI checks need no secrets at all:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | every push to `main`, every pull request, manual dispatch | Three jobs. **Test** runs `pnpm run check`, `sh -n` + `shellcheck` on `docker/docker-entrypoint.sh` and `pnpm test` (the smoke suite in `test/`, which needs no OpenCode CLI or network) on Node 20, 22 and 24, plus an advisory `pnpm audit --audit-level high` on the Node 22 entry only (`continue-on-error: true`, never a gate), plus a gate step — every action pinned to a commit SHA. **Commit messages follow the convention** runs `pnpm run check:commits` over the commits this run adds, in its own job so it cannot disappear with a matrix entry. **Build the container image** builds the image for the runner's architecture, builds it again for `linux/amd64,linux/arm64` (the two published platforms, no registry involved), starts the container and waits for `/health` to answer. |
| `docker-publish.yml` | pushing a `v*.*.*` tag, or a manual dispatch from a tag | Fails if the tag does not match `version` in `package.json`, then builds `linux/amd64` + `linux/arm64` and pushes `<version>` and `latest` to Docker Hub. Needs the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets. The tagged commit must already be on `main` and every check run on it must have concluded `success`, `skipped` or `neutral`: a tag on a commit CI never ran is refused. |

The required status checks on `main` are `Test on Node 20`, `Test on Node 22`, `Test on Node 24`,
`Build the container image` and `Commit messages follow the convention`, so renaming those jobs also changes the
branch protection rules.

Publishing a release is therefore just a tag:

```bash
git tag vX.Y.Z        # must match "version" in package.json
git push origin vX.Y.Z
```

---

## Project Structure

```text
.
├── index.js                  # Entry point: merges config and starts the gateway
├── src/
│   ├── proxy.js              # Fastify app, OpenAI routes, OpenCode backend management
│   ├── text.js               # Request ids, log-safe truncation and masking of values
│   ├── errors.js             # Client-facing sentences for a failed upstream call
│   ├── upstream.js           # Classifies what the backend threw (tag, status, cause chain)
│   ├── socket.js             # end() then destroy() fallback for a raw socket close
│   ├── api-key.js            # The built-in API key and resolveApiKey()
│   ├── backend-auth.js       # Basic Authorization header for the backend
│   ├── env.js                # OPENCODE_PATH lookup, backend URL and bind host normalisation
│   ├── options.js            # parseBoolean()/readFlag(), the single boolean parser
│   ├── settings.js           # Tuning-key readers and their defaults
│   ├── config.js             # Reads config.json (a missing file is fine, an unusable one stops the gateway)
│   ├── logger.js             # Zero-dependency leveled logger with secret masking
│   └── polyfills.js          # Node 20 shims (Promise.withResolvers)
├── config.json.example       # Sample configuration
├── package.json              # Scripts, dependencies, packageManager pin (pnpm)
├── pnpm-lock.yaml            # Locked dependency tree (pnpm)
├── docker/                   # Dockerfile, entrypoint, container documentation
├── test/
│   ├── stub-opencode.mjs     # Minimal opencode serve stand-in used by the smoke suite
│   ├── smoke.mjs             # Contract checks: boot stub + gateway, assert OpenAI behaviour
│   ├── check-syntax.mjs      # `node --check` over every JavaScript file in the repository
│   └── check-commit-messages.mjs  # Applies the CONTRIBUTING.md rules to a commit range
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
| `401 Unauthorized` | The request has a missing or mismatched `Authorization: Bearer …` header (the message says which: no key, a wrong `Authorization` header, or a wrong `X-Api-Key` header); send the configured `API_KEY` (default `sk-dummy-123`). |
| Requests time out | The backend is slow or unavailable; check `/health`, verify `opencode auth login` was completed, and consider raising `OPENCODE_PROXY_REQUEST_TIMEOUT_MS`. |
| Empty streaming responses | Check `opencode --version`: the gateway reads the 2.x event stream (`session.text.delta`, `session.step.ended`, …), and a 1.x backend that answers at all speaks a different one. |
| `503 queue_full` with `Retry-After: 1` | Every completion slot is busy and the wait queue is full (`OPENCODE_PROXY_MAX_QUEUE`, default 64). Retry after the advertised delay, or raise `OPENCODE_PROXY_MAX_CONCURRENCY` — only if the backend tolerates concurrent sessions. |
| `400 model "…" must be a "provider/model" id` | The `model` value had an empty half (`opencode/` or `/big-pickle`). Send a full id from `/v1/models`, or omit `model` to use `opencode/big-pickle`. |
| `502 OpenCode backend rejected …` | The backend answered a non-2xx to a gateway call (session creation, prompt, message poll, event stream). The message carries the upstream status and reason; check `opencode --version` and the backend log. |
| `502 … rejected session creation (status 404 or 405)`, or a backend that never becomes ready | The `opencode` on `PATH` is a **1.x** release: its `serve` predates the `/api/*` routes this gateway drives (a 1.x server has no `/api` route at all), so the readiness probe (`GET /api/info`) never passes and every completion answers `502 backend_unreachable`; when something does answer, `POST /api/session` answers 404/405 and the gateway logs a warning naming this cause. Install a 2.x version (`npm install -g @opencode/cli`) or point `OPENCODE_PATH` at one. |
| `502 … rejected session creation (status 401)` | The backend refused the gateway's credentials. A spawned backend is handed the password the gateway generated (or the one you configured), so this means an **external** 2.x server whose `OPENCODE_SERVER_PASSWORD` differs from the gateway's: set the same value in both. |
| `502 … Failed to start OpenCode backend …` (`code: "backend_unreachable"`) | The gateway could not start its backend: `OPENCODE_PATH` is wrong, the CLI is not on `PATH`, the backend port (`OPENCODE_BIND_HOST`:`4097`) is taken, or a previous start failed and its cooldown is still running. The message names the cause; `/health` keeps answering `200` throughout, and the next request retries the start. |
| `503` with `code: "gateway_shutting_down"` | The gateway received `SIGINT`/`SIGTERM` and is finishing the responses it already accepted. Retry after the advertised `Retry-After` (1 s) against a gateway that is up — a load balancer should stop sending new work on the first signal. |
| Requests fail while a body uploads | The gateway answers `408` when a declared body stops arriving (no bytes for 30 s or the request budget, whichever is shorter). A slow but steady upload is served; a stalled one is closed so it cannot hold a socket without a credential. |
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
