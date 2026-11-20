# AGENTS.md

Instructions for AI agents and human contributors: read this before changing code. It records the invariants the
project's behaviour depends on and the checks expected before a change is done.

## What this project is

`free-opencode-api` is a single-purpose gateway: it exposes an **OpenAI-compatible** HTTP API and fulfils each request
by driving an `opencode serve` process through the OpenCode SDK. The gateway owns the backend lifecycle (probe,
spawn, health checking, teardown), creates one OpenCode session per chat completion, and translates the result back
into OpenAI shapes (JSON or SSE).

There is no database, no plugin system, no multi-provider routing layer: anything outside the
"OpenAI client → gateway → OpenCode" path is out of scope.

## Non-negotiable invariants

These are product decisions, not implementation details. Do not "improve" them without an explicit request:

1. **Authentication is always enforced.** Every route except `OPTIONS`, `/health` and `/` requires `Authorization:
   Bearer <API_KEY>`; the scheme is matched case-insensitively with any amount of whitespace, and `X-Api-Key: <key>` is
   accepted as an alias when no `Authorization` header is sent (the preflight advertises that header, and clients
   configured with an api-key header send it) — a present `Authorization` header always decides, so a wrong one is never
   rescued by the alias. Presence decides, not the parsed token: a proxy injecting `Authorization: Basic …` or a bare
   `Bearer` sends a header the gateway could not read, and testing the parsed token let the alias rescue it. A blank or
   missing `API_KEY` falls back to the built-in default `sk-dummy-123` (`resolveApiKey()` in `src/api-key.js`, re-exported
   from `src/proxy.js`). Never add a
   "disable auth" switch, never treat an empty key as "no auth". The bearer is compared in **bytes** (`timingSafeEqual`
   on two `Buffer`s of equal length): a non-ASCII key matches in string length but not in byte length, and comparing
   strings threw a `RangeError` for a wrong key. The refusal names the cause the reader can act on -
   no key sent, a wrong `Authorization` (a proxy-injected `Basic …` included) or `X-Api-Key` header - and
   never the value; `Unauthorized` alone named none of them.
2. **The default key stays visible and warned about.** `index.js` logs a `[Security]` warning when the built-in key is
   in use; the startup summary states that authentication is enforced. A **custom** key with tools enabled gets its
   own `[Security]` warning, naming where a model-directed tool can still read it (the file `config.json` was read from,
   or this process's environment) and `DISABLE_TOOLS=true` as the fix: `spawnBackend()` deletes `API_KEY` from the
   child's environment, which is hygiene rather than a boundary, because the child runs as the same uid. It never prints
   the key.
3. **OpenAI wire format is the contract.** Success and error bodies, SSE frames, status codes and header names must
   stay compatible with standard OpenAI clients. See "API contract" below. `stream` in particular is read through
   `parseBoolean()` (see "Boolean options" below).
4. **English only.** Code, comments, log messages, documentation and commit messages are written in English. The
   copyright holder remains `Phạm Văn Định` (LICENSE, `package.json`, Docker image labels).
5. **pnpm for project dependencies.** `package.json` pins `packageManager: pnpm@12.18.0`. `npm` appears only for
   installing the `opencode` CLI — the 2.x line is the separate `@opencode/cli` package (`npm install -g @opencode/cli`,
   which installs the newest release; the 1.x package was `opencode-ai`), never for this project's dependency tree.
6. **Two runtime dependencies.** `fastify` and `@opencode/client` (pinned exactly, currently `2.3.2`, which pulls
   `@opencode/schema` and `@opencode/protocol` at the same version). `@opencode/client` **replaces** the 1.x
   `@opencode-ai/sdk`: it is the same role — the generated client for the backend's own HTTP API — not a new
   dependency, so the count stays at two. Two consequences are worth recording rather than rediscovering:
   - the package describes itself in its own README as a *"Private generation target for clients derived directly from
     OpenCode's authoritative Effect `HttpApi`"*, and its build regenerates a committed surface
     (`script/generate.ts`, `bun run check:generated`). Its API can therefore move with an upstream release, so the
     version is pinned exactly and never widened to a range.
   - a version bump is a **client-compatibility** question, not a feature one: the routes, the envelope and the thrown
     error tags are what `src/proxy.js` is written against (see "API contract").
   Adding another dependency requires a clear, stated reason; the project deliberately avoids helper packages
   (routing, CORS, logging, body parsing are in-tree or built in).
7. **Dependabot stays off.** There is no `.github/dependabot.yml` and no other automated bump bot, and neither comes
   back. The file existed briefly: it was added with the 2.x migration, opened six pull requests (#155-#160: five
   workflow-action pins and the `node:26-bookworm-slim` base image), and was removed again because the automation did
   not fit this repository. Two concrete reasons, so nobody re-litigates them:
   - a two-dependency project - one dependency pinned exactly (`@opencode/client`) and one deliberately on a narrow caret
     (`fastify`, which does not have the generated-surface problem the pin exists for) - gets little from a weekly
     bump, and every bump is a client-compatibility question (invariant 6) that a bot cannot answer;
   - the one bump that mattered was wrong anyway: `node:26-bookworm-slim` fails `docker build` at
     `RUN corepack enable pnpm` (`exit code: 127`), because Corepack was removed in Node 25 - the Dockerfile has to
     change first, so "merge the green bump" was never available for it.
   Dependency updates are a **manual, reviewed change** (`build(deps): …` / `ci: …` / `docker: …`), in the same shape
   any other commit arrives in. `test/check-commit-messages.mjs` judges every commit and has **no** bot-author
   exemption: a bump bot's subject (`Bump fastify from …`, scope `dependencies`) is not this repository's convention,
   and a pull request that cannot satisfy the convention must not be mergeable in the first place.
   Do not re-add the configuration file, do not enable Dependabot in the repository settings, and do not replace it
   with Renovate or a workflow scheduled to open bump PRs.

## Repository map

| Path | Responsibility |
| --- | --- |
| `index.js` | Entry point. Loads `config.json`, merges **env > file > default**, prints the startup summary (including the resolved queue limits, via `getQueueLimits()`), calls `startProxy()` and awaits its `ready` promise (a listen failure is reported and exits there, not inside the proxy), wires `SIGINT`/`SIGTERM` shutdown. |
| `src/proxy.js` | The Fastify app: hooks (request id/logging, CORS, auth), the routes `/`, `/v1/models`, `/v1/models/:modelId`, `/v1/chat/completions`, `/health`, error/404 envelopes, the completion queue, SSE collection, polling, the backend lifecycle (`ensureBackend`, spawn, health probe against `/api/info`), and the `@opencode/client` calls every completion is built from (`session.create` / `prompt` / `message.list` / `remove`, `model.list`, `event.subscribe`). It is also the **public surface**: the entry point, the smoke suite and an embedder import `startProxy()`, `beginShutdown()`, `getQueueLimits()`, `resolveApiKey()` and the helper names from here, so a helper that moved into its own module is re-exported here rather than moved for its callers. |
| `src/text.js` | Text and value handling shared by the request path: request/completion ids (`requestId()`, `generatedRequestId()`, `newCompletionId()`), the log-safety bounders (`echoedValue()`, `loggableModelId()`, `loggableConfigValue()`, `loggableUpstreamText()`, `loggableUrl()`, `urlPath()`), `jsonTypeName()` and `timeoutMessage()`. Every bounder **bounds, then masks** and marks a cut value with an ellipsis plus a `…[truncated N chars]` counter, so two log lines never disagree about how much was dropped. |
| `src/errors.js` | The sentences an upstream throw turns into: `clientFacingText()` (masked, URL/credential-safe, cut at 512) for a 5xx body and `handlerFailureMessage()` for the route handler's own catch. |
| `src/upstream.js` | Classifying what the backend threw: `isTimeoutError()`, `isConnectionError()`, `isConnectionRefused()` (walks the `cause` chain, because `fetch` nests `ECONNREFUSED`), `errorCauseChain()`, `upstreamErrorStatus()` over `V2_ERROR_TAG_STATUS`, `upstreamFailureReason()` and the tagged `backendUnavailable()`. |
| `src/socket.js` | `closeSocketAfterFlush()`: `end()` then a 250 ms `destroy()` fallback, for the paths that answer outside Fastify's reply lifecycle (`clientErrorHandler`, `badUrlHandler`, a hijacked stream). `destroy()` alone discards buffered writes, so a client under backpressure got a reset instead of its envelope. |
| `src/api-key.js` | The built-in key `sk-dummy-123` and `resolveApiKey()` (a blank or missing `API_KEY` falls back to it). Never add a "disable auth" switch. |
| `src/backend-auth.js` | The `Authorization` header for the **backend**: `backendAuthorizationHeader()` (Basic, user `opencode`), `resolveBackendAuth()` (splits userinfo out of a credential-bearing `OPENCODE_SERVER_URL` and registers it as sensitive) and `resolveBackendPassword()` (an explicit password, or a generated one — there is no variable that switches generation off: `options.generate === false` suppresses it for a caller that needs to match a spawned child, and no production caller passes it). |
| `src/env.js` | Resolving the two configured environment values: `resolveOpencodePath()` (memoised per requested value for a minute; PATH, then the package/version-manager install locations — a candidate that exists but is not a regular file, a directory being the realistic case, is skipped rather than handed to `spawn()`, which fails with `EACCES`/`EISDIR` on every start) and `normalizeBackendUrl()` / `normalizeBindHost()` (trim, add a missing scheme, drop a trailing slash — each with a `[Config]` note naming the value that was corrected, and `normalizeBackendUrl()` also notes that a URL without an explicit port resolves to the scheme default), plus `isLoopbackHost()`, and `isUsableBindHost()` - the check `OPENCODE_BIND_HOST` gets before it becomes an
  argument of the child: the child may be started through a shell, so a value outside `[A-Za-z0-9.\-:\[\]%]` falls
  back to loopback with a `[Config]` note instead of being concatenated into a command line. |
| `src/options.js` | `parseBoolean()` and `readFlag()`, the **single** boolean parser for `index.js`, `startProxy()` and request bodies. Two implementations of that rule drifted once (`-e DISABLE_TOOLS=yes` meant "off" in the container); do not add a third. |
| `src/settings.js` | The tuning keys' readers: `readLimit()`, `readMilliseconds()`, `resolveRequestTimeoutMs()`, `isUnusableMilliseconds()`, `backendDeadline()`, and the named defaults they quote (`DEFAULT_REQUEST_TIMEOUT_MS`, `MAX_TIMER_MS`, `METADATA_TIMEOUT_CAP_MS`). The resolved values are held by their consumers in `src/proxy.js`. |
| `src/config.js` | Reads `config.json` for the entry point. A missing file is fine; one that exists and cannot be used (invalid JSON, not an object, a known key of the wrong type, not a regular file, over 1 MiB) stops the gateway, because continuing would run with the built-in key. A BOM is tolerated. |
| `src/logger.js` | Zero-dependency logger with `error`/`warn`/`info`/`debug` levels, `[gateway]` prefix, and the masking helpers (`maskHeaders()`, `maskSecret()`, `maskUrlQuery()`, `maskBackendUrl()`, `maskUrlCredentials()`, `maskQuotedCredentials()`) plus `serializeDetail()` (truncate before stringify; the `preBounded` flag skips the clone for a detail `maskDetail()` already built, which is what `logger.debugBounded()` uses) for debug logging. |
| `src/polyfills.js` | Node 20 shims, imported for its side effect first thing in `src/proxy.js`: `Promise.withResolvers()` is Node 22+, and `@opencode/client`'s SSE subscription calls it unconditionally, so without it every stream silently fell back to polling (one delta per answer). A no-op on a runtime that has the API. |
| `config.json.example` | Template for `config.json` (not committed). |
| `docker/` | `Dockerfile`, `docker-entrypoint.sh` (writes `config.json` from env), container README. |
| `test/stub-opencode.mjs` | Minimal stand-in for `opencode serve` (the `/api/*` routes the client drives: info/health, models, sessions, messages, SSE events) used by the smoke suite. |
| `test/smoke.mjs` | End-to-end contract checks: boots stub and gateway, asserts status codes, envelopes, SSE frames and clean shutdown. |
| `test/check-syntax.mjs` | Walks the repository and runs `node --check` on every `.js`/`.mjs` file, so a new file is checked without editing a list. |
| `test/check-commit-messages.mjs` | Applies the CONTRIBUTING.md rules to every commit in a range, and fails when its own type/scope lists and the document's tables disagree. |
| `.github/workflows/ci.yml` | CI: `pnpm run check`, shell check, `pnpm test` on Node 20/22/24, plus a Docker build with a container health check. |
| `.github/workflows/docker-publish.yml` | Publishes `linux/amd64` + `linux/arm64` to Docker Hub on a `v*.*.*` tag (secrets `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`). |
| `README.md` | User-facing documentation: features, configuration, API reference, client examples, performance, troubleshooting. |

Request flow (short version): `index.js` → Fastify hooks → auth → route handler → queue (`lock()`) → validate and
normalise messages → `ensureBackend()` → `client.session.create({model, permissions})` → `client.session.prompt()`
with `client.event.subscribe()` alongside it (streaming) or `client.message.list({order:'asc'})` polling
(non-streaming) → OpenAI response → `client.session.remove()` session cleanup.

## Commands

```bash
pnpm install --frozen-lockfile   # install dependencies
pnpm start                       # run the gateway (needs the opencode CLI on PATH)
pnpm run check                   # node --check every JavaScript source file
pnpm run check:commits           # commit subjects against CONTRIBUTING.md
pnpm test                        # smoke suite: stub backend + gateway (500 contract assertions on Linux; fewer on Windows, where the POSIX-only checks are skipped)
sh -n docker/docker-entrypoint.sh
```

`pnpm test` needs no OpenCode CLI and no network: it starts `test/stub-opencode.mjs` on port 4199 and the gateway on
port 8199 (override with `SMOKE_STUB_PORT` / `SMOKE_PORT`). The run prints the exact number of checks it executed, so
quote that number rather than this line. `SMOKE_SLOW=1 pnpm test` adds the checks that are slow by nature (the SSE
keep-alive line, written only after 15 s of silence); they are skipped otherwise. CI runs `pnpm run check` and
`pnpm test` on Node 20, 22
and 24, plus `test/check-commit-messages.mjs` over the added commits. No linter or formatter exists: style is a review
concern. Do not claim checks passed if they were not run.

Releases come from tags, not from a laptop: bump `version` in `package.json`, then push a `vX.Y.Z` tag.
`docker-publish.yml` refuses a tag that does not match, builds both architectures and pushes to Docker Hub.

## Verifying without the OpenCode CLI

`pnpm test` covers the HTTP contract against the stub in `test/stub-opencode.mjs` (the `/api/*` info, model, session,
message and SSE routes, plus a test-only `GET /__sessions` reporting created/deleted/live counts, `lastSystemPrompt`,
`lastPromptText`, `lastPermissionRules`, `sessionCreatePermissions` (the ruleset of **every** create, in order, so a
call that never produced a session is still counted), `messagePolls`, `toolIdCalls` and `infoCalls` (the readiness probes
that reached `GET /api/info`, so a burst of `/health` requests can be asserted not to touch the backend)). Behaviour is selected by markers in the prompt text - `SLOW`
(an answer slow enough to abort mid-stream), `STALL` (silence after two deltas), `TOOLTAG` (a tool-call block cut inside
both of its tags), `FAIL` (a provider error with no content), `ENDONLY` (a finish event carrying only `time.completed`),
`GROW` (an answer still being written when the prompt returns), `SUICIDE` (the stub SIGKILLs itself after accepting the
prompt), `PAUSE` (silence longer than the idle timeout), `LONGPAUSE` (silence past the 15 s keep-alive interval, so the stream
carries a `: keep-alive` comment line; slow by nature, see `SMOKE_SLOW`), `HOLD` (finishes after 400 ms, so a completion stays in
flight while the backend is killed or the gateway shuts down), `SLOWFINISH` (finishes after 3 s), `TAILTAG` (a last
delta ending in a tag prefix that never becomes a tag), `REJECTPROMPT` (a 400 for the prompt route),
`PROMPTDONE` and `PROMPTTOOLCALLS` (the prompt response already carries a finished message, or a finished
`finish: "tool-calls"` step) - both **accepted no-ops** against a 2.x backend, whose prompt answers with the user inbox
item only: the 1.x shapes are still recognised, so the markers keep their meaning if a release or a translating proxy
starts answering that way again - `CUTSTREAM` (two cumulative snapshots then
a dropped event connection), `LAGSTORE` (the stream delivers the whole answer while the stored message keeps only its
first characters, then the stream is cut), `MULTIPART` (one message whose two text parts send their own cumulative snapshots,
interleaved), `MULTIPARTNOID` (the same without part ids, so both parts are of type `text`), `SHRINK` (a part whose snapshot gets shorter, because the backend rewrote it, which must not be re-sent after
the deltas that already delivered it), `MIXED` (part updates
carrying both a `delta` and the part's cumulative text, then one closing update with neither),
`CUTTOOL`/`OPENTOOL` (a tool-call answer whose stream is cut inside the closing/opening tag), `TOOLSPAM` (a tool-call
block repeated by the answer), `TWOSTEP` (the answer arrives as two steps, the first unfinished), `FAILMID` (a provider
error after the text has already been written, so both modes have text to keep), `STRAYTAG` (a closing
`</function_calls>` with no block around it, dropped while its surrounding text is kept), `OPENTAIL` (an opening tag
that never closes, dropped while the text after it is kept - the two shapes the streaming filter and the whole-answer
scan must agree on), `BADPART` (a text part whose `text` is a number, next to a normal part), `REASONONLY`
(a message carrying reasoning and no text that is never marked finished), `LEAKYFAIL` (a provider error quoting a
credential-bearing URL behind a long message) and `MANYDELTAS` (a 470-character answer split into ~180 deltas, for the
idle timer that is re-armed on every one) - and by the variables `STUB_FAIL_SESSION=1` (a 404 for
`POST /api/session`), `STUB_BASIC_AUTH=user:pass` (a `401` gate on every route), `STUB_URL_IN_ERROR=1` (a 400 whose message quotes a
credential-bearing URL), `STUB_ECHO_AUTH=1` (a 401 quoting the header it refused), `STUB_FAIL_MESSAGES=<n>`, `STUB_UNREADABLE_MESSAGES=1` (a 2xx whose body is not a message
list), `STUB_DROP_MESSAGES=<n>`, `STUB_ALWAYS_FAIL_MESSAGES=1`, `STUB_HANG_CREATE_AFTER=<n>` (every creation after the n-th goes
unanswered), `STUB_RESET_CREATE_TIMES=<n>` (the first n creations have their socket destroyed before a session is
made, which is the `ECONNRESET`/`socket hang up` half of the retry rule and is asserted as *not* retried),
`STUB_CREATE_DELAY_MS=<n>` (a
slow `POST /api/session`, so a completion that waited for a queue slot can be granted a fresh request budget),
`STUB_DROP_CREATE=1` (the session is created and the connection dropped before the answer),
`STUB_REJECT_DELETES=1` (a `500` for `DELETE /session/:id`, so the session stays), `STUB_HANG_DELETES=1` (a delete that is
never answered), `STUB_FAIL_TOOL_IDS=1` (a `500` for the 1.x `GET /experimental/tool/ids`; **accepted as a no-op**, because 2.x has
no tool-list route and the gateway builds no override map), `STUB_ODD_MODEL_NAMES=1` (three provider entries whose
`name` is a number, an object and an empty string, so a warm cache can be asserted to answer byte-identically to a
cold one), `STUB_EMPTY_PROVIDERS=1` (both shapes of an
unreadable provider payload), `STUB_FAIL_EVENTS=1`, `STUB_FAIL_PROVIDERS=1` and `STUB_BIG_ERROR_BODY=1` (a 1 MB error
body, for the summary bound). Extend it and `test/smoke.mjs` when you add behaviour worth protecting. Session-cleanup
assertions go through `sessionsAfterCleanup()`: the gateway answers the client *before* deleting the session (its own
backend round trip), so one read of `/__sessions` raced it and failed with `live: 1`; wait for `live: 0`.

**An error status the stub can use is a status the generated client declares.** `@opencode/client` throws a typed error
only for the statuses its routes declare (`POST /api/session` and `.../prompt`: `400`, `401`, `404`) and keeps the
backend's sentence as the message. Any other status (`405`, `500`, `502`) arrives as a bare `ClientError`
(`UnexpectedStatus: <code>`) that keeps `cause.status` and **discards the body** - and for `session.create` it keeps
nothing else at all. So a marker whose point is a *reason* (`STUB_URL_IN_ERROR`, `STUB_BIG_ERROR_BODY`,
`STUB_FAIL_SESSION`, the `REJECTPROMPT` prompt) answers `400`/`404`, and the checks assert the upstream status that
marker sends rather than the one that would have been realistic on a 1.x server. A marker whose point is only the
status (`STUB_REJECT_PERMISSIONS`'s sibling checks, the delete failures) may keep any status.

For exploratory work, start a throwaway stub on a spare port (`STUB_PORT=4405 node test/stub-opencode.mjs`) and point the
gateway at it:

```bash
OPENCODE_SERVER_URL=http://127.0.0.1:4096 PORT=8080 LOG_LEVEL=debug node index.js
curl -s http://127.0.0.1:8080/health
curl -s -H 'Authorization: Bearer sk-dummy-123' -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":true}' \
  http://127.0.0.1:8080/v1/chat/completions
```

One-off stub scripts stay in `/tmp`; anything worth keeping goes into `test/stub-opencode.mjs`.

## API contract (must not drift)

- `GET /` → `200 {"service":"free-opencode-api","status":"ok","endpoints":{"health":"/health","models":"/v1/models","chat_completions":"/v1/chat/completions"}}`
  without a key: the auth hook leaves it open, so it must answer instead of falling through to the 404 handler.
- `GET /health` → `200 {"status":"ok","backend":"<OPENCODE_SERVER_URL>"}` with any credentials in it masked
  (`maskBackendUrl()`: `http://***@host:4097`, `?token=***`), never touches the backend. It is open
  without a key in every form a probe uses it — HEAD, and a trailing slash (`ignoreTrailingSlash` routes `/health/`
  to the same handler, so the open-route test must match it too, or a liveness probe answers 401).
- `GET /v1/models` → `200 {"object":"list","data":[{id,name,object,owned_by}, …]}`; 5 s cache, and a cold-cache burst
  shares one provider round trip (`modelsInFlight`) instead of one per request; failures — including a provider call
  that runs into its deadline, because a silent backend would never answer the listing — fall back to
  a single static model and are not cached, but a served fallback is held for 1 s (`FALLBACK_HOLD_MS`) so a failing
  provider is not asked once per listing. An **expired** entry is not a miss: the listing and the by-id answers are
  served from the cache for up to `MODELS_STALE_MS` (60 s) while the refresh runs in the background behind
  `modelsInFlight`, rate-limited to one attempt per `MODELS_CACHE_TTL_MS` so a failing provider is not asked once per
  request — awaiting the refresh put a full provider round trip in front of the 1-in-N request that crossed the TTL
  (measured 5.0–5.3 ms against 0.6 ms warm on a loopback stub, and one network RTT against a real backend). Past that
  bound the cache is a miss again, so a backend that stopped answering is still noticed. A warm cache answers with the
  body built when it was filled
  (`modelsCacheBody`; by-id answers read `modelsById`). That model is `opencode/big-pickle` (`DEFAULT_MODEL` in `src/proxy.js`), also the model a chat request
  without `model` is sent to (one constant, so the two cannot name different ids). `big-pickle` is an **alias**: OpenCode
  routes it to whichever model it serves and never publishes which, so it is the only id worth hardcoding and its entry
  carries just the four OpenAI fields - do not add capabilities, limits or pricing describing a model the gateway
  cannot see.
  An empty model list takes the same fallback: an unreadable payload (a changed shape, a version reporting nothing)
  answers `200 {"providers":[]}`, and an empty `data` array out of `client.model.list()` is as useless as an error.
  A non-empty list that yields no usable entry does too: the empty check runs after the extraction.
- `GET /v1/models/:modelId` and `GET /v1/models/<id with slashes>` → `200 {id,name,object,owned_by}` from the same
  cache; an id the provider list does not contain is described from the id itself (`provider` = text before `/`,
  default `opencode`) rather than 404, because `/v1/chat/completions` does not restrict the model either — the one
  exception is `opencode/big-pickle`, answered from `DEFAULT_MODEL` so it keeps its `Big Pickle` name instead of the
  id-derived `big-pickle`. The wildcard route exists because clients send `opencode/big-pickle` unencoded as often as
  `%2F`-escaped. The id-derived `name` is the text after the **first** `/` (`/v1/models/%2Fbig-pickle` answers
  `name: "big-pickle"`, `owned_by: "opencode"`): treating the separator at index 0 as "no separator" put the `/` in the
  name of a non-model that `/v1/chat/completions` refuses with a `400`. A **blank** id (`/v1/models//`, `/v1/models/%20`) is a `404` in the usual `not_found` envelope, not a
  `200` whose body is `{"id":"","name":""}`: a doubled slash reads as a trailing slash. An id whose **last segment** is empty (`/v1/models/%2F`, `/v1/models/opencode%2F`)
  is the same class of non-model and answers `404` too; `/v1/models/` itself still answers the listing.
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
  A `: keep-alive` comment line (ignored by OpenAI clients) is written whenever the stream has been silent for 15 s:
  a long think must not let an idle proxy drop the connection.
  `stream_options.include_usage` adds one more chunk with `choices: []` and a zeroed `usage` block, after the finish
  chunk and before `[DONE]`: the OpenAI SDK reads the stream's usage from exactly that frame, and ignoring the option
  left it with no numbers. It is emitted only when the client asks for it — a stream that did not request it
  must not grow an extra frame.
- **`system` and `developer` messages are the system prompt.** Both roles are joined with blank lines and prepended to
  the prompt's `text` (2.x has no `system` field — the whole prompt is one text string) and never appear as
  conversation parts; every other role is labelled
  (`USER: …`, `ASSISTANT: …`) and sent as text. `developer` is OpenAI's newer name for the system role, so a client
  using it must not end up with "DEVELOPER: …" inside the conversation. The stub reports the last system prompt it
  received (`GET /__sessions` → `lastSystemPrompt`) so the suite can assert it.
- **A body that is not a JSON object is named as one.** Whether a string body still needs parsing is decided by the
  **content type**, not by the value: `"hi"` under `application/json` decoded to a string, and reading it as unparsed
  text answered "not valid JSON" about a body that parses perfectly, while `42`, `true`, `[]`, `null` were answered `messages
  array is required` about a field never sent. All are `request body must be a JSON object, found …`; no body at all
  keeps `messages array is required`, and an **empty** body (a retry that lost its payload) names the fix (`request body is empty; send a JSON object with a messages array`, code kept) whatever the content type,
  not Fastify's sentence about a header the client set correctly.
- **A missing `messages` is not an unusable one.** Three client mistakes used to share a single message: a body with
  no `messages`, a `messages` that is not an array (`"hi"`, `{}`) and an empty array (`[]`) all answered
  `messages array is required`, which sends the reader looking for a field they did send. They are separated now:
  `messages array is required` (absent or `null`), `messages must be an array of message objects, found a string`
  (`jsonTypeName()`, so the message names what arrived — `Array.isArray` first, because `typeof []` is `'object'`) and
  `messages must contain at least one message`. An **entry** that is not an object (`"hi"`, `42`, `null`, `[]`) is
  the same class: `m?.role`/`m?.content` read it as an empty user message, so the client was told
  `messages must include at least one non-system text message` about text it never sent; every entry is now named by
  position and type (`messages[0] must be a message object, found a string`).
- **A request is bounded by its element counts, not only by its bytes.** `MAX_BODY_MB` bounds the body, but a 20 MiB
  body of empty message objects is still 20 000 messages, and one message may carry 20 000 content parts: both were
  normalised, prompt-built and stored per completion (measured 75 MB → 312 MB RSS for a 20 MiB body, about 12x, which
  made the documented queue bound - `MAX_BODY_MB` x concurrency - off by the same factor). `messages` over
  `MAX_MESSAGES_PER_REQUEST` (10 000) and a `content` array over `MAX_CONTENT_PARTS_PER_MESSAGE` (10 000) are a `400`
  naming the limit and what arrived; the answer buffers (`appendCapped()`) stop at `MAX_ANSWER_CHARS` (16 M chars) with
  a prefix-safe append, because every snapshot comparison is a `startsWith()` on that text and truncating it must not
  make a later delta look like a rewrite.
- A `messages[].role` that is present but not a string (`5`, `{}`, `[]`, `true`) is a `400`
  (`messages[0].role must be a string`): `(role || 'user').toLowerCase()` threw on a truthy non-string, so a client's
  bad field was answered `500` with the internal expression. A missing or `null` role keeps its lenient
  `user` default.
- **Content parts must be text.** A `content` array may carry strings and parts with a `text` field (`text`, and the
  Responses-API spelling `input_text`). Any other part (`image_url`, `input_audio`, `file`) is refused with a `400`
  naming its position and type (`messages[0].content[1] uses an unsupported content part type "image_url"; this gateway
  forwards text only`): dropping them answered a question the backend never received. Three causes, three messages,
  part check first: an unsupported type (above), a `text` part whose `text` is not a string
  (`messages[0].content[1].text must be a string, found a number`) and a part that is not a part at all (`… must be a
  string or an object with a text field, found a number`, for `42`, `null`, `true`). Two shapes name themselves: a
  text part whose `text` is **missing** (`{"type":"text"}`) is `…text is required for a text part`, and an object with
  no usable `type` (`{}`, `{"type":5}`) takes the shape sentence with `found an object without a text field` - both
  used to quote `unsupported content part type "text"`/`"unknown"`, a type the client never sent. A
  `content` that is a **single object instead of an array** follows the same three rules without a part index; it used
  to be read as an empty message, so a request that also carried text was answered from that text alone. A bare
  scalar `content` (`42`, `true`) is refused the same way, without a part index: stringifying it sent the model the
  number as the question.
- **A message `name` is a label, not prompt text.** It is interpolated as `USER(name): …` only when it is a string,
  with control characters replaced and the value cut: a non-string reached the model as `USER([object Object]): …`.
- **An announced request body has a deadline.** Fastify sets `requestTimeout: 0`, so nothing bounded the wait: a client
  that sent `Content-Length: 4096` and four bytes held the socket as long as it liked without a credential, because
  the `401` is written from the headers while Node keeps the connection alive to drain a body it will never read. `armBodyDeadline()` in the `onRequest` hook (armed before auth, only when
  the request announces a body, cleared on `end`/`close`/`error`) closes it after `min(30 s, REQUEST_TIMEOUT_MS)` of
  **no progress**, answering the `408` envelope when nothing has been sent, in the gateway's voice and with the deadline
  in force (`request body was not received within …ms; send the declared body or close the connection`). The window
  re-arms while the socket is reading more bytes (`req.socket.bytesRead` moved since the last arming) and the upload is
  given a total budget of that window plus `REQUEST_TIMEOUT_MS`: a deadline that never renewed cut off a slow client
  mid-body and told it to send the body it was sending, while the stall it exists for is a body that *stops*. When the
  budget runs out on an upload that was still progressing, the message says so instead of blaming a stall. It closes the
  **request's** socket, not `reply.raw`: a keep-alive response is detached from the connection once it ends, so destroying it
  closed nothing.
- A `model` id whose provider or model half is empty (`"opencode/"`, `"/big-pickle"`) is a `400` in the
  `invalid_request_error` envelope naming the value: sending them to the backend only produced an opaque upstream
error. An absent or blank `model` means `DEFAULT_MODEL`.
- A completion body sent under a non-JSON content type (`curl -d '{…}'` without the header, `text/plain`) reaches the
  handler as an unparsed string; it is parsed there and served. Answering "messages array is required" blamed a body
  valid for a missing header. A string that is not JSON answers `400` naming the content type.
  `curl -d` labels the body `application/x-www-form-urlencoded` (not `text/plain`), so that type is handed
  over as the same string by an explicit `addContentTypeParser` — Fastify answered it with a bare `415`, so the
  documented header-free path did not work for the most common hand-written client. Other content types keep the `415`
  media-type error (below). A
  body sent with a `Content-Encoding` other than `identity` is a `415` naming the header: the gateway does not
  decompress, so the compressed bytes reached the JSON parser and were reported as "body is not valid JSON", which
  blames the one part of the request that was correct. A UTF-8 BOM in front of that text (PowerShell 5.1, Windows
  editors) is stripped before the parse: `JSON.parse` refused it, so a good body was told it was not JSON.
- A `415` names what it refused and what to send. `FST_ERR_CTP_INVALID_MEDIA_TYPE` used to arrive as Fastify's bare
  `Unsupported Media Type` for any type the gateway does not parse, including a **body with no `Content-Type` header**.
  The status and the code stay; the message becomes `unsupported content type "application/xml"; send
  Content-Type: application/json`, or `the request has a body but no Content-Type header; send Content-Type:
  application/json` when the header is missing (the value is client input echoed into a response body, so
  `echoedValue()` replaces control characters and cuts it at 64). Recognised types are unchanged:
  `application/json`, `application/x-www-form-urlencoded` and `text/plain` (handed to the handler as text).
- A body carrying a **forbidden property name** (`__proto__`, `constructor`) is refused by Fastify's
  prototype-poisoning guard before any handler runs, and that refusal arrives as the same
  `FST_ERR_CTP_INVALID_JSON_BODY` a syntax error produces: the client was told `Body is not valid JSON but
  content-type is set to 'application/json'` about a body that parses perfectly, sending the reader after a
  missing comma. The envelope keeps Fastify's `code` and names both causes (`request body is not valid JSON, or it
  carries a forbidden property name (__proto__, constructor); send Content-Type: application/json`). The refusal stays:
  an OpenAI client does not send those names, and `onProtoPoisoning: 'remove'` would silently drop a field it did send.
  The guard is unconditional, so the **text path** applies it too: a `text/plain` or
  `application/x-www-form-urlencoded` body is parsed by the handler with its own `JSON.parse`, and the same bytes were
  refused under `application/json` and served under `text/plain` (measured). The parse uses a reviver that stops at the
  first forbidden key at any depth (`FORBIDDEN_BODY_KEYS`), the escaped spelling (`"\u005f\u005fproto__"`) included,
  and answers the same `code` and sentence as Fastify's own refusal (`FORBIDDEN_BODY_MESSAGE`, one copy for both
  paths): the content type must not decide whether a client's body is safe.
- Errors → `{"error":{"message":"…","type":"…"}}` with `400` (bad request, `type: "invalid_request_error"`, plus
  Fastify's `code` when it rejected the body), `401` (auth, `type: "invalid_request_error"`,
  `code: "invalid_api_key"`), `404` (unknown route, `type: "not_found"`), `502` (upstream/provider error, with a
  `code`: `ProviderError` when the provider failed, `backend_unreachable` when the backend could not be reached or
  started, and `upstream_error` as the fallback for a 502 that is neither — a shape no current path produces, kept so a
  future one cannot answer a 502 with no `code` at all), `503`
  (`type: "queue_full"`, the wait queue is full, with `Retry-After: 1` so an OpenAI SDK backs off instead of failing
  the request) or `type: "server_error"` with `code: "gateway_shutting_down"` (also with `Retry-After: 1`, when
  `SIGINT`/`SIGTERM` arrived and the request is not one of the responses being finished), `504` (timeout), `500`
  (anything else). A backend the gateway cannot start (a missing CLI, a 1.x release, a taken port, a start cooldown, or
  an `OPENCODE_SERVER_URL` naming **no port** - the child can only listen on a numbered one, so the gateway probed the
  URL as written, port 80/443, while the child held 4097: every completion answered 502 after the whole startup budget
  and the child was left behind. It is refused before the spawn, with a sentence naming the port) is
  the same `502 backend_unreachable` as a backend that died mid-request: the tagged `backendUnavailable()` error is
  what tells the two paths apart, and the message names the start failure. Every error body carries a
  `type`; `500`, `502` and `504` use `type: "server_error"` and never an internal exception class name, and its message is
  masked and bounded (`clientFacingText()`): a 5xx sentence comes from whatever threw, and a thrown `fetch`/SDK error can
  quote its URL. The route handler's own catch writes its `500` body itself, so it reads the sentence through
  `handlerFailureMessage()` - masked, and built *before* the log line that prints it, because a `const` read ahead of
  its declaration is a `ReferenceError` that replaces the cause of the `500` with a bug in the catch itself. The inner
  catch around a failed upstream call reads its `[Proxy] API Error` sentence from the same helper, for the same reason:
  `error.message` is `undefined` for a throw that is not an `Error`, so the line logged nothing and the client was told
  `undefined`.
  A log record prints the sentence *and* the stack behind that error, whose first line is the message: both go
  through `loggableError()` - masked, stack bounded (`MAX_LOGGED_STACK_CHARS`).
  A backend that disappears mid-request is an upstream failure (`502`), not a bug (`500`): the client is told the upstream is gone and the next request
  restarts it.
- A backend that rejects `POST /api/session` (a version whose API moved, a proxy in front of it, an error body) is an
  upstream failure too: `502` with the upstream status and reason in the message
  (`OpenCode backend rejected session creation (status 404): …`), not a bare `500`
  that blames the gateway and explains nothing. The 2.x client **throws** instead of resolving a tuple, so the status
  comes from `upstreamErrorStatus()` and the reason from the thrown message; the body extraction still handles
  `{error:{message}}`, `{message}` and a plain string, and never prints `[object Object]`. The session id is read from
  the envelope (`sessionRes.data.id`) — a call that resolves without one is a failure, because a session whose id
  nobody can see can never be deleted. A `404`/`405` on that call also logs a warning naming the likeliest cause — a
  **1.x** `opencode` CLI, whose `serve` has no `/api/*` route at all, so the readiness probe (`GET /api/info`, which
  requires JSON) never passed for one in the first place. The README's Requirements table states the supported major
  version for the same reason.
- A **rejected prompt** is an upstream failure in both modes: the 2.x client **throws** on a non-2xx
  `POST /api/session/{id}/prompt`, so the rejection reaches the handler's own catch, and `throwIfPromptRejected()`
  still inspects a resolved `{ error, response }` (a translating proxy, a future client) and answers `502` with the
  upstream status and reason (`OpenCode backend rejected the prompt (status 500): …`). Ignoring it made a rejected
  prompt look like a slow answer - no assistant message was created, so the gateway polled until its budget ran out and reported `504`. A streaming request keeps streaming only when deltas already reached the client.
- **A 2.x prompt does not return the answer.** `POST /api/session/{id}/prompt` answers with the *user inbox item* it
  just enqueued, so `completedPromptMessage()` returns `null` for every 2.x answer and the answer is read from the
  event stream (streaming) or by polling `GET /api/session/{id}/message?order=asc` (non-streaming; the list is newest
  first otherwise, and `cursor` cannot be combined with `order`). The 1.x shape — a finished message inside the prompt
  response, with `info`/`parts` nested — is still recognised on purpose, so a translating proxy or a release that
  starts answering that way again keeps the round trip it saves. A message that is still being written has no `finish`
  and keeps the poll loop either way, so a partial answer is never served.
- **Only a refused connection is retried.** `session.create` is retried once, after dropping the cached health and
  restarting the backend - but only when the connection was *refused* (`isConnectionRefused()`: `ECONNREFUSED`, also
  through the `AggregateError` Node's `fetch` builds per address), because that proves the request never reached the
  backend. `fetch failed` and `socket hang up` are what a backend that accepted `POST /api/session` and then died looks
  like: retrying those created a second session while the first one kept existing with no id in this process, so
  neither `cleanupSession()` nor the shutdown drain could ever delete it. Those answer `502 backend_unreachable`, the
  documented answer for "the backend disappeared mid-request", and the next request recovers. Both call sites send
  **one** argument object (`sessionCreateArgs`): the retry repeated the literal by hand and dropped `permissions`, which
  no answer the client receives can show, so a duplicated literal is what must not come back.
- **Every 2.x client call throws on failure**, and every call site handles the rejection: `session.create`,
  `session.prompt`, `message.list`, `session.remove`, `model.list` and `event.subscribe`. A thrown error carries a
  `_tag` (`SessionNotFoundError`, `UnauthorizedError`, `InvalidRequestError`, `ConflictError`, …) but **no HTTP
  status**, so `upstreamErrorStatus()` maps the tags in `V2_ERROR_TAG_STATUS` back onto the status the server sent
  (`SessionNotFoundError`/`NotFoundError` 404, `SessionArchivedError` 410, `UnauthorizedError` 401,
  `InvalidRequestError` 400, `ConflictError` 409, `ServiceUnavailableError` 503). `NotFoundError` is the tag a
  **404 on `POST /api/session`** carries; the older `LocationNotFoundError` in the same map is a different route's
  error, so without `NotFoundError` the "this looks like a 1.x CLI" case answered a bare `500` and never reached the
  warning that names the fix. A refused connection surfaces as
  `ClientError("Transport: fetch failed")` wrapping Node's `fetch` error, so the `ECONNREFUSED` code sits two `cause`
  levels down and `isConnectionRefused()` walks the `cause` chain to find it. A refused `event.subscribe` carries no
  stream, so the streaming path falls back to polling and still answers.
  Reading a rejection as "the backend returned nothing" turns a refusal into a missing answer: a swallowed
  `session.prompt` rejection made a rejected prompt look like a slow answer and polled out the whole budget. The 2.x
  API has **no tool-list route**, so the 1.x tool-ids cache (`warmToolOverrides()`, `TOOL_IDS_CACHE_MS`,
  `TOOL_IDS_FAILURE_TTL_MS`) and its per-tool override map are gone with the route they were built from.
- A provider failure is an upstream error in both modes. Non-streaming answers `502`; a streaming request whose
  provider failed before the first frame answers the same `502` envelope (the stream never started), and one that
  fails after frames are on the wire ends with the in-band error frame. It must never be streamed as assistant text:
  `data: {… delta: {content: "[Proxy Error] …"}}` with `finish_reason: "stop"` is a successful answer to every client.
  The failure can arrive **on the event that finishes the message** (`error` next to `time.completed`), after text was
  already written: `collectFromEvents` carries it out and both modes fail (the in-band frame with the text so far, or
  the `502`), where dropping it served the truncated text as `finish_reason: "stop"`. Both modes describe it through
  `describeProviderFailure()` (masked and bounded, like every other upstream sentence), so they cannot disagree. The
  sentence is the provider's own text and nothing else: the thrown error's `name` used to be prefixed on the
  streaming side only, so one failed completion read `ProviderError: Provider Error: …` as a stream and
`Provider Error: …` as JSON, and that prefix is a name the wire chose - a place backend-controlled text could enter
  a public message. `PROVIDER_FAILURE_FALLBACK` is the sentence when the throw carries none.
- A client that disconnects mid-stream releases its queue slot immediately: the event subscription is aborted and
  the polling fallbacks are skipped (the backend keeps finishing on its own). A reader that stops reading without
  closing the connection (a tab that stops consuming, a buffering proxy, a stalled phone link) is treated the same
  way: a write that does not drain within `SSE_CLIENT_WRITE_TIMEOUT_MS` (30 s) marks the client gone, aborts the
  collector and destroys the socket - an unbounded `drain` wait parked the task, and with it the only completion slot,
  while `/health` kept answering 200. The gone flag is set even when someone else
  already ended the response (the in-band timeout path): the socket is still open then, and the short-circuit left the
  task writing into an ended stream. A **non-streaming** client that disconnects is handled the same way: the closed
  socket stops the poll loop, so the slot is free at the next tick.
- An error after the first SSE frame is delivered in-band (`data: {"error":…}` then `data: [DONE]`) and closes the
  stream. A hijacked response must always be terminated: writing a JSON body into a frame stream (or leaving the
  socket open) breaks or hangs the client.
- Every completion deletes the OpenCode session it created — on the success path, the error path and after a client
  abort. The backend must never accumulate one session per served request; `test/stub-opencode.mjs` exposes
  `GET /__sessions` so the smoke suite can assert `live === 0`. A completion that the **shutdown** interrupts never
  reaches that cleanup, so every created session id is also tracked in the module-level `liveSessions` set (removed in
  `cleanupSession()`'s `finally`) and `killBackend()` drains what is left before the child is stopped
  (`SHUTDOWN_SESSION_TIMEOUT_MS`, 3 s, best effort): with an external backend those orphans outlive the gateway, one
  per restart. The drain **loops** while the set is non-empty inside that budget (one snapshot missed a creation that
  answered after it was read: `/__sessions` reported `{"live":1,"created":1,"deleted":0}`), and a completion that has
  not created its session yet when shutdown began answers `503 gateway_shutting_down` instead of adding one the teardown
  has already counted. A request still **waiting for a slot** is answered the same way by `beginShutdown()`, which drains
  the queue: `server.close()` would have waited for a request that can no longer be served, and `closeAllConnections()`
  answered it with a reset 1.5 s later (measured 1 507 ms after the signal) - a `fetch failed` a client cannot tell from a
  crash. Each delete result is inspected the way `cleanupSession()` inspects it: a refused delete arrives
  as an `{ error, response }` tuple, and counting that as a deletion dropped the id and logged a success for a session
  that stayed on the backend. A round that deletes nothing ends the loop (a refusing backend cannot be retried into
  success inside 3 s) and one `warn` names the sessions that are left (`remaining`). `cleanupSession()` classifies a
  delete that answers 404/410 as already gone (debug, no warning) and any other failure as transient: the id stays in
  `liveSessions` so the shutdown drain retries it, and the warning is rate-limited to one per minute
  (`noteCleanupFailure()`), because a backend that refuses every delete used to log one line per request.
- Every response carries `X-Content-Type-Options: nosniff` (`NO_SNIFF`, `createApp()`) on the same three paths as the
  CORS set (`onRequest` hijacked streams included, `clientErrorHandler`, `badUrlHandler`): it writes only JSON
  and SSE, which a browser must not re-read as something else.
- CORS headers are set on the raw response for every request, including hijacked streams:
  `Access-Control-Allow-Origin: *`, `Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: Content-Type,
  Authorization, X-Api-Key, X-Request-Id, X-Requested-With`, `Max-Age: 600`, `Expose-Headers: X-Request-Id`. The
  allow-list lives in one constant (`CORS_ALLOW_HEADERS` in `createApp()`) because three paths write it — the
  `onRequest` hook, `clientErrorHandler` and `badUrlHandler`. It carries `X-Request-Id` because the gateway echoes
  that header, and a browser client setting its own trace id had it refused by its own preflight.
- A request the HTTP parser rejects (a malformed request line or header, an oversized header block, a header
  timeout, or an HTTP/1.1 request line with **no `Host` header** - `serverFactory` passes `requireHostHeader: false`,
  because Node's bare check answered `400 Bad Request` in its own HTML before any hook ran, with no `type`, no CORS,
  no `X-Request-Id` and no log line) never reaches a hook, so the `clientErrorHandler` Fastify option answers it: `400` for a parse error,
  `431` for `HPE_HEADER_OVERFLOW`, `408` for `ERR_HTTP_REQUEST_TIMEOUT`, all in the OpenAI envelope
  (`type: "invalid_request_error"`, the parser's code in `code` when it is a plain `[A-Z_]+` token) with CORS headers,
  an `X-Request-Id` and a `warn` log line that **carries that same id** (`[gw-…]`): the id a client quotes in a report
  has to be searchable in the log. It writes the envelope,
  then closes with `socket.end()` (`closeSocketAfterFlush()`), never `socket.destroy()`: `destroy()` discards buffered
  writes, so under backpressure the client got a reset instead of its error.
- A URL the **router** cannot decode (a percent escape that is not valid UTF-8, `GET /v1/models/%E0%A4%A`) never reaches
  a hook, so Fastify answered its own body (no `type`, CORS, `X-Request-Id` or log line). `routerOptions.onBadUrl` (`badUrlHandler`) writes the usual envelope, with the client's own `X-Request-Id` when it sent a usable one (a
  generated `gw-…` otherwise - this path answers before the hook that normally echoes it) and one `warn` line carrying
  that id and the path truncated by `loggableUrl`. It is handed the raw request/response
  (`find-my-way` builds no Fastify request), like `clientErrorHandler`; both take the id from the module-level
  `requestId()` / `generatedRequestId()` helpers, which is also what puts it in their log lines.
- Every response carries `X-Request-Id`, the same id the request log line ends with, so a client report can be traced
  to a log entry. An incoming `X-Request-Id` is echoed when it is a short printable token
  (`[A-Za-z0-9._:-]{1,64}`) and replaced by a generated `gw-…` id otherwise — the value reaches the log line and a
  header, so a value carrying spaces, newlines or control characters must never be copied through.
- **A configured backend URL is masked wherever it is printed.** `OPENCODE_SERVER_URL` can carry a credential
  (`http://user:secret@host:4097` for a proxy in front of the backend); it reached the startup summary, the `[Config]`
  notes, the container's first-boot config dump and `/health` verbatim — and `/health` needs no key, so that published
  the secret to every caller and to `docker logs`. `maskBackendUrl()` in `src/logger.js` masks
  the userinfo and any credential query value and leaves scheme/host/path readable, which is what they are read for. The entrypoint **imports** the helper for its own first-boot dump and log line (`node --input-type=module -e … /app/src/logger.js`), so the container cannot drift from the module - its earlier hand-written copy matched neither `#`-separated pairs nor the length rule - and masks everything as `***` if that import fails; the stored `config.json` keeps the real value.
  The same applies to **text**: `resolveBackendAuth()` (`src/backend-auth.js`) splits the userinfo out of the value the SDK is
  given and `maskUrlCredentials()` masks a `scheme://user:pass@` inside any sentence. Its scheme run is bounded
  (`\w[\w+.-]{0,31}`): an unbounded one rescanned every position of a whitespace-free token containing `://` and no
  `@`, which is O(n²) — 8 ms at 2 000 characters, 1.85 s at 32 000 — on the serving thread, reachable through a debug
  dump or an upstream sentence. A quoted credential is masked **by value** as well when it is the gateway's own backend
  credential: `maskQuotedCredentials()` needs 16 characters to tell a token from prose, and `base64("u:pw")` is 8. Both exist because the documented
  shape could not work - Node's `fetch` refuses a URL with credentials, so every completion answered `502`. The
  userinfo now travels as a Basic `Authorization` header (and on `checkHealth()`, which read its `401` as "backend missing"), and every upstream reason that reaches a client or a log line
  goes through `clientFacingText()` (URLs and a quoted `Authorization` value masked, cut at 512 characters): a backend or a proxy
  can quote a URL, or echo the Basic header it refused (`maskQuotedCredentials()`), in its own error payload.
- Request log format: `METHOD url -> status Xms [reqId] model=… stream=…` (info for `/v1/*`, debug otherwise).
  The `model` value and the URL are client-controlled, so both are normalised before they are logged
  (`loggableModelId()`: control characters replaced, 128 characters max; a URL goes through `maskUrlQuery()` *and*
  `maskUrlCredentials()`, so a `user:pass@` in a request target is masked the way `maskBackendUrl()` masks it, and one
  over 512 characters is cut with a `…[truncated N chars]` marker): one log line is one record, and a newline in a model id used to start a second,
  attacker-written line while a 2 MB id produced a 2 MB line. The backend still receives the id
  verbatim - the contract does not restrict model ids, only what is logged is normalised, and an **operator** value
  quoted in a startup line goes through `loggableConfigValue()` for the same reason: `config.json` and the environment
  are text a script can write. It covers every `[Config]` note naming a value it could not use, the ignored-file
  paths and the `[Security]` warning that names the bind address; `docker/docker-entrypoint.sh` repeats the rule for
  its log-level line (`tr '[:cntrl:]' '?'`, cut at 128), because the shell writes that line before Node starts.
  An **OS sentence** is the other shape of the same problem: `spawn()` repeats the command back inside its error
  message, so `[Proxy] Failed to spawn OpenCode: ${err.message}` quoted `OPENCODE_PATH` verbatim and a newline in it
  started a second record. `loggableUpstreamText()` bounds the text first (`MAX_LOGGED_UPSTREAM_LENGTH`, 256) and then
  replaces control characters, so the path stays readable on one line. Single quotes in that sentence are not a problem
  either way: a detail object escapes its newlines through `JSON.stringify`, so only a *message* needs this.
  A **query name** is decoded by `maskUrlQuery()` before it is matched, because `?%61pi_key=` is the same credential:
  the decoder is `decodeQueryName()`, a form-decode of `%XX` runs only (no `decodeURIComponent`), so a malformed escape
  (`?%zz=1`) is compared as written instead of throwing one `URIError` - and a captured stack - per pair (1 600
  malformed pairs measured 1.8 ms of the serving thread per request, on a line built before the auth check). The
  decision is unchanged: 300 000 random names answered the same with both decoders.
  A debug detail that already came from `maskDetail()` is passed as `logger.debugBounded(message, detail)`
  (`serializeDetail(value, true)`): the copy is bounded and acyclic by construction, so the second tree walk
  `safeClone()` performs is skipped (36 ms of a 91 ms line for a body with about a million nodes). The text is
  byte-identical, and a value that still defeats `JSON.stringify` falls back to the cloned path.

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
  `docker/docker-entrypoint.sh` reports the key it generated as `sk-a***(22 chars)` — nothing but the length up to 16
  characters — because `docker logs` is collected (`maskHeaders`/`maskSecret`). Header **names** are matched against
  `SENSITIVE_HEADER_PATTERN`, built from the exported `SENSITIVE_NAME_ALTERNATIVES` (`auth`, `authorization`,
  `authentication`, `api-key`/`apikey`, `token`, `secret`, `cookie`, `session`, `passw`, `key`, `code`, `sig`,
  `signature`, `credential`, `bearer`, `password`/`passwd`/`pwd` as whole name segments — a bare `passw` was a
  prefix and matched nothing else, and `access[-_]?token`, `auth[-_]?token`, `refresh[-_]?token`, `client[-_]?secret`,
  `secret[-_]?key` and `session[-_]?id` match the **concatenated** spellings too, because the client chooses the header
  name and `X-Access-Token`/`Client-Secret`/`Session-Id` are ordinary ones) rather than a fixed denylist: `x-goog-api-key`,
  `x-auth-token` or `openai-api-key` is a credential too, and the client decides that name. **URLs are masked too**
  (`maskUrlQuery()` before `loggableUrl()` truncates): `?api_key=…`, `?token=…` and `?Authorization=…` are a
  documented OpenAI-compatible client convention, and so are Google's `?key=…`, an OAuth `?code=…` and an Azure SAS
  `?sig=`/`?signature=…`; `#` separates a pair too, because a raw client can put a fragment in the request target
  (`GET /v1/models#access_token=…`) even though `curl` and browsers strip it, and Node logs the URL as it arrived. The
  list is one exported string because `docker/docker-entrypoint.sh` masks its own first-boot dump with the same helpers
  (it imports `src/logger.js` through `node --input-type=module -e` instead of carrying a copy, whose regex missed
  `#`-separated pairs); the smoke suite asserts the entrypoint calls the helper rather than re-implementing it.
  A request body reaches the debug dump through `maskDetail()` (the same name list on a bounded copy, each string cut
  at `MAX_SERIALIZED_LENGTH` before it is masked: the line is cut to that length too, so a body at the 50 MiB limit no
  longer costs 688 ms per debug line), and the model-fetch error line uses the same helpers. A detail object handed to a
  debug line is **truncated before it is cloned** (`serializeDetail()`): a 50 MB body used to be cloned and
  re-stringified into a 32 KB line (43 ms and +100 MB of heap per line).
  Masking replaces a value and never drops the key: the copy these helpers build is assigned to with
  `setOwnProperty()` (a `defineProperty` for exactly the name `__proto__`) because `copy[key] = value` runs the
  `__proto__` setter, so a key of that name vanished from the masked header dump and the debug detail, and
  assigning a non-object through it is a no-op. A backend
  payload reaches these helpers through plain `JSON.parse`, so a provider can put that key in a logged body; a request
  body cannot (Fastify's poisoning guard refuses it first) and Node's header parser drops it. Neither copy's prototype
  is touched either way (asserted).
  A **closed reader** on stdout or stderr is tolerated: the logger installs an `EPIPE` handler, because a stream `error` with no
  listener is an uncaught exception: `node index.js | head -3` killed a live gateway. Only `EPIPE`/`ERR_STREAM_DESTROYED` are swallowed: that line is lost, the process keeps answering (asserted).
- **Tool-call filtering** removes `<function_calls>…</function_calls>` blocks only when `DISABLE_TOOLS` is on. The
  streaming variant holds back a trailing fragment that could still become one of the two tags, because a delta
  boundary can fall inside either of them; the held fragment is flushed at end of stream. That tail is found with one
  `lastIndexOf('<')` (`splitAtPossibleTag()`, bounded to the window a tag prefix can occupy), never by testing up to
  16 candidate suffixes per delta. The filter is one
  left-to-right scan (`removeToolMarkup`), never a lazy `[\s\S]*?` regex: that one backtracked quadratically from every
  open tag (64 000 tags in a 1 MB answer took 8.5 s, wedging the only completion slot) and the scan answers the same 15
  shapes byte-identically. The flush must write
  the frame directly (`sendReleasedDelta`): passing the fragment back through the filter holds the same prefix again,
  and with no further delta to disambiguate it, the tail of the answer disappears. The recovery poll appends the
  **raw** remainder of the stream through that filter (`collected.content` is the text the filter saw), never the
  already-stripped answer: handing tag-free text to a filter that still holds the interrupted stream's state leaked the
  held tag prefix, or dropped everything after it (a cut inside a block answered `hello ` with
  `finish_reason: "stop"`). An answer the backend rewrote is written around the filter (`sendReleasedDelta`) instead.
  The streaming filter must drop exactly what `removeToolMarkup()` drops, because the same answer served either way has
  to read the same: a **stray closing tag** with no block is dropped (the text around it kept), and an **opening tag
  that never closes** drops the tag but keeps the text after it (`createToolCallFilter()`'s `pending` buffer). It used
  to forward the stray tag and to swallow everything after an unclosed one - 2 800 of 3 905 fuzzed tag-soup answers
  disagreed with the non-streaming scan.
  `DISABLE_TOOLS` is read
  from the environment under both its bare name and the legacy `OPENCODE_DISABLE_TOOLS`. On the 2.x server it is a
  session **permission ruleset** handed to `session.create()` (`toolPermissionRules()`): every action the default agent
  can use is denied first (`edit`, `shell`, `write`, `grep`, `webfetch`, `websearch`, `subagent`, `external_directory`,
  `question`, `skill`, `task`, `todowrite`, `todoread`, `lsp`, `browser`, `patch`, `multiedit`, `invalid`), then
  `deny *` catches an action a newer server grows, and `read` and `glob` are re-allowed **last** as the single
  exception — denying either of them hung prompt requests with the free zen models. The set lives in constants
  (`TOOL_DENY_ACTIONS`, `TOOLS_ALLOWED_WHEN_DISABLED`) and the rules go out only when the switch is on; the prompt
  text still carries `TOOL_GUARD_MESSAGE`, because a permission rule refuses a call the model may still attempt.
- **Boolean options go through `parseBoolean()`** (in `src/options.js`, re-exported from `src/proxy.js`), the single
  parser used by
  `index.js` and `startProxy()`. Two implementations of that rule drifted once (`-e DISABLE_TOOLS=yes` meant "off"
  in the container); do not add a third. A value that is present but cannot be read is **named with the
  value actually used** (`readFlag()` in `src/options.js`, used by `index.js` for `DISABLE_TOOLS`,
  `USE_ISOLATED_HOME` and `DEBUG`): `[Config] DISABLE_TOOLS='maybe' is not a boolean (use true/false, yes/no, on/off
  or 1/0), using false`. A silent fallback is the failure the numeric tuning keys were fixed for, and
  a `DISABLE_TOOLS` typo leaves `<function_calls>` markup in the answer while the operator believes it
  is filtered out. `parseBoolean()` rejects a value longer than 64 characters before it trims and lowercases it (the longest accepted
  spelling is five characters; a client-sized `stream` value cost 10 ms per call and the handler reads each boolean
  twice) and stays the only parser (it is also used on request bodies, where a warning would be wrong: an unreadable `stream` or
  `stream_options.include_usage` there is a `400` naming the field, because a typo answered JSON to a client parsing
  SSE, and `stream_options` must be an object). `stream_options` on a body that is **not** streaming is ignored, not
  refused: the usage chunk exists to carry numbers a streaming client cannot get any other way, the non-streaming body
  already has `usage`, and a `400` would refuse an otherwise valid request - so a shared body that sets the option and
  sometimes sends `stream: false` reads `usage` from the JSON it gets back. A **number** counts only as `1`/`0`: every other number used to read as
  "on", so `{"stream": 0}` answered SSE to a client waiting for a JSON body, and `{"stream": 2}` did the same; `readFlag()` only reports. The label repeats the name the operator used (`config.json DISABLE_TOOLS` or the variable); the value goes
  through `loggableConfigValue()` too, because it lands in a log line.
  `startProxy()` applies the same rule to its own fallbacks (`flagOption()`), for an embedder with no
  entry point to resolve it first: an option the caller passed is taken as given — `index.js` already
  reported it — while an absent option reads the environment through `readFlag()`.
- **Configuration** follows the precedence env > `config.json` > default, and every new key must be added to
  `config.json.example`, the README configuration table and — for container-relevant keys — `docker/docker-entrypoint.sh`.
  `config.json` is read from the **application directory** (`path.join(__dirname, 'config.json')`), not the working
  directory, because the container writes it next to the app; a `config.json` in the cwd is ignored, so startup warns
  `[Config] config.json is read from …; the file at … is ignored`.
  An environment variable that is present but **blank or only whitespace** counts as unset (`envOrFile()` in
  `src/config.js`): `PORT` and `API_KEY` were read with `??`, where an empty string is a value, so `API_KEY= PORT=`
  shadowed `config.json` and the gateway listened on the default port with the built-in public key while the file named
  another port and a real secret. Whitespace is the same mistake with a trailing space left in (a unit file, a rendered
  template): `BIND_HOST=' '` failed to bind with `ENOTFOUND` and `OPENCODE_SERVER_URL=' '` pointed every completion at
  `http:// `. `index.js` reads `OPENCODE_SERVER_URL`, `OPENCODE_BIND_HOST`, `OPENCODE_PATH`, `BIND_HOST` and `LOG_LEVEL`
  through it too, so every key that can come from either place follows the rule; `BIND_HOST` falls back
  `BIND_HOST` → `OPENCODE_PROXY_BIND_HOST` → default, so a blank alias does not hide the other spelling. A blank value
  in **`config.json`** is the same: the container's entrypoint writes `OPENCODE_PATH: ""` when the image sets no path, and
  returning that empty string ended the chain (`??` catches only nullish), so a container that had always started
  refused to run. Keep every key on that rule.
  A **key nobody reads** is named at startup and ignored (`[Config] config.json has an unknown key 'APIKEY' (did you
  mean 'API_KEY'?) - it is ignored`, via `findUnknownKeys()`): a misspelled key changed nothing, so the default ran
  while the operator trusted the file. A
  suggestion is only made for a case/separator difference — a real misspelling (`…MAX_CONCURENCY`) cannot be guessed — the value is never printed (a mistyped `API_KEY` is still a
  credential), and nothing is merged generically, so an unknown key (including `__proto__`) cannot reach the running
  config. `OPENCODE_PROXY_DEBUG` is an environment name only — the file key is `DEBUG`, so a file entry under the
  former is reported as unknown instead of doing nothing.
  `OPENCODE_SERVER_URL` is normalised at startup (`normalizeBackendUrl`): whitespace is trimmed, a trailing slash is
  stripped and a missing scheme is read as `http://`, the last two with a `[Config]` warning. A trailing slash made
  every SDK path `//session`, which the backend answers with 404 — the gateway then reported "backend exited during
  startup". The entry point normalises the value **before** printing the summary and emits the notes there (the
  function is exported for that), because the summary is where an operator copies the value from. `startProxy()`
  normalises what it is handed once more: a no-op for an already-normalised value, still correct for an embedder.
  `BIND_HOST` and `OPENCODE_BIND_HOST` are trimmed the same way (`normalizeBindHost()`, with a `[Config]` note): a
  trailing space reached `listen()` as part of the address. A bind address that is **not loopback** is warned about
  where it matters: `OPENCODE_SERVER_URL` over plain `http://` says its credential travels in clear text, and a
  non-loopback backend URL with a spawned child says the child cannot satisfy it (the child listens on `OPENCODE_BIND_HOST`).
- **Every tuning key follows the same precedence.** `OPENCODE_PROXY_MAX_CONCURRENCY`, `OPENCODE_PROXY_MAX_QUEUE`,
  `OPENCODE_PROXY_MAX_BODY_MB`, `OPENCODE_PROXY_REQUEST_TIMEOUT_MS`, `OPENCODE_PROXY_HEALTH_CACHE_MS` and
  `OPENCODE_PROXY_START_RETRY_MS` are read through `readLimit()` / `readMilliseconds()`, which take the `config.json`
  value as the fallback and let the environment win. They used to be read from the environment alone, so the same keys
  in `config.json` were ignored while the summary reported the default. `startProxy()` applies the resolved
  queue limits and backend timings before the server listens, and `getQueueLimits()` takes the merged configuration so
  the summary cannot disagree with what the gateway uses.
  A value that is present but unusable is **named in a `[Config]` warning with the value actually used**
  (`OPENCODE_PROXY_REQUEST_TIMEOUT_MS='0' is not a positive number, using 300000`, `… HEALTH_CACHE_MS='abc' is not a
  number, using 2000`): a silent fallback left the operator convinced a value was in force while the gateway ran the
  default.
  The completion budget has one resolution point, `resolveRequestTimeoutMs(options, env)` (in `src/settings.js`,
  re-exported from `src/proxy.js`): it applies the same precedence and returns the value **and** the note to print, so
  an entry point, an embedder and the smoke suite cannot disagree. A blank environment value falls through to
  `config.json` like every
  other key (`??` ended the chain at `''`, so `Environment=OPENCODE_PROXY_REQUEST_TIMEOUT_MS=` in a unit file silently
  replaced the file's value with the 300000 ms default, and the "unusable value" note was skipped for a blank one).
  A timeout above `MAX_TIMER_MS` (`2 ** 31 - 1`, the largest delay `setTimeout` accepts) is clamped to it with a note: a
  larger value is stored as `1` and fires immediately, so a mistyped budget turned every completion into an instant `504`.
- **Polling watches the newest assistant message.** A tool-using completion has more than one: the step that asked for
  the tool is finished (`finish: "tool-calls"`) while the step that answers is still being written. The poll reads the
  last assistant message in the list and evaluates only that one; walking back to the first message that looked
  finished answered the earlier step under `finish_reason: "stop"` (measured: `STEP ONE TEXT` in 29 ms, the real answer
  570 ms later).
- **Polling answers with the finished message.** `pollForAssistantResponse` is called with `requireDone: true` on
  every path that emits the final answer: the poll loop can start while the answer is still being written, and
  returning the first non-empty message truncated it. A message whose
  text stops growing for `stablePollsRequired * intervalMs` is accepted anyway, so a provider that never marks its
  message finished still gets an answer. That window is measured in **time, not in polls** (`stableWindowMs`): the
  first polls are much shorter than the interval (`POLL_BACKOFF_MS` = 25/50/100/200 ms), and counting polls would have shrunk the
  documented ~1.5 s of silence to ~75 ms and served half-written answers. It
  watches the whole visible answer, `content` **and** `reasoning`, and requires one of them to be non-empty: watching
  `content` alone left the window at 0 for a reasoning-only message, so such a provider was answered `504`. `extractFromParts()` reads a part's `text` only when it is a string, like the streaming
  collector and the request parser: concatenating whatever arrived served a numeric part as answer text
  (`parts: [{text: 42}, {text: 'Alpha'}]` answered `"42Alpha"`). The
  first four polls use `min(intervalMs, POLL_BACKOFF_MS[i])`, an answer landing a few tens of milliseconds after
  the prompt returned used to wait a whole interval. Do not remove the backoff without keeping the time window: the two belong together.
- **A completion has one budget, not one per phase.** The prompt, the event subscription and the polling fallback all
  take what is left of `REQUEST_TIMEOUT_MS` (`remainingBudget()` in the handler) instead of each starting a fresh
  copy: a streaming request whose event stream timed out spent a second full budget polling, so the client waited
  about twice the advertised timeout (measured 60 s for a 40 s budget) and the queue timer named a budget already
  exceeded. `remainingBudget()` never goes below 1 ms, so an exhausted budget surfaces as its
  timeout rather than a spinning loop. When the whole-collector budget expires it clears the first-delta and idle
  timers before aborting, so a `data` event cannot fire a handler into a settled collector.
  `client.session.create` takes it too: with a fresh budget there, a
  completion that had queued 3 s answered at 5.7 s with a 4 s budget.
- **A failed poll does not end the completion.** `pollForAssistantResponse` retries a poll that answers with an error
  (a 5xx while the backend is busy) or throws (a reset while it restarts): one bad poll used to lose an
  answer that was one poll away - the thrown case surfaced as `502 "fetch failed"`. Only `MAX_POLL_FAILURES` (5)
  consecutive failures give up, and they report an upstream error with the status and reason
  (`OpenCode backend failed while polling the answer (status 500): …`, or `… : the backend is not reachable
  (fetch failed)` for a connection failure) in ~2 s instead of burning the whole budget and answering `504`. An empty list is a normal "not written yet" poll, not a failure. A poll
  that answers **2xx with something that is not a message list** (an envelope that moved, a proxy in front of the
  backend returning its own JSON) is reported by its shape - `… answered with a payload that is not a message list
  (status 200)` - not by the status, which reads like a gateway bug; the payload's type and top-level keys go to the
  debug line next to it, which tells an envelope change from an error body.
- **An idle stream is recovered, not ended.** When the event stream goes silent for `DEFAULT_EVENT_IDLE_TIMEOUT_MS`
  the gateway polls for the rest of the answer and appends only what the client does not have yet. The timer that
  measures that silence is **re-armed in place** (`idleTimer.refresh()`, one call per delta) instead of being cleared
  and re-created for every frame — and it is only armed while the stream is unfinished and a timeout is configured. The
  behaviour is the same either way, which is why the many-delta case is asserted end to end (`MANYDELTAS`). That recovery poll
  tolerates a full idle window of further silence (`IDLE_RECOVERY_STALL_POLLS`) before accepting a message the backend
  never marks finished: the default three intervals of no growth (~1.5 s, time not polls) is right after
  a normal prompt, but applied to a stream already silent for 8 s it ended the response with `finish_reason: "stop"`
  on text that stopped mid-sentence.
- **A stream that ends without a finish event is recovered, not timed out.** When the event stream is closed
  mid-answer (backend restart, a proxy dropping idle SSE connections) the collector settles with
  `streamEnded: true` and the streaming path polls for the rest of the answer, appending only what the client does not
  have yet — exactly like the idle-timeout path. Before that it stayed silent until the whole budget ran out and then
  wrote an in-band error, for an answer the backend had finished.
- **A cumulative part snapshot is diffed against that part, not against the answer.** A 2.x `session.text.ended` /
  `session.reasoning.ended` event carries no `delta`: its `text` is the part's current full text, so the gateway
  derives the increment (the `*.delta` events carry a real increment and are appended directly). It belongs to the part
  it came from (`partTexts` in `collectFromEvents`): measuring it against the accumulated `content` never matched a
  second part, so a multi-part answer repeated each part once per event (`alpha beta gamma ALPHA BETA GAMMA` arrived
  as `alpha alpha beta alpha beta gamma …`). The compare is also O(1) per event (`snapshotDelta()`: a length check
  plus a 32-character head and tail window against the part's *previous* snapshot, `SNAPSHOT_EDGE_CHARS`), where
  `startsWith` against the whole answer forced a rope flatten and a full compare per event — measured 299 ms of
  gateway CPU for a 200 KB answer, 823 ms for 400 KB, growing quadratically.
  The recovery poll describes a copy that can be *behind* the stream it already delivered (a store written behind the
  broadcast): when the polled text is a prefix of what the client has, it carries nothing new and is not written — both
  extension checks were false for a shorter copy, so it was appended and the head of the answer arrived twice under
  `finish_reason: "stop"` (`LAGSTORE`). A snapshot that is not an extension of the previous one is forwarded whole; the 32-character window is the
  deliberate limit, so a rewrite *inside* it reads as a continuation. The snapshot is recorded on **every** event that
  carries one, including events that also carry a `delta` (the SDK's event type allows both): recording it only on the
  delta-less branch left a mixed backend's closing update diffed against `''` and delivered the whole part twice
  (`Hello worldHello world`). A `delta` that is not a string is ignored, so the event takes the snapshot path. A part
  the backend sends **without an id** is keyed by its type, and one answer can carry several parts of the same type: a
  key therefore holds a bounded list of snapshots (`MAX_PART_SNAPSHOTS`, 4) and the increment is taken against the
  snapshot the new text actually continues, so two id-less `text` parts are delivered once each instead of being
  diffed against one another (`MULTIPARTNOID`). Both maps are bounded by the same key count (`MAX_PART_KEYS`, 64):
  `partTotals` was not, and a backend that varies the part id grew it one permanent entry per delta (200 000 deltas
  measured 200 000 entries and +44.6 MB of heap, against a `partTexts` stuck at 64). A delta that extends the snapshot
  its key is already holding is written into that snapshot directly - the delta *is* the increment, and re-diffing the
  whole answer to rediscover which entry to update cost O(answer) per delta (measured 217 ms for 2 000 deltas of a
  1 MB answer, on the thread that streams it); the entry is only re-found through `recordPartSnapshot()` when a closing
  event rewrote it or the snapshot bound dropped it.
- **A finished message ends the stream, whatever the finish reason.** The collector settles on any non-empty
  `finish` (or `time.completed`), not just `finish === "stop"`: requiring the literal word left answers from
  providers that report `tool-calls`, `end` or only `time.completed` waiting for the 8 s idle timeout.
- **Every backend call carries a deadline.** `client.session.create`, `client.message.list`,
  `client.session.remove`, `client.session.prompt`, `client.model.list` and `client.event.subscribe` are all called
  with an `AbortSignal` (`backendDeadline()`), and an expired one answers `504` ("did not answer within …ms") instead
  of `500`. The health probe is bounded too, and by a deadline armed **before** the request exists
  (`HEALTH_PROBE_TIMEOUT_MS`, 2 s, `checkHealth()`): `request.setTimeout()` starts its clock only once a socket is
  assigned, so DNS and the TCP handshake were unbounded - and this probe runs on the completion path with the slot
  already taken, so a backend host that drops SYNs (a firewall, a wrong port on a black-holed address) suspended the
  request for the OS connect timeout (~2 min on Linux) without any of the SDK calls above being involved. Node's `fetch` has no default timeout: a backend that answers `GET /api/info` but never `POST /api/session` left the
  handler waiting forever, so the client got nothing and the slot was never released - at concurrency 1 that stops the
  gateway. Session cleanup uses its own shorter budget
  (`SESSION_CLEANUP_TIMEOUT_MS`): it runs after the client already has its answer, so it must not hold the slot for
  the full budget. The metadata call (`/v1/models`) is capped separately
  (`METADATA_TIMEOUT_CAP_MS`, never above `REQUEST_TIMEOUT_MS`), because it falls back — a listing must get the fallback
  quickly, not a completion budget.
- **A promise that loses a race needs a handler.** `promptWithTimeout` races the prompt against its own timer and the
  losing promise keeps running: a rejection arriving afterwards (the backend dies, the deadline aborts the fetch)
  reached nothing and became an unhandled rejection, which terminates the process: one slow completion could take the
  whole gateway down. Every raced promise gets a `.catch(() => {})`.
- **Timeouts and fallbacks are behavioural contracts.** The polling fallback, the shortened first-delta wait, the
  health-probe cache and the start-failure cooldown exist because of real OpenCode protocol quirks (2.x event
  payloads, free zen models). Do not remove them without replacing the behaviour they cover.
- **Signals belong to the entry point.** `index.js` owns `SIGINT`/`SIGTERM`: it closes the HTTP server, lets the
  responses in flight finish (1.5 s grace), stops the backend and exits, with a watchdog so an open SSE stream cannot
  block shutdown. The backend is stopped *after* that grace period, not before it: killing it first turned a
  completion the gateway was already serving into an upstream error, which is the opposite of a graceful shutdown.
  Every exit path stops the backend exactly once. Do not register signal handlers that call `process.exit()` from a
  module — they win the race and skip backend teardown. The status the process leaves with is part of the contract: a
  signal is `0`, an `uncaughtException` is `1` (`shutdown(signal, exitCode)`), because a crashed gateway reported as a
  clean stop is never restarted by `Restart=on-failure` or a Kubernetes restart policy and never alerts anyone.
- **The wait queue is bounded** (`OPENCODE_PROXY_MAX_QUEUE`, default 64) because every waiting request pins its parsed
  body; overflow answers `503 queue_full` instead of growing memory. The other half is `OPENCODE_PROXY_MAX_BODY_MB`
  (default 50, the Fastify `bodyLimit`): together they allow 3.2 GiB of pinned bodies, so both are documented
  knobs. The cap counts *waiting* requests, so it is reached only while every slot is busy: `0`
  means "never queue", not "refuse every completion" (a lone request with a free slot is served). A slot is released
  when its response is complete (`release()` in `runQueuedTask`), not when the task promise settles: the session
  deletion after the answer is a backend round trip, and holding the slot through it made a follow-up request look like
  a full gateway. `.finally(release)` stays the safety net, so `release()` is idempotent. That safety net only runs
  when the task settles, though, so a task parked in an await that never resolves pinned the slot for good: the
  execution timer rejects the caller (the `504`) and, `SLOT_WATCHDOG_GRACE_MS` (5 s) later, releases the slot itself
  with one `warn` line. A request whose client
  disconnects while queued is dropped when its turn comes (`reply.raw` 'close'), so it never spends backend time. The
  disconnect signal is not `request.raw.destroyed`: that stream is destroyed once its body is read.
  A body over `OPENCODE_PROXY_MAX_BODY_MB` is still refused with `413`, but only after it has been read to its end (`refuseOversizedBody()`, bounded by `BODY_DRAIN_TIMEOUT_MS`): Node ends the socket when a response finishes with
  the request body unread, and the kernel answers the client's remaining bytes with RST, so the client could lose the
  413 entirely. The message names the limit in force
  (`request body is too large (limit 50 MiB); send a smaller body or raise OPENCODE_PROXY_MAX_BODY_MB`) instead of
  Fastify's bare sentence: the fix depends on a number only the gateway knows, and it comes from the value
  `createApp()` was built with (`bodyLimitMb`), so it cannot disagree.
- **The container runs as the unprivileged `node` user.** `docker/Dockerfile` chowns `/app` and declares
  `USER node` (uid/gid 1000) after the CLI install, so the gateway, the backend it spawns and every tool it runs are
  not UID 0. The entrypoint still writes `/app/config.json` (0600, owned by that user) on first boot, so a bind mount
  there must be readable — and a credentials directory writable — by uid 1000 (`docker/README.md`); CI asserts the uid
  is not 0. It writes that file through a temporary file and an atomic `rename` (a container killed mid-write must not
  leave a truncated `config.json`, which made every later start exit with "is not valid JSON"), and it keeps
  `OPENCODE_BIND_HOST` on `127.0.0.1`: publishing 4097 would expose the backend's API and web UI outside the gateway,
  which is the only thing that checks a key. The image's `HEALTHCHECK`
  resolves the port itself (`PORT`, else the stored `config.json`, else 8083) and validates it the way the gateway trims
  it, so `PORT=' 8083'` does not build `http://127.0.0.1: 8083/health`; the digit class is spelled `[0-9]` because a
  `\d` inside the shell-quoted program arrives as a literal backslash and a `d`, which made every port read as invalid
  and probed 8083 for a container listening elsewhere (`test/smoke.mjs` runs the embedded expression).
- **Workflow actions are pinned to commit SHAs.** Every `uses:` in `.github/workflows/` (any depth) names a 40-character
  commit with the release in a trailing comment (`actions/checkout@<sha> # v4.4.0`), and a CI step fails the build when a
  movable ref reappears: `docker-publish.yml` leaves a write-scoped registry token on the runner, so an action resolved
  through a retagged major tag is code nobody froze. The check skips the comment itself (a comment explains the rule in
  those words) and requires the `# vX` marker, so `@v4`, `@main` and a `docker://` image reference all fail.
- **The image pins the CLI, and the pin is the 2.x line.** `docker/Dockerfile` installs `@opencode/cli` with
  `ARG OPENCODE_VERSION=2.3.2`, matching the `@opencode/client` version in `package.json`. A 1.x `opencode-ai` release
  is a different upstream: its `serve` has no `/api/*` route, so the readiness probe (`GET /api/info`) never passes and
  every completion fails. Bumping that default means checking that the session API and the bundled client still
  correspond — the image installs one CLI, and the client is what drives it.
- **The CLI version probe never blocks the start.** `opencode --version` is read with the asynchronous `execFile`
  *after* the server is listening and reported as its own line (or, on failure, as the installation warning): the
  synchronous probe sat in the startup path with a 5 s timeout, so a wrapper script waiting for input delayed the
  bind by the whole timeout and the process reached Ctrl-C without its signal handlers installed - not a
  graceful shutdown. The 1.x warning it feeds is unchanged, and it now arrives while the gateway is already serving.
- **The backend command survives the shell it runs in.** `opencodeBin` is quoted whenever the spawn uses a shell
  (`C:\Program Files\...opencode.cmd` does not start unquoted, and `;`/`&` in a path would be read as operators);
  paths carrying `"`, `$`, a backtick or a control character are refused instead, because quoting cannot neutralise
  them (a line break splits the command). A configured
  `OPENCODE_PATH` that does not exist is warned about rather than silently replaced by whatever the PATH search finds.
- **The start attempt is claimed before the probe.** `state.isStarting` is set synchronously, before the
  `checkHealth` call that may suspend, and released in a `finally` on every path: claiming it only after that probe
  failed let two callers arriving within one probe round trip both spawn a backend, and the second spawn killed the
  first one's child and overwrote the tracked process. A caller waiting on someone else's attempt probes first and
  sleeps between attempts, so a request arriving
  during a start is served as soon as the backend answers.
- **`killBackend()` returns a promise that settles when the child is gone** (SIGTERM, then SIGKILL after 3 s), and
  `index.js` awaits it before `process.exit(exitCode)`; the jail directory is removed only after the child is gone, because it
  is the child's cwd. Exiting right after SIGTERM skipped the escalation, so a backend that ignores SIGTERM outlived
  the gateway that owns it. The whole teardown shares **one** budget (`SHUTDOWN_TEARDOWN_BUDGET_MS`, 8 s: a pending
  start, the session drain, the 3 s grace and the reap), each step taking what is left of it, and the entry point's
  hard exit sits above that budget (10 s) because it is a backstop, not the budget: with one budget per step their sum
  (3.5 + 3 + 3 + 1 s) outlasted the hard exit, and a SIGTERM-ignoring child survived the gateway (measured: exit 0 at
  5 008 ms, child alive and holding the port). It also sets `state.shuttingDown`, which every `ensureBackend()` path
  checks before it spawns and which the readiness loop checks every iteration, so a pending start aborts instead of
  spending the startup budget: an attempt still inside its health probe (or waiting for the previous child) used to
  spawn `opencode serve` *after* the promise resolved, leaving a running caller with an untracked backend holding the
  port. A pending attempt is waited for (`waitForPendingStart()`, bounded by the largest step it can be inside and the
  teardown budget), and each respawn deletes its predecessor's path from `ownedJailRoots` before replacing it.
- **The readiness probe asks `GET /api/info` and requires `200` with a JSON body** (`HEALTH_PROBE_PATH`,
  `isJsonHealthBody()`, `probeBackendOnce()`): 2.x serves the HTML web UI from `GET /` and `/health` with `200`, so the
  earlier "any 200 is healthy" rule accepted a backend that then answered every API call with `401` or `404` — the probe
  passed, the child was considered up, and every completion failed. The **status** is checked before the body is
  classified, because `GET /api/info` answers an unauthenticated request with `401 {"_tag":"UnauthorizedError"}`: the
  probe used to settle on the first bytes of the body, so a JSON refusal read as a healthy backend and the spawn loop
  logged `backend ready` for a server whose every route would refuse the SDK's own credential.
  The probe carries a **list** of credentials (`BACKEND_HEALTH_AUTHORIZATIONS`, server password first, URL userinfo
  second) because one `Authorization` header can only hold one hop's secret: the server authenticates its own API while a
  proxy in front authenticates the URL's. Only a `401` moves on to the next candidate — a refused connection, a timeout
  or an HTML answer means there is no backend to authenticate against, and retrying would double the wait on the path
  that concludes the backend is gone.
- **Backend lifecycle changes** must keep these properties: `ensureBackend()` trusts a successful probe for
  `OPENCODE_PROXY_HEALTH_CACHE_MS`, connection failures clear that trust, a spawned process that exits during startup
  aborts the readiness wait, and a failed start triggers a cooldown instead of a retry storm. A backend that is known
  to be healthy but whose trust window has expired is re-probed **in the background** (`refreshBackendHealthInBackground()`,
  at most one probe in flight) and the request proceeds: with the default 2 s window almost every interactive
  completion arrived after it and paid a `GET /api/info` round trip before `session.create`. A backend that died is still recovered by the request that hits it (`session.create` fails on the
  connection error, clears `healthyAt` and calls `ensureBackend()` again), a backend that never answered still takes
  the blocking path, and `OPENCODE_PROXY_HEALTH_CACHE_MS=0` keeps its documented "probe on every request" meaning.
- **The backend child does not inherit the gateway's credentials.** The `opencode serve` spawn deletes `API_KEY`
  (and `OPENCODE_PROXY_DEBUG`) from the environment it passes on, and the version probe does the same: the child runs
  model-directed tools and authenticates nothing with a key that guards only this gateway.
  `OPENCODE_SERVER_URL` goes the same way: it is the gateway's own configuration, and it can carry a credential.
  Provider credentials the CLI needs live in its own auth store or under their own names, so they stay.
  The one value deliberately **added** is `OPENCODE_SERVER_PASSWORD`: the 2.x server authenticates every `/api/*` route
  with HTTP Basic (username `opencode`), so a spawned child with no password would answer `401` to every call.
  `resolveBackendPassword()` generates a random one per process when the key is blank and passes it through the
  same-named variable the server itself reads — which also suppresses the `server password …` line it would otherwise
  print, so no secret has to be scraped out of the backend's output. It is registered as a sensitive value and masked
  in the container's first-boot dump, and never logged. The jail
  directory (`<tmp>/opencode-proxy-jail/<salt>`, the child's cwd and its whole `HOME` under `USE_ISOLATED_HOME`) is
  created `0700`: on a shared `/tmp` the default `0755` let every other local user list and traverse it, and it is
  removed on every platform (a Windows skip left the directory behind for good).
  The **parent** of that jail is checked before it is used (`resolveJailParent()`): `/tmp` is world-writable and the
  name is predictable, so another unprivileged account can pre-create `opencode-proxy-jail` - or a symlink of that name
  - and `mkdirSync(recursive)` succeeds on it, which would leave that account owning the parent of the backend's
  working directory (and of its `HOME`). The parent is trusted only when it is a directory this process owns (uid match;
  no comparison on Windows), a symlink or a foreign directory is warned about and replaced by a private
  `opencode-proxy-jail-XXXXXX` (`mkdtempSync`, `0700`), and only the directories this process created are removed. Under `USE_ISOLATED_HOME` the child's
  `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `TMPDIR`, `TMP` and `TEMP` all point inside
  that jail: the CLI resolves them before `HOME`, so an inherited value (a desktop session, a systemd unit, an image)
  sent the "isolated" run straight back to the real user's store, config and cache.
- **A cached healthy answer does not fail the request it was wrong about.** `session.create` that throws a connection
  error (the backend died within `OPENCODE_PROXY_HEALTH_CACHE_MS` of the trusted probe) drops that trust, calls
  `ensureBackend()` again and retries the call once; the crash-recovery then happens for the request that hit it
  instead of only for the next one. A deadline (`isTimeoutError`) and a restart that cannot happen (cooldown, missing
  binary) are not retried, and the retry reports the original upstream failure rather than the start error it produced.
- **A replacement backend starts only after the old child is gone.** The respawn path SIGTERMs the tracked process,
  waits for `exit` (SIGKILL after 3 s) and only then removes the old jail directory and spawns: sending SIGTERM and
  spawning on the next line let the old child hold the port, so the replacement failed to bind ("exited during
  startup") and tripped the retry cooldown - one wedged backend turned its recovery into an outage. "Exits" means
  `exitCode !== null || signalCode !== null`: a child killed by a signal reports `exitCode === null`, and testing the
  exit code alone let a SIGKILLed backend look alive for the whole startup budget while
  `isStarting` stayed true. A request waiting on someone else's start attempt falls through to its own when
  that attempt ends without a reachable backend (the retry cooldown still applies): the first request after a crash
  should restart the backend, not report it gone.

## Performance guardrails

`README.md` publishes benchmark numbers; a change that plausibly affects throughput or latency should be measured
with `autocannon` against a stub backend (a real model is too slow and too variable to compare):

```bash
pnpm dlx autocannon -c 10 -d 8 -m POST -H "content-type: application/json" \
  -H "authorization: Bearer sk-dummy-123" \
  -b '{"messages":[{"role":"user","content":"hi"}],"stream":false}' \
  http://127.0.0.1:8080/v1/chat/completions
```

Measure with the request log off (`LOG_LEVEL=error`): at the default `info` every `/v1/*` request writes a line, and
a redirected stdout is synchronous, so the log sets the ceiling (`GET /v1/models`: ~104,900 req/s at 0.08 ms quiet vs
~71,600 at 1.02 ms with the line - mixing log levels compares the logger). Report before/after, and update the README table only with
numbers measured on that machine.
Completion requests are serialised by default (`OPENCODE_PROXY_MAX_CONCURRENCY=1`); that default stays `1`.

## Definition of done

Before reporting a change as complete:

1. `pnpm run check` passes.
2. `pnpm test` passes; new behaviour that can be asserted belongs in `test/smoke.mjs`.
3. `pnpm run check:commits <base>..HEAD` passes for the commits the change adds; a wrong subject must be fixed
   before it is published, because rewriting published history rewrites every commit after it.
4. The gateway boots (`pnpm start` or `node index.js`), `GET /health` returns `200`, `/v1/models` answers `200` with
   the key and `401` without it, a chat completion works with and without `stream: true`, and an invalid body returns
   `400`.
5. Documentation that describes the changed behaviour is updated in the same change (README tables, Docker README,
   this file when invariants or commands change).
6. Shutdown is clean (`SIGINT` logs `[Shutdown]` and exits) when backend lifecycle code was touched.
7. The report states exactly what was run and what was not (for example: "Docker image not built — no Docker here").

## Reporting

Issues and proposals go to the repository tracker: <https://github.com/dinhdev666/free-opencode-api/issues>.
Security-sensitive reports (auth bypass, key leakage, command injection in backend spawning) stay private; see
`CONTRIBUTING.md`.
