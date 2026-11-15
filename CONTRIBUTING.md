# Contributing to Free OpenCode API

Thanks for taking the time to contribute. This document covers the local setup, the rules the project follows, and
the commit/PR conventions this repository enforces by review.

Before changing code, read [`AGENTS.md`](AGENTS.md) — it lists the invariants (mandatory authentication, OpenAI wire
format, English-only docs, pnpm-only dependencies) and the checks expected before a change is considered done.

## Ways to contribute

- **Bug reports** — include the gateway version, Node version, OS, the startup log lines (redact your `API_KEY`), the
  exact request you sent, and the response or error you got.
- **Feature proposals** — open an issue first for anything that adds configuration, routes or dependencies; the
  project intentionally keeps a small surface.
- **Pull requests** — small, focused changes with the verification described in the PR template below.

Out of scope: plugin systems, multi-provider routing layers, alternative server frameworks, or anything whose only
purpose is to disable authentication.

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | `>=20` (developed on Node 26) | ESM-only project, no build step |
| pnpm | `>=12` (`packageManager: pnpm@12.18.0`) | use pnpm, never npm, for this repository |
| OpenCode CLI | **1.x** release | `npm install -g "opencode-ai@1"` (the 2.x `serve` is a different server), or `curl -fsSL https://opencode.ai/install \| bash` followed by `opencode --version`; authenticate with `opencode auth login` |

## Local setup

```bash
git clone https://github.com/dinhdev666/free-opencode-api.git
cd free-opencode-api
pnpm install --frozen-lockfile     # use plain `pnpm install` when you intentionally change dependencies
cp config.json.example config.json  # optional: file-based configuration
pnpm test                           # smoke suite (stub backend, no OpenCode CLI needed)
pnpm start                          # gateway on http://127.0.0.1:8083, backend on :4097
```

Smoke test:

```bash
curl -s http://127.0.0.1:8083/health
curl -s -H 'Authorization: Bearer sk-dummy-123' http://127.0.0.1:8083/v1/models
curl -s -H 'Authorization: Bearer sk-dummy-123' -H 'Content-Type: application/json' \
  -d '{"model":"opencode/big-pickle","messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:8083/v1/chat/completions
```

`sk-dummy-123` is the built-in default key. Authentication is always enforced, so every `/v1` request needs it even
in development.

## Coding conventions

- **ES modules only** (`import`/`export`, `"type": "module"`); no CommonJS, no transpiler.
- **No new dependencies without an issue.** Fastify and the OpenCode SDK are the only runtime dependencies; logging,
  CORS, routing helpers and body handling are in-tree on purpose.
- **Style** — 4-space indentation and semicolons throughout; prefer `const`, prefer `async`/`await` over raw promise
  chains in handlers, and quote strings the way the surrounding file already does. No formatter or linter is
  configured, so consistency with the file you are editing is reviewed by hand.
- **Logging** — always through `src/logger.js`; never `console.log` in `src/` or `index.js`; never log an unmasked
  `authorization` header; expensive debug payloads go behind `logger.isEnabled('debug')`.
- **Errors** — user-facing failures use the OpenAI envelope `{"error":{"message":"…","type":"…"}}`; internal errors
  are logged with context, not swallowed.
- **Configuration** — new settings follow env > `config.json` > default precedence and must also be added to
  `config.json.example`, the README configuration table, and `docker/docker-entrypoint.sh` when containers need them.
- **Backend lifecycle and streaming code** — read the comments in `src/proxy.js` before touching `collectFromEvents`,
  `pollForAssistantResponse`, `ensureBackend` or the SSE branch; those blocks encode fixes for real OpenCode protocol
  quirks.

## Commit messages

This repository follows **[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)**. Commit
messages are written in English, in the imperative mood, and describe the behaviour change — not the file list.

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type** — required, one of the types below.
- **scope** — optional, but expected for anything touching a specific area (see the scope list).
- **subject** — required, lowercase after the colon, imperative ("add", "fix", "remove" — not "added"/"fixes"),
  no trailing period, at most 72 characters including the type and scope.
- **body** — optional, wrapped at 72 characters, explains *why* the change is needed and any behaviour that is not
  obvious from the diff. Reference measured numbers for performance work.
- **footer** — optional, for issue references (`Refs: #12`, `Closes: #34`) and breaking changes.

### Types

| Type | Use for |
| --- | --- |
| `feat` | A user-visible capability or configuration option |
| `fix` | A behaviour correction (bug, wrong status code, broken fallback) |
| `perf` | A change whose purpose is speed or resource usage |
| `refactor` | Internal restructuring without behaviour change |
| `docs` | README, `AGENTS.md`, `CONTRIBUTING.md`, comments, examples |
| `build` | Dependencies, `pnpm-lock.yaml`, Docker image, packaging |
| `ci` | CI workflow changes (`.github/workflows/`) |
| `test` | Adding or fixing tests or verification harnesses |
| `chore` | Maintenance that fits nowhere else (gitignore, formatting) |
| `revert` | Reverting a previous commit, referencing its hash |

### Scopes

`proxy` (routes/handlers), `stream` (SSE and event handling), `backend` (spawn, health, lifecycle), `auth`, `logger`,
`config`, `docker`, `deps`, `docs`, `release`.

### Examples

```
feat(config): add OPENCODE_PROXY_MAX_CONCURRENCY knob

Completion requests are serialised by default. Operators running multiple
independent sessions can now raise the limit without patching the code.
Defaults to 1 so existing behaviour is unchanged.
```

```
fix(stream): stop waiting four seconds when the event stream is silent

opencode >= 1.19 intermittently delivers no message.part.updated events.
Once the prompt call returns, the answer is already pollable, so the
first-delta wait is shortened to ~50 ms. Stream p50 under load drops from
4014 ms to 484 ms with a stub backend.
```

```
perf(backend): cache successful health probes for two seconds

Each chat completion opened a fresh TCP probe. Bursts now share one probe
over a keep-alive socket; non-stream throughput rises from ~1900 to
~3900 req/s.
```

```
docs: document the environment precedence rules

Closes: #41
```

Breaking change (protocol, configuration or behaviour clients depend on):

```
feat(auth)!: require the bearer token on every route

BREAKING CHANGE: /v1/models and /v1/chat/completions no longer accept
unauthenticated requests. A blank API_KEY falls back to sk-dummy-123
instead of disabling authentication.
```

### Rules of thumb

- One logical change per commit; a commit that needs "and" in the subject should probably be split.
- Do not mix formatting churn into a behavioural commit.
- Reference measured evidence (`perf`, and any change to documented benchmarks) in the body.
- Never commit `config.json`, `.env` files, keys or captured customer payloads; the default key may appear in
  documentation, never a real one.
- Rebase or squash into meaningful commits before opening a pull request; "fix typo" and "wip" commits should not
  survive review.

### Enforcement

`test/check-commit-messages.mjs` (`pnpm run check:commits`) applies the rules above to the subject line of every
commit in a range — the type and scope lists, the 72-character limit, a lowercase imperative subject and no trailing
period — and CI runs it on the commits a push or pull request adds. It fails on the commits, not on the process, so a
message over the limit or a scope that is not in the list has to be reworded (`git rebase -i <base>`) before it is
published: rewriting published history also rewrites every commit after it.

A merge commit is checked like any other, because that is where a pull request title lands in `main`. GitHub's
generated `Merge pull request #123 from …` title therefore fails the check; merge with an explicit subject, or squash:

```bash
gh pr merge 123 --squash                                          # subject becomes <pr title> (#123)
gh pr merge 123 --merge --subject "feat(proxy): add the thing (#123)"
```

The trailing `(#123)` counts towards the 72 characters, and neither `gh` nor GitHub warns when the result is over the
limit: `feat(proxy): add the thing that does the other thing (#123)` is a rejected merge subject. A protected `main`
cannot have the message corrected afterwards, so the red check stays in its history. Judge the exact string first:

```bash
node test/check-commit-messages.mjs --subject "feat(proxy): add the thing (#123)"
```

## Branch naming

```
feat/<short-slug>      fix/<short-slug>      perf/<short-slug>
docs/<short-slug>      refactor/<short-slug> chore/<short-slug>
```

Example: `fix/stream-first-delta-fallback`.

## Pull request process

1. Fork (or branch from `main`), keep the change focused.
2. Verify locally — see the checklist below — and describe exactly what you ran.
3. Open the PR with: what changed, why, how it was verified, and any behaviour or configuration that changed.
4. Keep the PR description in English and link the related issue.
5. Reviewers may ask for a benchmark, a log excerpt, or a follow-up documentation change before merging.

### PR checklist

- [ ] `pnpm run check` passes (syntax check for every JavaScript file).
- [ ] `pnpm test` passes; new assertable behaviour is covered in `test/smoke.mjs`.
- [ ] The gateway boots and `GET /health` returns `200`.
- [ ] `/v1/models` returns `401` without a key and `200` with it.
- [ ] Chat completions were exercised both with and without `stream: true`.
- [ ] An invalid body returns `400`; error envelopes still match `{"error":{"message","type"}}`.
- [ ] Auth was not weakened; the default key fallback still applies.
- [ ] New configuration keys are documented (`config.json.example`, README, Docker entrypoint when relevant).
- [ ] Documentation is English-only and updated for any behaviour change.
- [ ] No new dependency was added without prior discussion.
- [ ] If performance is claimed, before/after numbers from `autocannon` are included.
- [ ] Commit messages follow the convention above.

## Testing

`pnpm test` runs `test/smoke.mjs`, which boots `test/stub-opencode.mjs` (a minimal `opencode serve` stand-in) plus the
gateway and asserts the HTTP contract end to end: the root index and health, auth (401 with a missing or wrong key,
with a `type` and `code`), CORS and preflight, the request-id header, model listing and by-id answers (including ids
with several slashes and ids that are not models), 400 validation, the 404 envelope, non-streaming completions, SSE
frames (valid JSON, streamed content and reasoning, the stop and usage frames, `[DONE]`), the failure and fallback
paths (a rejected session, prompt, message poll or event stream), tool-call filtering across delta boundaries, the
queue (a full queue answers `503 queue_full`; an abandoned or stalled stream frees its slot; a request abandoned while
queued never reaches the backend), session cleanup on every path, and clean `SIGINT` shutdown. No OpenCode CLI and no
network access are required. The stub listens on port 4199 and the gateway on 8199 by default; override with
`SMOKE_STUB_PORT` / `SMOKE_PORT` if those are taken. `AGENTS.md` lists the stub's test markers, which is where to
look before adding a case for a new behaviour.

CI (`.github/workflows/ci.yml`) runs `pnpm run check`, the container entrypoint shell check and `pnpm test` on Node
20, 22 and 24, then builds the Docker image, checks that the container answers `/health`, and checks that the image
enforces authentication (`/` open, `/v1/models` 401 without a key and 200 with the built-in key).

When adding behaviour worth protecting, extend `test/stub-opencode.mjs` and `test/smoke.mjs` instead of writing a
one-off script. For exploratory checks a throwaway stub in `/tmp` is fine.

Additional manual checks that CI cannot cover:

- Use a real `opencode serve` for end-to-end verification, since model latency and provider behaviour vary widely.
- When touching streaming, inspect the raw bytes: `data: {…}` frames, a final `finish_reason:"stop"` frame, then
  `data: [DONE]`, with reasoning deltas arriving as `reasoning_content`.
- When touching the backend lifecycle, run with the CLI missing (`OPENCODE_PATH` pointing nowhere): requests must
  fail in milliseconds, not after a multi-minute startup wait.

## Releasing

1. Bump `version` in `package.json` (the workflow fails when it does not match the tag) and merge the change.
2. Tag and push it: `git tag v1.0.1 && git push origin v1.0.1`.
3. `.github/workflows/docker-publish.yml` builds `linux/amd64` + `linux/arm64` and pushes `<version>` and `latest` to
   `dinhdev666/free-opencode-api`. Only whole versions are published: there is no floating `1` or `1.2` tag.
4. Confirm the result on [Docker Hub](https://hub.docker.com/r/dinhdev666/free-opencode-api/tags) and in the
   workflow run.

The publishing job needs the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (access token with Read &
Write scope). Never commit these values.

## Security

- Never weaken or bypass authentication, and never accept an empty `API_KEY` as "auth disabled".
- Do not commit secrets. `config.json` and `.env` files are ignored.
- Treat user-supplied values (model ids, paths, prompts) as untrusted; `OPENCODE_PATH` is spawned as a process, so it
  must never be constructed from request data.
- Report vulnerabilities privately through a GitHub security advisory on
  <https://github.com/dinhdev666/free-opencode-api/security/advisories/new> rather than a public issue.

## License

By contributing you agree that your contribution is licensed under the MIT License of this project
(see [`LICENSE`](LICENSE)), copyright holder `Phạm Văn Định`.
