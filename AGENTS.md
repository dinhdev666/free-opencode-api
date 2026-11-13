# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

**Free OpenCode API** is an **OpenAI-compatible REST API proxy** in front of the
[opencode](https://opencode.ai) CLI. It lets any OpenAI-compatible tool use the
AI models the user is signed in to with opencode.

The proxy does not talk to model providers directly. It talks to opencode's own
HTTP API (`opencode serve`, OpenAPI 3.1 spec at `/doc`).

```
OpenAI client ──HTTP──▶ Fastify proxy ──HTTP──▶ opencode serve ──▶ provider
```

## Hard constraints

These come from the project's requirements — do not change them without being
asked.

| Constraint | Where it lives |
| ---------- | -------------- |
| Fastify only, never Express/Koa/Hono | `src/server.js` |
| pnpm only, never npm/yarn | `package.json`, `pnpm-lock.yaml` |
| opencode is a **project** dependency, never a global install | `package.json` (`opencode-ai`), `src/opencode-server.js` |
| Default port `20128` | `src/config.js` |
| Default API key `sk-dummy`, read from `.env` | `src/config.js`, `.env` |
| No hard-coded model list — always use opencode's live catalogue | `src/model-registry.js` |
| No log files | `src/config.js` (`LOG_LEVEL=silent` by default) |
| Low RAM/CPU: keep the dependency surface minimal | `package.json` |

## Commands

```bash
pnpm install        # install dependencies (also fetches the opencode binary)
pnpm start          # run the proxy (spawns `opencode serve` itself)
pnpm dev            # run with --watch
pnpm lint           # syntax + style checks (no dependencies)
pnpm check:dockerfile # check the Dockerfile against Railway's rules
pnpm test           # run the test suite (no network, no provider quota needed)
pnpm check          # lint + deployment checks + tests
docker compose up -d   # run in a container
```

## Deployment rules

**Railway rejects a Dockerfile that contains a `VOLUME` instruction** — the
build stops during validation with "The Dockerfile failed validation". The
volume has to be attached in the Railway dashboard, mounted on `/data`.

`scripts/check-dockerfile.mjs` and `test/deployment.test.mjs` guard this. Do
not add a `VOLUME` instruction back.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

- **test** — `pnpm lint` + `pnpm check:dockerfile` + `pnpm test` on Node.js 20, 22 and 24
- **docker** — checks the Dockerfile against Railway's rules, builds the image and smoke-tests the container

Keep the matrix green: the code has to run on Node 20 as well.

## Architecture

| File | Responsibility |
| ---- | -------------- |
| `src/index.js` | Entry point: boots opencode, then the proxy. |
| `src/server.js` | Fastify routes (`/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/health`). |
| `src/service.js` | Orchestration: opencode session → OpenAI response. Streaming and non-streaming. |
| `src/translator.js` | OpenAI messages/tools ⇄ opencode parts/JSON Schema. |
| `src/opencode-client.js` | Thin HTTP client for the opencode server. |
| `src/opencode-server.js` | Spawns and supervises `opencode serve` from `node_modules/.bin`. |
| `src/event-bus.js` | Multiplexes opencode's global SSE stream (`GET /event`). |
| `src/model-registry.js` | opencode catalogue → OpenAI model list. |
| `src/config.js` | Environment configuration, `.env` loader. |
| `opencode.json` | The tool-less `proxy` agent that keeps requests cheap. |

## opencode API facts worth remembering

These were established empirically and are easy to get wrong.

1. **Config shape.** opencode 1.19.x reads the **V1** config shape:
   `provider` (singular) and `agent` (singular) with `prompt`, `permission`
   and `tools`. The V2 keys (`providers`, `agents`, `system`, `permissions`)
   either get rejected outright ("V2 permissions are not supported by OpenCode
   V1") or silently drop the V1-only keys. **Never mix V1 and V2 keys in the
   same object** — the V1 keys are silently ignored.

2. **No per-request custom tools.** opencode has no "here are my functions"
   hook. Function calling is emulated on top of opencode's structured output:
   the caller's functions become a JSON Schema, sent as
   `format: { type: "json_schema", schema }`. opencode then advertises an
   internal `StructuredOutput` tool and the answer is converted back into
   OpenAI `tool_calls`. The same mechanism carries OpenAI's `response_format`
   (`json_object` and `json_schema`). Only one schema can be active per
   request — tools win, because a tool call carries the answer.

3. **No per-request sampling parameters.** opencode picks `temperature`,
   `top_p` and `top_k` per model, and has no request field for them. The
   token limit is a server-wide flag
   (`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`), exposed as `MAX_OUTPUT_TOKENS`.

4. **Deny-all breaks structured output.** `permission: { "*": "deny" }` removes
   *every* tool schema — including the internal `StructuredOutput` tool — so
   function calling stops working. Disable the built-in tools by name
   instead: `tools: { bash: false, read: false, … }`.

5. **The title agent costs an extra LLM call.** opencode spends a second
   provider call generating a session title unless the agent is disabled
   (`agent: { title: { disable: true } }`) or the session is created with an
   explicit title. The proxy does both.

6. **Retries are not configurable.** opencode retries a failing provider 5
   times with a 2 s → 30 s backoff (~90 s total). The proxy watches the
   `session.status` event with `type: "retry"` and aborts the turn, so a
   rate-limited provider answers with HTTP 429 in about a second.

7. **The provider request.** With the `proxy` agent, the upstream request
   carries no tool schemas and a short system prompt. Every proxy request must
   cost exactly **one** provider request — `test/proxy.test.mjs` asserts it.

8. **An aborted request poisons the instance.** When the proxy aborts a request
   to opencode, the interrupt leaves opencode's cached per-directory instance
   broken: every later request to that directory answers with an empty **499**.
   The proxy disposes the instance (`POST /instance/dispose?directory=…`)
   after an abort. See
   [opencode#58942](https://github.com/anomalyco/opencode/issues/58942).

9. **The project directory has to be passed.** opencode routes a request to
   the project of the working directory it came from and falls back to the
   server's own directory when the request does not say. The client therefore
   sends `?directory=…` with every session route and the event stream.

## Testing

The suite boots a real opencode server against a mock OpenAI-compatible
provider (`test/helpers.mjs`). It needs no network access and no provider
quota.

```bash
pnpm test
```

When adding behaviour, add a test. The two properties that must never regress:

- one proxy request → exactly one provider request
- a failing provider → a fast, well-shaped error (not a 90 s timeout)

## Style

- ESM, `"type": "module"`, plain JavaScript (no TypeScript, no build step).
- 2-space indentation, double quotes, no semicolons at line ends except where
  the surrounding code uses them (match the file).
- Comments explain *why*, not *what*.
- Prefer the platform API over a dependency: `fetch`, `AbortController`,
  `node:test` — all built in.

## Commits

The project uses Conventional Commits. The full standard, with examples, is
in [CONTRIBUTING.md](CONTRIBUTING.md). In short:

```
<type>(<scope>): <subject>
```

with `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci` or
`chore` as the type. The subject is imperative, in the present tense, under 72
characters, without a trailing period. One commit does one thing.
