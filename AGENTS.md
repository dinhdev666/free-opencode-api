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
pnpm test           # run the test suite (no network, no provider quota needed)
docker compose up -d   # run in a container
```

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
   OpenAI `tool_calls`.

3. **Deny-all breaks structured output.** `permission: { "*": "deny" }` removes
   *every* tool schema — including the internal `StructuredOutput` tool — so
   function calling stops working. Disable the built-in tools by name
   instead: `tools: { bash: false, read: false, … }`.

4. **The title agent costs an extra LLM call.** opencode spends a second
   provider call generating a session title unless the agent is disabled
   (`agent: { title: { disable: true } }`) or the session is created with an
   explicit title. The proxy does both.

5. **Retries are not configurable.** opencode retries a failing provider 5
   times with a 2 s → 30 s backoff (~90 s total). The proxy watches the
   `session.status` event with `type: "retry"` and aborts the turn, so a
   rate-limited provider answers with HTTP 429 in about a second.

6. **The provider request.** With the `proxy` agent, the upstream request
   carries no tool schemas and a short system prompt. Every proxy request must
   cost exactly **one** provider request — `test/proxy.test.mjs` asserts it.

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
