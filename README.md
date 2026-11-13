# Free OpenCode API

[![CI](https://github.com/dinhdev666/free-opencode-api/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhdev666/free-opencode-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An **OpenAI-compatible REST API** that reuses the AI models you are already
signed in to with the [opencode](https://opencode.ai) CLI.

Point any OpenAI-compatible tool at it and it talks to opencode instead of
`api.openai.com`:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:20128/v1
export OPENAI_API_KEY=sk-dummy
```

- **Server:** Fastify (Node.js, ESM)
- **Package manager:** pnpm
- **opencode:** installed as a project dependency — never globally
- **Default port:** `20128` · **Default API key:** `sk-dummy`
- **Lightweight by design:** no log files, no build step, 3 runtime dependencies

---

## Quick start

```bash
pnpm install          # installs fastify, @fastify/cors and opencode-ai
pnpm start            # spawns `opencode serve` and starts the proxy
```

The proxy listens on `http://127.0.0.1:20128` by default.

```bash
# list the models opencode can reach
curl http://127.0.0.1:20128/v1/models -H 'authorization: Bearer sk-dummy'

# chat
curl http://127.0.0.1:20128/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-dummy' \
  -d '{
    "model": "opencode/glm-5.3-flash-free",
    "messages": [{"role": "user", "content": "Say hello"}]
  }'
```

> **Note** — the opencode CLI must already be authenticated for the providers
> you want to use (`opencode auth login`, or `/connect` in the TUI). The proxy
> reuses those credentials; it never stores its own.

---

## Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET`  | `/v1/models` | Every model the connected opencode providers expose. |
| `GET`  | `/v1/models/:id` | A single model. |
| `POST` | `/v1/chat/completions` | Chat completions, streaming and non-streaming. |
| `POST` | `/v1/completions` | Legacy text completions (prompt → text), streaming and non-streaming. |
| `GET`  | `/health` | Proxy + opencode health, also at `/v1/health`. |

Every endpoint except `/health` requires `Authorization: Bearer <API_KEY>`.

### Model ids

Both forms are accepted and resolve to the same model:

- `opencode/glm-5.3-flash-free` — fully qualified, unambiguous
- `glm-5.3-flash-free` — bare model id; resolves to the first provider that
  offers it, preferring a connected provider

opencode's own variant syntax works too: `provider/model#high`.

The model list is **never hard-coded** — `/v1/models` reflects whatever the
connected opencode catalogue contains at that moment.

`GET /v1/models/opencode/glm-5.3-flash-free` returns a single model, and
`GET /v1/models/glm-5.3-flash-free` works with the bare id as well.

### Endpoints the proxy does not implement

The proxy speaks the OpenAI chat-completions standard only. There is no
`/v1/embeddings`, no `/v1/audio`, no `/v1/images` — opencode has no
equivalent. Those answer with HTTP 404 and the usual OpenAI error body:

```json
{
  "error": {
    "message": "Unknown endpoint: POST /v1/embeddings",
    "type": "invalid_request_error",
    "param": null,
    "code": "unknown_endpoint"
  }
}
```

### Streaming

`"stream": true` returns a standard OpenAI SSE stream:

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
…
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":…,"completion_tokens":…,"total_tokens":…}}
data: [DONE]
```

The stream opens with a chunk that only carries the role, exactly as the
OpenAI API does. Reasoning models also receive their thinking under
`delta.reasoning_content`, so it never contaminates the assistant message.

---

## How it works

```
OpenAI client ──HTTP──▶ Fastify proxy ──HTTP──▶ opencode serve ──▶ provider
```

The proxy does not reimplement an LLM client. It speaks opencode's own HTTP
API (`opencode serve`), which exposes an OpenAPI 3.1 spec at `/doc`:

1. `POST /session` creates a session.
2. `POST /session/{id}/prompt_async` starts the turn.
3. `GET /event` (SSE) streams `message.part.delta` events while it runs.

### Function calling

opencode has no per-request "here are my functions" hook. The proxy emulates
OpenAI function calling on top of opencode's **structured output** support:

- the caller's function definitions are compiled into a JSON Schema,
- that schema is sent as opencode's `format: { type: "json_schema", … }`,
- opencode asks the model to call its internal `StructuredOutput` tool,
- the structured answer is converted back into OpenAI `tool_calls`.

`tool_choice` is honoured: `"none"` suppresses tool calls, and
`{"type":"function","function":{"name":"…"}}` restricts the schema to one
function.

### JSON mode (`response_format`)

`response_format` is supported in both OpenAI shapes:

```jsonc
// JSON mode — the answer is valid JSON.
{ "response_format": { "type": "json_object" } }

// JSON schema — the answer matches the schema.
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "capital",
      "schema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] }
    }
  }
}
```

Both go through the same structured-output mechanism as function calling. The
message body then contains the raw JSON, exactly as OpenAI does.

`response_format` can also be combined with `tools`. The model then answers
either with JSON or with a tool call, and the `finish_reason` follows what the
message actually carries.

### Fields the proxy accepts

| Field | Effect |
| ----- | ------ |
| `model` | `provider/model`, a bare model id, or `provider/model#variant`. |
| `messages` | The conversation. `system`/`developer` messages become the system prompt. |
| `tools` / `tool_choice` | Function definitions, emulated through structured output. `tool_choice` accepts `"auto"`, `"none"`, `"required"` and `{"type":"function","function":{"name":…}}`. |
| `response_format` | `json_object` or `json_schema`. |
| `n` | How many answers to return. opencode answers once per session, so the request is run that many times. |
| `stream` | SSE streaming. |
| `stream_options.include_usage` | Defaults to on; set it to `false` to omit the usage chunk. |

`max_tokens` and `max_completion_tokens` are accepted but opencode has no
per-request token limit — the cap is set server-wide with `MAX_OUTPUT_TOKENS`.
`temperature`, `top_p`, `stop`, `seed`, `n`, `user` and the penalty fields are
accepted and ignored: opencode picks the sampling parameters per model.

### OpenAI SDK compatibility

The proxy is exercised against the real [OpenAI Node SDK](https://github.com/openai/openai-node)
in `test/openai-sdk.test.mjs`. The SDK validates the response shape and throws
on anything it does not understand, so it is the strictest available check.

```bash
pnpm add -D openai   # only needed to run that test file
pnpm test
```

### Keeping requests cheap

opencode is a coding agent, so a naive proxy would ship its whole agent
context with every request. The `proxy` agent in `opencode.json` removes that
overhead:

| Setting | Effect |
| ------- | ------ |
| `tools: { …: false }` | Drops every built-in tool schema from the request. |
| `prompt: "You are a helpful assistant."` | Replaces opencode's ~2 kB base prompt. |
| `title: { disable: true }` | Stops the extra LLM call opencode spends on a session title. |
| `compaction: { auto: false }` | Stops the automatic compaction LLM call. |

Measured effect on one request: **≈ 8 000 → ≈ 5 900 prompt tokens**, and the
provider is hit **once** instead of twice.

The proxy additionally creates every session with an explicit title, which is
a second, request-level way to skip opencode's title generation.

### Failing providers fail fast

opencode retries a failing provider internally — 5 retries with a 2 s → 30 s
backoff, so a request would hang for ~90 seconds. The proxy watches opencode's
`session.status` events and aborts the turn as soon as a retry shows up, so a
rate-limited provider returns **HTTP 429 in under a second** instead of
blocking the request.

The number of tolerated retries is configurable via `MAX_RETRY_ATTEMPTS`
(default `1`, i.e. give up at the first retry).

### Abandoned requests are cleaned up

opencode keeps a session for every turn. A client that disconnects mid-request
would leave that session half-finished, so the proxy watches the connection
and deletes the session when the client goes away. Ten dropped connections
leave at most one session behind instead of ten.

Set `DELETE_SESSIONS=true` to delete the session after every request, not
just the abandoned ones.

Aborting a request also poisons opencode's cached instance of the project:
every later request to that directory answers with an empty **499**. The proxy
disposes the instance after an abort to clear that — see
[opencode#58942](https://github.com/anomalyco/opencode/issues/58942).

| Provider problem | HTTP status | `error.code` |
| ---------------- | ----------- | ------------ |
| Free tier / rate limit | `429` | `provider_rate_limited` |
| Missing or invalid credentials | `401` | `provider_unauthorized` |
| Context window exceeded | `413` | `context_too_long` |
| Anything else | `502` | `provider_error` |
| opencode unreachable | `503` | `opencode_unavailable` |
| opencode instance broken | `503` | `opencode_instance_broken` |
| No answer in time | `504` | `timeout` |

When opencode hides the real cause behind a generic message, the proxy passes
its reference on: `Unexpected server error. Check server logs for details.
(opencode reference: err_6719a53a)`. Look that reference up in the opencode
log to find the cause.

---

## Configuration

Configuration lives in `.env` (already included, with the defaults below).
Environment variables always take precedence over the file.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `20128` | Port the proxy listens on. |
| `HOST` | `0.0.0.0` | Interface the proxy binds to. |
| `API_KEY` | `sk-dummy` | Clients must send `Authorization: Bearer <key>`. |
| `SPAWN_OPENCODE` | `true` | Spawn `opencode serve` from `node_modules/.bin`. |
| `OPENCODE_HOST` / `OPENCODE_PORT` | `127.0.0.1` / `4096` | Where the opencode server is. |
| `DEFAULT_MODEL` | *(empty)* | Model used when the client does not send one. |
| `DEFAULT_AGENT` | `proxy` | opencode agent used for proxied requests. |
| `REQUEST_TIMEOUT` | `300` | Seconds a single completion may take. |
| `MAX_RETRY_ATTEMPTS` | `1` | Provider retries opencode may make before the proxy gives up. |
| `MAX_OUTPUT_TOKENS` | `0` | Upper bound on the tokens the model may produce (0 = opencode's default). |
| `DELETE_SESSIONS` | `false` | Delete each opencode session after the request. |
| `LOG_LEVEL` | `silent` | pino log level. `silent` writes no log files. |
| `MODEL_OWNER` | `opencode` | Owner string reported by `/v1/models`. |

See `.env.example` for the annotated list.

---

## Docker

```bash
docker compose up -d
curl http://127.0.0.1:20128/health
```

The image is a slim `node:22-bookworm-slim` build with a `tini` init and a
`HEALTHCHECK`. The opencode state (sessions, provider credentials) lives in
`/data`, so it survives restarts when a volume is mounted on that path.

To authenticate a provider inside the container:

```bash
docker compose exec proxy opencode auth login
```

---

## Deploying on Railway

The repository is Railway-ready out of the box — `railway.json` builds the
Dockerfile and points the health check at `/health`.

1. Push the repository to GitHub.
2. **New Project → Deploy from GitHub repo**.
3. Railway detects the Dockerfile and builds it.
4. In **Variables**, set at least `API_KEY` (and optionally `DEFAULT_MODEL`).
5. Railway injects `PORT`; the proxy honours it.

Railway injects `PORT` at runtime, so no further configuration is needed for
the port. The container listens on `0.0.0.0` so Railway can reach it.

```bash
curl https://<your-domain>/v1/models -H "authorization: Bearer $API_KEY"
```

### Keeping the opencode credentials

The opencode credentials live in `/data`. On Railway the container filesystem
is ephemeral, so a restart would lose them. Attach a **Volume** mounted on
`/data` in the Railway dashboard to keep them:

- **Service → Settings → Volumes → Add Volume**, mount path `/data`.

> **Note** — the Dockerfile deliberately contains **no `VOLUME` instruction**.
> Railway rejects an image whose Dockerfile has one ("The Dockerfile failed
> validation"), so the volume is attached in the dashboard instead. The CI
> workflow checks for this so the instruction cannot come back by accident.

Without a volume you have to authenticate again after every redeploy:

```bash
railway run opencode auth login
```

---

## Using it with other tools

**Any OpenAI SDK**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:20128/v1", api_key="sk-dummy")
print(client.chat.completions.create(
    model="opencode/glm-5.3-flash-free",
    messages=[{"role": "user", "content": "Say hello"}],
).choices[0].message.content)
```

```ts
import OpenAI from "openai"

const client = new OpenAI({ baseURL: "http://127.0.0.1:20128/v1", apiKey: "sk-dummy" })
```

**Cursor / Continue / Cline / Aider** — set the provider's *OpenAI-compatible*
base URL to `http://127.0.0.1:20128/v1`.

**Local tool that wants `/v1` paths only** — the proxy also answers
`/health` and `/v1/health` without an API key.

---

## Development

```bash
pnpm install
pnpm dev     # node --watch src/index.js
pnpm lint    # syntax + style checks, no dependencies
pnpm test    # the test suite
pnpm check   # lint + deployment checks + tests
```

The test suite boots a real opencode server against a **mock OpenAI-compatible
provider**, so it needs no network access and burns no provider quota.

```
test/
  helpers.mjs         mock provider + opencode server harness
  proxy.test.mjs      end-to-end: models, health, chat, streaming, completions
  tools.test.mjs      end-to-end: function-calling emulation
  response-format.test.mjs end-to-end: json_object and json_schema
  conversation.test.mjs end-to-end: multi-turn tool chats, concurrency
  openai-sdk.test.mjs compatibility with the real OpenAI SDK
  errors.test.mjs     end-to-end: rate limits, unreachable servers
  deployment.test.mjs the Dockerfile and railway.json follow Railway's rules
  binary.test.mjs     the opencode binary is found and executable
  registry.test.mjs   unit tests for the model registry
  translator.test.mjs unit tests for the OpenAI <-> opencode translation
```

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

- **test** — the suite on Node.js 20, 22 and 24
- **docker** — builds the image and smoke-tests the container

See [AGENTS.md](AGENTS.md) for the architecture notes and the opencode API
gotchas that are easy to get wrong. Contributions are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the commit message standard.

---

## Layout

```
src/
  index.js            entry point: boots opencode + the proxy
  server.js           Fastify routes
  service.js          orchestration: opencode session -> OpenAI response
  translator.js       OpenAI messages/tools <-> opencode parts/schema
  opencode-client.js  HTTP client for the opencode server
  opencode-server.js  spawns and supervises `opencode serve`
  event-bus.js        multiplexes opencode's global SSE stream
  model-registry.js   opencode catalogue -> OpenAI model list
  config.js           environment configuration + .env loader
scripts/
  lint.js             dependency-free syntax and style checks
  check-dockerfile.mjs checks the Dockerfile against Railway's rules
opencode.json         the tool-less `proxy` agent
.github/workflows/
  ci.yml              tests + container build
Dockerfile            container image
docker-compose.yml    local container setup
railway.json          Railway deployment
```

---

## Troubleshooting

**`opencode binary not found in node_modules/.bin`** — run `pnpm install`.

**`Free usage limit reached`** — the upstream provider's free tier is
exhausted. The proxy surfaces this as HTTP `429` with code
`provider_rate_limited`. Wait, or connect a paid provider in opencode.

**`Model 'x' is not available`** — the model is not in the opencode catalogue
yet. Check `GET /v1/models` and make sure the provider is connected.

**`Invalid API key`** — clients must send `Authorization: Bearer <API_KEY>`.
The default key is `sk-dummy`.

**No output / hangs** — check `~/.local/share/opencode/log/opencode.log`
(`/data/log/opencode.log` in Docker).

---

## License

MIT © Phạm Văn Định
