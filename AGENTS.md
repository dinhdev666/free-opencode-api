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
   so a wrong one is never rescued by the alias. Presence is what decides, not the parsed token: a proxy that injects
   `Authorization: Basic …`, or a client that sends a bare `Bearer`, sends an Authorization header the gateway could
   not read, and testing the parsed token instead let the alias rescue it. A blank or missing `API_KEY` falls back to the built-in default
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
| `test/check-syntax.mjs` | Walks the repository and runs `node --check` on every `.js`/`.mjs` file, so a new source file is checked without editing a list. |
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
pnpm run check                   # node --check for every JavaScript source file (test/check-syntax.mjs walks the tree)
pnpm test                        # smoke suite: stub backend + gateway, 174 contract assertions
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
truncated) and `STUB_FAIL_SESSION=1` (a 405 for `POST /session`, so a test can prove an
incompatible backend is reported as an upstream error with its status and reason), `STUB_FAIL_MESSAGES=<n>` (the first
n message polls answer 500) and `STUB_DROP_MESSAGES=<n>` (the first n message polls drop the connection) — both with
`STUB_ALWAYS_FAIL_MESSAGES=1` to fail every poll, so a test can prove a completion survives a transient poll failure
and gives up on a persistent one, `PAUSE` (an answer that goes silent for 12.5 s - longer than the idle timeout -
before it finishes, so a test can prove the recovery poll does not truncate it) and `HOLD` (an answer that only finishes after 400 ms, so a test can keep a completion in flight while the
backend is killed or the gateway is shutting down), `SLOWFINISH` (an answer that only finishes after 3 s, so a test can
prove a non-streaming request whose client disconnected stops holding its slot) and `TAILTAG` (an answer whose last delta ends in a tag prefix that
never becomes a tag, so a test can prove the held fragment is still delivered), `REJECTPROMPT` (a 500 for
`POST /session/:id/message`, so a test can prove a rejected prompt is reported as an upstream error instead of a
timeout) and `PROMPTDONE` (a prompt response that already carries the finished message and stores nothing for
polling, so a test can prove the fast path needed no poll - `GET /__sessions` reports `messagePolls` for that), plus
`STUB_EMPTY_PROVIDERS=1` serving an empty provider list on the first call and a provider without a `models` map after
it, so both shapes of an unreadable payload are covered, and `STUB_FAIL_EVENTS=1` (a 500 for `GET /event`, so a test
can prove a streaming request still answers through the polling fallback when the event stream is refused). Extend that stub and
`test/smoke.mjs` when you add behaviour worth protecting. The suite refuses to start when the stub or gateway port is
already taken (a stale process would answer with someone else's build) and SIGKILLs any child that ignores SIGTERM.
The session-cleanup assertions go through `sessionsAfterCleanup()`: the gateway answers the client *before* deleting
the session (the delete is a backend round trip that has nothing to do with the answer), so a single read of
`/__sessions` raced with it and failed with `live: 1` on a slow runner. Wait for `live: 0` within a bounded window
instead of sampling one instant.

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
  a single static model and are not cached. That model is `opencode/big-pickle` (`DEFAULT_MODEL` in `src/proxy.js`),
  which is also the model a chat request that omits `model` is sent to; both uses read the same constant, so the
  fallback listing and the request default cannot name different ids. `big-pickle` is an **alias**: OpenCode routes it
  to whichever model it currently serves and never publishes which one, so it is the only id worth hardcoding — and the
  reason its entry carries just the four OpenAI fields. Do not add capabilities, limits or pricing to it: they would
  describe a model the gateway cannot see, and the concrete ids around it rotate.
  An **empty** provider list takes the same fallback: a payload the gateway
  cannot read (a changed shape, a version that reports nothing) answers `200 {"providers":[]}`, and serving
  `{"data":[]}` is as useless to a client as an error, because it leaves nothing to choose from. So does a provider
  list that is not empty but yields no model (a provider without a `models` map, an empty one): the empty check runs
  after the extraction, not on the provider list before it, because the answer - and the "do not cache it" rule - is
  the same for both shapes.
- `GET /v1/models/:modelId` and `GET /v1/models/<id with slashes>` → `200 {id,name,object,owned_by}` from the same
  cache; an id the provider list does not contain is described from the id itself (`provider` = text before `/`,
  default `opencode`) rather than 404, because `/v1/chat/completions` does not restrict the model either — the one
  exception is `opencode/big-pickle`, answered from `DEFAULT_MODEL` so it keeps its `Big Pickle` name instead of the
  id-derived `big-pickle`. The
  wildcard route exists because clients send `opencode/big-pickle` unencoded as often as `%2F`-escaped. A **blank**
  id (`/v1/models//`, `/v1/models/%20`) is a `404` in the usual `not_found` envelope instead of a `200` whose body is
  `{"id":"","name":""}`: a doubled slash is read as a trailing slash, so those paths reached the by-id route with an
  empty parameter, and an empty id is not a model. An id whose **last segment** is empty (`/v1/models/%2F` → `/`,
  `/v1/models/opencode%2F` → `opencode/`) is the same class of non-model and answers `404` too. `/v1/models/`
  itself still answers the listing.
- `POST /v1/chat/completions` non-streaming → `chat.completion` with
  `choices[0].message.{role,content,reasoning_content}`, `finish_reason:"stop"` and a `usage` block of zeroes
  (upstream does not report token counts). The `id` is `chatcmpl-<base36 stamp><counter>` and is unique per
  response: it used to be `chatcmpl-<epoch>`, so two completions that finished in the same millisecond carried the
  same id and a client keying its messages by id merged them — which concurrency above 1 makes routine.
- `POST /v1/chat/completions` streaming → `text/event-stream`, frames `data: {…chat.completion.chunk…}\n\n`,
  a final frame with `"finish_reason":"stop"`, then `data: [DONE]\n\n`. Reasoning deltas use `reasoning_content`.
  The first delta frame carries `"role":"assistant"` (with the first delta, not as an extra empty frame): OpenAI opens
  its stream that way, and a client that creates the message from `delta.role` had to infer it from the request.
  The terminal frame carries the whole envelope (`id`, `object`, `created`, `model`) like every delta, not just
  `{id, choices}`: clients that check the object type of each frame rejected a bare terminal chunk.
  Before the first delta, a `: keep-alive` comment line is written every 15 s (ignored by OpenAI clients, keeps idle
  proxies from dropping the connection); it stops as soon as real frames flow.
  `stream_options.include_usage` adds one more chunk with `choices: []` and a zeroed `usage` block, after the finish
  chunk and before `[DONE]`: the OpenAI SDK reads the stream's usage from exactly that frame, and ignoring the option
  left it with no numbers at all. It is emitted only when the client asks for it — a stream that did not request it
  must not grow an extra frame.
- **`system` and `developer` messages are the system prompt.** Both roles are folded into the prompt's `system`
  field (joined with blank lines) and never appear as conversation parts; every other role is labelled
  (`USER: …`, `ASSISTANT: …`) and sent as text. `developer` is OpenAI's newer name for the system role, so a client
  using it must not end up with "DEVELOPER: …" inside the conversation. The stub reports the last system prompt it
  received (`GET /__sessions` → `lastSystemPrompt`) so the suite can assert it.
- A `model` id whose provider or model half is empty (`"opencode/"`, `"/big-pickle"`) is a `400` in the
  `invalid_request_error` envelope naming the value: `/v1/models` answers `404` for the same ids, and sending them to
  the backend only produced an opaque upstream error. An absent or blank `model` still means `DEFAULT_MODEL`.
- A completion body sent under a non-JSON content type (`curl -d '{…}'` without the header, `text/plain`) reaches the
  handler as an unparsed string; it is parsed there and served. Answering "messages array is required" blamed a body
  that was perfectly valid for a missing header. A string that is not JSON answers `400` naming the content type.
  `curl -d` actually labels the body `application/x-www-form-urlencoded` (not `text/plain`), so that type is handed
  over as the same string by an explicit `addContentTypeParser` — Fastify answered it with a bare `415` and the
  documented header-free path did not work for the most common hand-written client. Other content types keep the
  `415` media-type error, because a gateway that parses every type cannot tell a malformed client from an unsupported
  one. A body sent with a `Content-Encoding` other than `identity` (a client that gzips, a compressing proxy) is a
  `415` naming the header: the gateway does not decompress, so the compressed bytes reached the JSON parser and were
  reported as "body is not valid JSON", which blames the one part of the request that was correct.
- Errors → `{"error":{"message":"…","type":"…"}}` with `400` (bad request, `type: "invalid_request_error"`, plus
  Fastify's `code` when it rejected the body), `401` (auth, `type: "invalid_request_error"`,
  `code: "invalid_api_key"`), `404` (unknown route, `type: "not_found"`), `502` (upstream/provider error), `503`
  (`type: "queue_full"`, the wait queue is full, with `Retry-After: 1` so an OpenAI SDK backs off and retries instead
  of failing the request), `504` (timeout), `500` (anything else). Every error body carries a
  `type`; `500`, `502` and `504` use `type: "server_error"` and never an internal exception class name. A backend that
  disappears in the middle of a request is an upstream failure (`502`), not a gateway bug (`500`): the client is told
  the upstream is gone, and the next request starts the backend again.
- A backend that rejects `POST /session` (a version whose API moved, a proxy in front of it, an error body) is an
  upstream failure too: `502` with the upstream status and reason in the message
  (`OpenCode backend rejected session creation (status 405): …`), not a bare `500 "Failed to create OpenCode session"`
  that blames the gateway and explains nothing. The SDK hands back the parsed body as-is, so the extraction handles
  `{error:{message}}`, `{message}` and a plain string, and never prints `[object Object]`. A `405` on that call also
  logs a warning naming the likeliest cause — a 2.x `opencode` CLI, whose `serve` is the web UI and answers `/health`
  with HTML, so the readiness probe passes and every completion fails here. The README's Requirements table and
  Troubleshooting section state the supported major version for the same reason.
- A **rejected prompt** is an upstream failure in both modes: the SDK resolves a non-2xx `POST /session/:id/message`
  with `{ error, response }` instead of throwing, so the tuple is inspected and answered `502` with the upstream status
  and reason (`OpenCode backend rejected the prompt (status 500): …`). Ignoring it made a rejected prompt look like a
  slow answer - no assistant message was ever created, so the gateway polled until its budget ran out and reported
  `504`. A streaming request keeps streaming only when deltas already reached the client.
- **A finished message in the prompt response is the answer.** `POST /session/:id/message` returns the message it
  produced; when it already carries `finish` or `time.completed`, the non-streaming path serves it instead of spending
  a `GET /session/:id/message` round trip (plus up to a poll interval) on data it already holds. A message that is
  still being written has no `finish` and keeps using the poll loop, so a partial answer is never served.
- Every SDK call hands back an error tuple instead of throwing, and every tuple is inspected: `session.create`,
  `session.prompt`, `session.messages`, `session.delete`, `config.providers`, `tool.ids` and `event.subscribe`.
  A refused `event.subscribe` carries no stream, so the streaming path falls back to polling and still answers;
  reading any of these as "the backend returned nothing" turned a refusal into a missing answer (`tool.ids` was the
  worst case: an error tuple cached an empty override map as a success, so `DISABLE_TOOLS` sent no tool switches at
  all for the whole cache window).
- A provider failure is an upstream error in both modes. Non-streaming answers `502`; a streaming request whose
  provider failed before the first frame answers the same `502` envelope (the stream never started), and one that
  fails after frames are on the wire ends with the in-band error frame. It must never be streamed as assistant text:
  `data: {… delta: {content: "[Proxy Error] …"}}` with `finish_reason: "stop"` is a successful answer to every client.
- A client that disconnects mid-stream releases its queue slot immediately: the event subscription is aborted and
  the polling fallbacks are skipped (the backend keeps finishing on its own). A reader that stops reading without
  closing the connection (a tab that stops consuming, a buffering proxy, a stalled phone link) is treated the same
  way: a write that does not drain within `SSE_CLIENT_WRITE_TIMEOUT_MS` (30 s) marks the client gone, aborts the
  collector and destroys the socket. An unbounded `drain` wait parked the task - and with it the only completion slot
  at the default concurrency of 1 - for the rest of the process lifetime while `/health` kept answering 200.
  The gone flag is set even when the response was already ended by someone else (the in-band timeout path): the
  socket is still open then, and the short-circuit left the task writing into an ended stream. A client that disconnects during a
  **non-streaming** completion is handled the same way: the closed response socket stops the poll loop, so the slot is
  free at the next poll tick instead of being held for the whole answer — a client that closed the tab used to block
  every other request for up to the request budget at the default concurrency of 1.
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
  `config.json` is read from the **application directory** (`path.join(__dirname, 'config.json')`), not from the
  working directory, because the container writes it next to the app. A `config.json` sitting in the cwd used to be
  ignored in complete silence, which looks exactly like a broken file, so startup now warns
  `[Config] config.json is read from …; the file at … is ignored` when one is present there.
  `OPENCODE_SERVER_URL` is normalised at startup (`normalizeBackendUrl`): a trailing slash is stripped and a missing
  scheme is read as `http://`, both with a `[Config]` warning. A trailing slash made every SDK path `//session`, which
  the backend answers with 404 — the gateway then reported "backend exited during startup", which points nowhere near
  the real cause.
- **Every tuning key follows the same precedence.** `OPENCODE_PROXY_MAX_CONCURRENCY`, `OPENCODE_PROXY_MAX_QUEUE`,
  `OPENCODE_PROXY_MAX_BODY_MB`, `OPENCODE_PROXY_REQUEST_TIMEOUT_MS`, `OPENCODE_PROXY_HEALTH_CACHE_MS` and
  `OPENCODE_PROXY_START_RETRY_MS` are read through `readLimit()` / `readMilliseconds()`, which take the `config.json`
  value as the fallback and let the environment win. They used to be read from the environment alone, so the same keys in `config.json` were ignored in
  silence while the startup summary reported the default — the same class of failure as a `config.json` in the wrong
  directory. `startProxy()` applies the resolved queue limits and backend timings before the server listens, and
  `getQueueLimits()` takes the merged configuration so the summary cannot disagree with what the gateway uses.
- **Polling answers with the finished message.** `pollForAssistantResponse` is called with `requireDone: true` on
  every path that emits the final answer: the poll loop can start while the answer is still being written, and
  returning the first non-empty message truncated it (`"Hello from t"` for a 41-character answer). A message whose
  text stops growing for three consecutive polls is accepted anyway, so a provider that never marks its message
  finished still gets an answer.
- **A failed poll does not end the completion.** `pollForAssistantResponse` retries a poll that answers with an error
  (a 5xx while the backend is busy) or throws (a connection reset while it restarts): one bad poll used to lose an
  answer that was one poll away - the thrown case surfaced as `502 "fetch failed"`. Only `MAX_POLL_FAILURES` (5)
  consecutive failures give up, and they report an upstream error with the status and reason
  (`OpenCode backend failed while polling the answer (status 500): …`, or `… : the backend is not reachable
  (fetch failed)` for a connection failure - the runtime's own wording names no cause) in ~2 s instead of burning the whole request
  budget and answering `504`. An empty list is a normal "not written yet" poll, not a failure, and an expired
  deadline still surfaces as the timeout it is.
- **An idle stream is recovered, not ended.** When the event stream goes silent for `DEFAULT_EVENT_IDLE_TIMEOUT_MS`
  the gateway polls for the rest of the answer and appends only what the client does not have yet. That recovery poll
  tolerates a full idle window of further silence (`IDLE_RECOVERY_STALL_POLLS`) before it accepts a message the
  backend never marks finished: the default allowance of three identical polls (~1.5 s) is right after a normal
  prompt, but applied to a stream that had already been silent for 8 s it ended the response with
  `finish_reason: "stop"` on text that stopped mid-sentence, which a slow provider still writing looks exactly like.
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
  body; overflow answers `503 queue_full` instead of growing memory. The other half of that bound is
  `OPENCODE_PROXY_MAX_BODY_MB` (default 50, the Fastify `bodyLimit`): the two defaults allow 3.2 GiB of pinned bodies,
  which no small host plans for, so the limit is a documented knob rather than a constant. The queue cap counts
  *waiting* requests, so it is only reached while every slot is busy: `0` means "never queue", not "refuse every completion" (a lone request with a free
  slot is served, which is what makes a `0` configuration safe to try). A slot is released when its response is
  complete (`release()` in `runQueuedTask`), not when the task promise settles: the session deletion after the answer
  is a backend round trip, and holding the slot through it made an immediate follow-up request look like a full
  gateway. `.finally(release)` stays the safety net, so `release()` is idempotent and every path frees the slot. A
  request whose client disconnects while it is still queued is dropped when its turn comes (`reply.raw` 'close'), so
  it never spends backend time or delays the requests behind it. Do not use `request.raw.destroyed` as the disconnect
  signal: the request stream is destroyed as soon as its body has been read, which is the normal case.
- **The image pins the CLI, and the pin is the 1.x line.** `docker/Dockerfile` installs `opencode-ai` with
  `ARG OPENCODE_VERSION=1.19.5` (the newest 1.x release, matching the bundled `@opencode-ai/sdk`). `latest` now
  resolves to the 2.x line, whose `opencode serve` serves the web UI — it answers `/health` with HTML (so the readiness
  probe passes) and `405` for `POST /session` (so every completion failed). Bumping that default means checking the
  session API still exists.
- **The CLI version probe never blocks the start.** `opencode --version` is read with the asynchronous `execFile`
  *after* the server is listening and reported as its own line (or, on failure, as the installation warning): the
  synchronous probe sat in the startup path with a 5 s timeout, so a wrapper script that waits for input delayed the
  bind by the whole timeout and the process reached Ctrl-C without its signal handlers installed - a shutdown that was
  not the graceful one. The 2.x warning it feeds is unchanged, and it now arrives while the gateway is already serving.
- **The backend command survives the shell it runs in.** `opencodeBin` is quoted whenever the spawn uses a shell
  (`C:\Program Files\...opencode.cmd` does not start unquoted, and `;`/`&` in a path would be read as operators);
  paths carrying `"`, `$` or a backtick are refused instead, because quoting cannot neutralise them. A configured
  `OPENCODE_PATH` that does not exist is warned about rather than silently replaced by whatever the PATH search finds.
- **The start attempt is claimed before the probe.** `state.isStarting` is set synchronously, before the
  `checkHealth` call that may suspend, and released in a `finally` on every path: claiming it only after that probe
  failed let two callers arriving within one probe round trip (the startup warmup racing the first request, or two
  completions) both spawn a backend, and the second spawn killed the first one's child and overwrote the tracked
  process. A caller waiting on someone else's attempt probes first and sleeps between attempts, so a request that
  arrives during a start is served as soon as the backend answers instead of waiting a full interval.
- **`killBackend()` returns a promise that settles when the child is gone** (SIGTERM, then SIGKILL after 3 s), and
  `index.js` awaits it before `process.exit(0)`; the jail directory is removed only after the child is gone, because it
  is the child's cwd. Exiting right after SIGTERM skipped the escalation, so a backend that ignores SIGTERM outlived
  the gateway that owns it. It also sets `state.shuttingDown`, which every `ensureBackend()` path checks before it
  spawns: a start attempt that was still inside its health probe (or waiting for the previous child) used to spawn
  `opencode serve` *after* the promise had resolved, so a caller that keeps running - an embedder, or an in-flight
  request during teardown - ended up with a backend nobody tracked while it held the backend port. A pending attempt is
  waited for (`waitForPendingStart()`, bounded by the largest step it can be inside and by the 5 s hard exit in
  `index.js`), and the jail bookkeeping no longer accumulates: each respawn deletes its predecessor's path from
  `ownedJailRoots` before replacing it.
- **Backend lifecycle changes** must keep these properties: `ensureBackend()` trusts a successful probe for
  `OPENCODE_PROXY_HEALTH_CACHE_MS`, connection failures clear that trust, a spawned process that exits during startup
  aborts the readiness wait, and a failed start triggers a cooldown instead of a retry storm.
- **A cached healthy answer does not fail the request it was wrong about.** `session.create` that throws a connection
  error (the backend died within `OPENCODE_PROXY_HEALTH_CACHE_MS` of the trusted probe) drops that trust, calls
  `ensureBackend()` again and retries the call once; the crash-recovery then happens for the request that hit it
  instead of only for the next one. A deadline (`isTimeoutError`) and a restart that cannot happen (cooldown, missing
  binary) are not retried, and the retry reports the original upstream failure rather than the start error it produced.
- **A replacement backend starts only after the old child is gone.** The respawn path SIGTERMs the tracked process,
  waits for `exit` (SIGKILL after 3 s) and only then removes the old jail directory and spawns: sending SIGTERM and
  spawning on the next line let the old child hold the port, so the replacement failed to bind ("exited during
  startup") and tripped the retry cooldown - one wedged backend turned its own recovery into an outage. "Exits" means
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
