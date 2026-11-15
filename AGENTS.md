# AGENTS.md

Instructions for AI coding agents (and human contributors) working in this repository. Read this file before
changing code; it records the invariants that the project's behaviour depends on and the checks expected before a
change is considered done.

## What this project is

`free-opencode-api` is a single-purpose gateway: it exposes an **OpenAI-compatible** HTTP API and fulfils each request
by driving an `opencode serve` process through the OpenCode SDK. The gateway owns the backend lifecycle (probe,
spawn, health checking, teardown), creates one OpenCode session per chat completion, and translates the result back
into OpenAI shapes (JSON or SSE).

There is no database, no plugin system, no multi-provider routing layer. Anything that does not serve the
"OpenAI client → gateway → OpenCode" path is out of scope.

## Non-negotiable invariants

These are product decisions, not implementation details. Do not "improve" them without an explicit request:

1. **Authentication is always enforced.** Every route except `OPTIONS`, `/health` and `/` requires
   `Authorization: Bearer <API_KEY>`; the scheme is matched case-insensitively with any amount of whitespace, and
   `X-Api-Key: <key>` is accepted as an alias when no `Authorization` header is sent (the preflight advertises that
   header, and clients configured with an api-key header send it) — a present `Authorization` header always decides,
   so a wrong one is never rescued by the alias. A blank or missing `API_KEY` falls back to the built-in default
   `sk-dummy-123` (`resolveApiKey()` in `src/proxy.js`). Never add a "disable auth" switch, never treat an empty key
   as "no auth". The bearer is compared in **bytes** (`timingSafeEqual` on two `Buffer`s of equal length): a key with
   non-ASCII characters matches in string length while differing in byte length, and comparing strings threw a
   `RangeError` that turned a wrong key into a `500` instead of a `401`.
2. **The default key stays visible and warned about.** `index.js` logs a `[Security]` warning when the built-in key is
   in use; the startup summary states that authentication is enforced.
3. **OpenAI wire format is the contract.** Success and error bodies, SSE frames, status codes and header names must
   stay compatible with standard OpenAI clients. See "API contract" below. `stream` in particular is read through
   `parseBoolean()`: a JSON boolean is the normal case, but hand-written clients send `1` or `"yes"`, and a literal
   `=== true || === 'true'` comparison answered a JSON body to a client that was parsing SSE.
4. **English only.** Code, comments, log messages, documentation and commit messages are written in English. The
   copyright holder remains `Phạm Văn Định` (LICENSE, `package.json`, Docker image labels).
5. **pnpm for project dependencies.** `package.json` pins `packageManager: pnpm@12.18.0`. `npm` appears only for
   installing the `opencode-ai` CLI, never for this project's dependency tree.
6. **Two runtime dependencies.** `fastify` and `@opencode-ai/sdk`. Adding a dependency requires a clear, stated
   reason; the project deliberately avoids helper packages (routing, CORS, logging, body parsing are all in-tree or
   built into Fastify).

## Repository map

| Path | Responsibility |
| --- | --- |
| `index.js` | Entry point. Loads `config.json`, merges **env > file > default**, prints the startup summary (including the resolved concurrency/queue capacity and any clamp, via `getQueueLimits()`), calls `startProxy()`, wires `SIGINT`/`SIGTERM` shutdown. |
| `src/proxy.js` | Everything else: Fastify app, hooks (request id/logging, CORS, auth), `/v1/models`, `/v1/chat/completions`, `/health`, error/404 envelopes, completion queue, SSE collection, polling, backend lifecycle (`ensureBackend`, spawn, health probe). |
| `src/config.js` | Reads `config.json` for the entry point. A missing file is fine; a file that exists and cannot be used (invalid JSON, not an object) stops the gateway, because silently continuing would run with the built-in key instead of the configured one. |
| `src/logger.js` | Zero-dependency logger with `error`/`warn`/`info`/`debug` levels, `[gateway]` prefix and `maskHeaders()` used by debug logging. |
| `config.json.example` | Template for `config.json` (not committed). |
| `docker/` | `Dockerfile`, `docker-entrypoint.sh` (writes `config.json` from env), container README. |
| `test/stub-opencode.mjs` | Minimal stand-in for `opencode serve` (health, providers, sessions, messages, SSE events) used by the smoke suite. |
| `test/smoke.mjs` | End-to-end contract checks: boots the stub and the gateway, asserts status codes, envelopes, SSE frames and clean shutdown. |
| `.github/workflows/ci.yml` | CI: `pnpm run check`, shell check, `pnpm test` on Node 20/22/24, plus a Docker build with a container health check. |
| `.github/workflows/docker-publish.yml` | Publishes `linux/amd64` + `linux/arm64` images to Docker Hub when a `v*.*.*` tag is pushed (secrets `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`). |
| `README.md` | User-facing documentation: features, configuration tables, API reference, client examples, performance, troubleshooting. |

Request flow (short version): `index.js` → Fastify hooks → auth → route handler → queue (`lock()`) → validate and
normalise messages → `ensureBackend()` → `client.session.create()` → prompt + event stream in parallel (streaming) or
prompt then polling (non-streaming) → OpenAI response → session cleanup.

## Commands

```bash
pnpm install --frozen-lockfile   # install dependencies
pnpm start                       # run the gateway (needs the opencode CLI on PATH)
pnpm run check                   # node --check for every JavaScript source file
pnpm test                        # smoke suite: stub backend + gateway, 126 contract assertions
sh -n docker/docker-entrypoint.sh
```

`pnpm test` needs no OpenCode CLI and no network: it starts `test/stub-opencode.mjs` on port 4199 and the gateway on
port 8199 (override with `SMOKE_STUB_PORT` / `SMOKE_PORT`). CI runs `pnpm run check` and `pnpm test` on Node 20, 22
and 24. There is still no linter or formatter, so style is a review concern. Do not claim checks passed if they were
not run.

Releases are published from tags, not from a laptop: bump `version` in `package.json`, then `git tag vX.Y.Z` and push
the tag. `docker-publish.yml` refuses a tag that does not match `package.json`, builds both architectures and pushes to
Docker Hub.

## Verifying without the OpenCode CLI

`pnpm test` covers the whole HTTP contract against the stub shipped in `test/stub-opencode.mjs` (which implements
`GET /health`, `GET /config/providers`, `POST /session`, `POST /session/:id/message`, `GET /session/:id/message`,
`DELETE /session/:id` and an SSE `GET /event`, plus three test-only hooks: `GET /__sessions` (created/deleted/live
counts) and the prompt markers `SLOW` (a ~2 s answer, so a test can abort mid-stream), `STALL` (two deltas and
then silence, so a test can prove a stalled stream still ends), `TOOLTAG` (an answer whose tool-call block is cut
in the middle of both of its tags, so a test can prove the markup never leaks) `FAIL` (a provider error with no
content, so a test can prove both modes report it as an error and the failure path cleans up after itself) and
`ENDONLY` (an answer whose finish event carries only `time.completed`, so a test can prove the stream still ends
without waiting for the idle timeout) and
`GROW` (an answer that is still being written when the prompt returns, so a test can prove the polled answer is never
truncated), `STUB_EMPTY_PROVIDERS=1` (a provider list with no models, so a test can prove the model listing falls back
instead of serving an empty list) and `HOLD` (an answer that only finishes after 400 ms, so a test can keep a completion in flight while the
backend is killed or the gateway is shutting down) and `TAILTAG` (an answer whose last delta ends in a tag prefix that
never becomes a tag, so a test can prove the held fragment is still delivered). Extend that stub and
`test/smoke.mjs` when you add behaviour worth protecting. The suite refuses to start when the stub or gateway port is
already taken (a stale process would answer with someone else's build) and SIGKILLs any child that ignores SIGTERM.

For exploratory work, start the stub (or a throwaway one in `/tmp`) on a spare port and point the gateway at it:

```bash
OPENCODE_SERVER_URL=http://127.0.0.1:4096 PORT=8080 LOG_LEVEL=debug node index.js
curl -s http://127.0.0.1:8080/health
curl -s -H 'Authorization: Bearer sk-dummy-123' -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":true}' \
  http://127.0.0.1:8080/v1/chat/completions
```

Throwaway stubs used for one-off exploration stay in `/tmp`; anything worth keeping becomes part of
`test/stub-opencode.mjs`.

## API contract (must not drift)

- `GET /` → `200 {"service":"free-opencode-api","status":"ok","endpoints":{"health":"/health","models":"/v1/models","chat_completions":"/v1/chat/completions"}}`
  without a key: the auth hook leaves it open, so it must answer instead of falling through to the 404 handler.
- `GET /health` → `200 {"status":"ok","backend":"<OPENCODE_SERVER_URL>"}`, never touches the backend. It is open
  without a key in every form a probe uses it — HEAD, and a trailing slash (`ignoreTrailingSlash` routes `/health/`
  to the same handler, so the open-route test must match it too, otherwise a liveness probe answers 401).
- `GET /v1/models` → `200 {"object":"list","data":[{id,name,object,owned_by}, …]}`; 5 s cache, and a cold-cache burst
  shares one provider round trip (`modelsInFlight`) instead of one per request; failures — including a provider call
  that runs into its deadline, because a silent backend would otherwise never answer the listing at all — fall back to
  a single static model and are not cached. An **empty** provider list takes the same fallback: a payload the gateway
  cannot read (a changed shape, a version that reports nothing) answers `200 {"providers":[]}`, and serving
  `{"data":[]}` is as useless to a client as an error, because it leaves nothing to choose from.
- `GET /v1/models/:modelId` and `GET /v1/models/<id with slashes>` → `200 {id,name,object,owned_by}` from the same
  cache; an id the provider list does not contain is described from the id itself (`provider` = text before `/`,
  default `opencode`) rather than 404, because `/v1/chat/completions` does not restrict the model either. The
  wildcard route exists because clients send `opencode/kimi-k2.5-free` unencoded as often as `%2F`-escaped.
- `POST /v1/chat/completions` non-streaming → `chat.completion` with
  `choices[0].message.{role,content,reasoning_content}`, `finish_reason:"stop"` and a `usage` block of zeroes
  (upstream does not report token counts).
- `POST /v1/chat/completions` streaming → `text/event-stream`, frames `data: {…chat.completion.chunk…}\n\n`,
  a final frame with `"finish_reason":"stop"`, then `data: [DONE]\n\n`. Reasoning deltas use `reasoning_content`.
  The terminal frame carries the whole envelope (`id`, `object`, `created`, `model`) like every delta, not just
  `{id, choices}`: clients that check the object type of each frame rejected a bare terminal chunk.
  Before the first delta, a `: keep-alive` comment line is written every 15 s (ignored by OpenAI clients, keeps idle
  proxies from dropping the connection); it stops as soon as real frames flow.
  `stream_options.include_usage` adds one more chunk with `choices: []` and a zeroed `usage` block, after the finish
  chunk and before `[DONE]`: the OpenAI SDK reads the stream's usage from exactly that frame, and ignoring the option
  left it with no numbers at all. It is emitted only when the client asks for it — a stream that did not request it
  must not grow an extra frame.
- A completion body sent under a non-JSON content type (`curl -d '{…}'` without the header, `text/plain`) reaches the
  handler as an unparsed string; it is parsed there and served. Answering "messages array is required" blamed a body
  that was perfectly valid for a missing header. A string that is not JSON answers `400` naming the content type.
- Errors → `{"error":{"message":"…","type":"…"}}` with `400` (bad request, `type: "invalid_request_error"`, plus
  Fastify's `code` when it rejected the body), `401` (auth, `type: "invalid_request_error"`,
  `code: "invalid_api_key"`), `404` (unknown route, `type: "not_found"`), `502` (upstream/provider error), `503`
  (`type: "queue_full"`, the wait queue is full), `504` (timeout), `500` (anything else). Every error body carries a
  `type`; `500`, `502` and `504` use `type: "server_error"` and never an internal exception class name. A backend that
  disappears in the middle of a request is an upstream failure (`502`), not a gateway bug (`500`): the client is told
  the upstream is gone, and the next request starts the backend again.
- A provider failure is an upstream error in both modes. Non-streaming answers `502`; a streaming request whose
  provider failed before the first frame answers the same `502` envelope (the stream never started), and one that
  fails after frames are on the wire ends with the in-band error frame. It must never be streamed as assistant text:
  `data: {… delta: {content: "[Proxy Error] …"}}` with `finish_reason: "stop"` is a successful answer to every client.
- A client that disconnects mid-stream releases its queue slot immediately: the event subscription is aborted and
  the polling fallbacks are skipped (the backend keeps finishing on its own).
- An error after the first SSE frame is delivered in-band (`data: {"error":…}` then `data: [DONE]`) and closes the
  stream. A hijacked response must always be terminated: writing a JSON body into a frame stream (or leaving the
  socket open) breaks or hangs the client.
- Every completion deletes the OpenCode session it created — on the success path, the error path and after a client
  abort. The backend must never accumulate one session per served request; `test/stub-opencode.mjs` exposes
  `GET /__sessions` so the smoke suite can assert `live === 0`.
- CORS headers are set on the raw response for every request, including hijacked streams:
  `Access-Control-Allow-Origin: *`, `Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: Content-Type,
  Authorization, X-Api-Key, X-Requested-With`, `Max-Age: 600`, `Expose-Headers: X-Request-Id`.
- Every response carries `X-Request-Id`, the same id the request log line ends with, so a client report can be traced
  to a log entry. An incoming `X-Request-Id` is echoed when it is a short printable token
  (`[A-Za-z0-9._:-]{1,64}`) and replaced by a generated `gw-…` id otherwise — the value reaches the log line and a
  response header, so a header value carrying spaces, newlines or control characters must never be copied through.
  `Access-Control-Expose-Headers: X-Request-Id` lets a browser client read it back.
- Request log format: `METHOD url -> status Xms [reqId] model=… stream=…` (info for `/v1/*`, debug otherwise).

## Working rules for code changes

- **Keep the hot path thin.** No new per-request allocations or object rebuilds. Debug-only work must be guarded by
  `logger.isEnabled('debug')`; responses with compiled schemas stay schema-serialised; SSE envelopes stay
  pre-serialised per stream.
- **Never `await reply` semantics after `reply.hijack()`.** A hijacked reply is the raw socket: write frames with
  `reply.raw.write()`, end with `reply.raw.end()`, and return `reply` unchanged.
- **New routes need an explicit registration.** Fastify runs hooks after routing, so a wildcard `OPTIONS` handler
  (`app.options('/*')`) is required for preflight; `onRequest` hooks alone do not answer unmatched paths.
- **Logging** goes through `src/logger.js` (`logger.info`, `logger.warn`, `logger.error`, `logger.debug`). No
  `console.log` in `src/` or `index.js`. Never log an unmasked `authorization` header, and never print the API key:
  `docker/docker-entrypoint.sh` reports the key it generated as `sup*** (22 chars)`, because `docker logs` is collected
  as often as not (`maskHeaders`/`maskSecret` in `src/logger.js` are the in-process equivalents).
- **Tool-call filtering** removes `<function_calls>…</function_calls>` blocks only when `DISABLE_TOOLS` is on. The
  streaming variant holds back a trailing fragment that could still become one of the two tags, because a delta
  boundary can fall inside either of them; the held fragment is flushed at end of stream. The flush must write the
  frame directly (`sendReleasedDelta`): passing the fragment back through the filter holds the same prefix again and,
  with no further delta to disambiguate it, the tail of the answer disappears. `DISABLE_TOOLS` is read
  from the environment under both its bare name and the legacy `OPENCODE_DISABLE_TOOLS`.
- **Boolean options go through `parseBoolean()`** (exported from `src/proxy.js`), the single parser used by
  `index.js` and `startProxy()`. Two implementations of that rule drifted once already (`-e DISABLE_TOOLS=yes` meant
  "off" inside the container); do not add a third.
- **Configuration** follows the precedence env > `config.json` > default, and every new key must be added to
  `config.json.example`, the README configuration table and — for container-relevant keys — `docker/docker-entrypoint.sh`.
  `OPENCODE_SERVER_URL` is normalised at startup (`normalizeBackendUrl`): a trailing slash is stripped and a missing
  scheme is read as `http://`, both with a `[Config]` warning. A trailing slash made every SDK path `//session`, which
  the backend answers with 404 — the gateway then reported "backend exited during startup", which points nowhere near
  the real cause.
- **Polling answers with the finished message.** `pollForAssistantResponse` is called with `requireDone: true` on
  every path that emits the final answer: the poll loop can start while the answer is still being written, and
  returning the first non-empty message truncated it (`"Hello from t"` for a 41-character answer). A message whose
  text stops growing for three consecutive polls is accepted anyway, so a provider that never marks its message
  finished still gets an answer.
- **A finished message ends the stream, whatever the finish reason.** The collector settles on any non-empty
  `finish` (or `time.completed`), not just `finish === "stop"`: requiring the literal word left answers from
  providers that report `tool-calls`, `end` or only `time.completed` waiting for the 8 s idle timeout.
- **Every backend call carries a deadline.** `client.session.create`, `client.session.messages`,
  `client.session.delete`, `client.session.prompt`, `client.config.providers` and `client.tool.ids` are all called
  with an `AbortSignal` (`backendDeadline()`), and an expired one answers `504` ("did not answer within …ms") instead
  of `500`. Node's `fetch` has no default timeout: a wedged backend that still answers `/health` but never answers
  `/session` left the handler waiting forever, so the client got no response at all and the queue slot was never
  released — at the default concurrency of 1 that stops the whole gateway. Session cleanup uses its own shorter budget
  (`SESSION_CLEANUP_TIMEOUT_MS`): it runs after the client already has its answer, so it must not hold the slot for
  the full request budget. The metadata calls (`/v1/models`, the tool list) are capped separately
  (`METADATA_TIMEOUT_CAP_MS`, and never above `REQUEST_TIMEOUT_MS`), because they fall back — a client listing models
  must get the static fallback quickly instead of waiting a whole completion budget for a silent provider.
- **A promise that loses a race needs a handler.** `promptWithTimeout` races the prompt against its own timer, and the
  losing promise keeps running: a rejection that arrives afterwards (the backend dies, or the deadline aborts the
  fetch) reached nothing and became an unhandled rejection, which terminates the process by default — one slow
  completion could take the whole gateway down. Every raced promise gets a `.catch(() => {})` attached.
- **Timeouts and fallbacks are behavioural contracts.** The polling fallback, the shortened first-delta wait, the
  health-probe cache and the backend start-failure cooldown exist because of real OpenCode protocol quirks
  (opencode ≥ 1.19 event payloads, free zen models). Do not remove them without replacing the behaviour they cover.
- **Signals belong to the entry point.** `index.js` owns `SIGINT`/`SIGTERM`: it closes the HTTP server, lets the
  responses in flight finish (1.5 s grace), stops the backend and exits, with a watchdog so an open SSE stream cannot
  block shutdown. The backend is stopped *after* that grace period, not before it: killing it first turned a
  completion the gateway was already serving into an upstream error, which is the opposite of a graceful shutdown.
  Every exit path stops the backend exactly once, so it can never outlive the gateway. Do not register signal handlers
  that call `process.exit()` from a module — they win the race and skip backend teardown.
- **The wait queue is bounded** (`OPENCODE_PROXY_MAX_QUEUE`, default 64) because every waiting request pins its parsed
  body; overflow answers `503 queue_full` instead of growing memory. The cap counts *waiting* requests, so it is only
  reached while every slot is busy: `0` means "never queue", not "refuse every completion" (a lone request with a free
  slot is served, which is what makes a `0` configuration safe to try). A slot is released when its response is
  complete (`release()` in `runQueuedTask`), not when the task promise settles: the session deletion after the answer
  is a backend round trip, and holding the slot through it made an immediate follow-up request look like a full
  gateway. `.finally(release)` stays the safety net, so `release()` is idempotent and every path frees the slot. A
  request whose client disconnects while it is still queued is dropped when its turn comes (`reply.raw` 'close'), so
  it never spends backend time or delays the requests behind it. Do not use `request.raw.destroyed` as the disconnect
  signal: the request stream is destroyed as soon as its body has been read, which is the normal case.
- **The backend command survives the shell it runs in.** `opencodeBin` is quoted whenever the spawn uses a shell
  (`C:\Program Files\...opencode.cmd` does not start unquoted, and `;`/`&` in a path would be read as operators);
  paths carrying `"`, `$` or a backtick are refused instead, because quoting cannot neutralise them. A configured
  `OPENCODE_PATH` that does not exist is warned about rather than silently replaced by whatever the PATH search finds.
- **Backend lifecycle changes** must keep these properties: `ensureBackend()` trusts a successful probe for
  `OPENCODE_PROXY_HEALTH_CACHE_MS`, connection failures clear that trust, a spawned process that exits during startup
  aborts the readiness wait, and a failed start triggers a cooldown instead of a retry storm. "Exits" means
  `exitCode !== null || signalCode !== null`: a child killed by a signal reports `exitCode === null`, and testing the
  exit code alone let a SIGKILLed backend look alive for the whole 60-iteration startup budget while
  `isStarting` stayed true — every request in that window waited instead of answering. A request waiting on someone
  else's start attempt falls through to its own attempt when that attempt ends without a reachable backend (the retry
  cooldown still applies), because the first request after a crash should restart the backend, not report it gone.

## Performance guardrails

`README.md` publishes benchmark numbers; a change that plausibly affects throughput or latency should be measured
with `autocannon` against a stub backend (a real model is too slow and too variable to compare):

```bash
pnpm dlx autocannon -c 10 -d 8 -m POST -H "content-type: application/json" \
  -H "authorization: Bearer sk-dummy-123" \
  -b '{"messages":[{"role":"user","content":"hi"}],"stream":false}' \
  http://127.0.0.1:8080/v1/chat/completions
```

Report before/after instead of asserting an improvement, and update the README table only with numbers you actually
measured on the machine you measured them on. Completion requests are serialised by default
(`OPENCODE_PROXY_MAX_CONCURRENCY=1`); that default is intentional and must stay `1`.

## Definition of done

Before reporting a change as complete:

1. `pnpm run check` passes (syntax check for every JavaScript file).
2. `pnpm test` passes; new behaviour that can be asserted belongs in `test/smoke.mjs`.
3. The gateway boots (`pnpm start` or `node index.js`) and `GET /health` returns `200`; with a real backend,
   `/v1/models` with the key returns `200` and without it `401`, a chat completion works with and without
   `stream: true`, and an invalid body returns `400`.
4. Documentation that describes the changed behaviour is updated in the same change (README tables, Docker README,
   this file when invariants or commands change).
5. Shutdown is clean (`SIGINT` logs `[Shutdown]` and exits) when backend lifecycle code was touched.
6. The report states exactly what was run and what was not (for example: "Docker image not built — no Docker here").

## Reporting

Use the repository issue tracker for bugs and proposals: <https://github.com/dinhdev666/free-opencode-api/issues>.
Security-sensitive reports (auth bypass, key leakage, command injection in backend spawning) should not be filed
publicly; see `CONTRIBUTING.md`.
