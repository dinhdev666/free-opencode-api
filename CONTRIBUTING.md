# Contributing to Free OpenCode API

Thanks for taking the time to contribute.

**Free OpenCode API** is an OpenAI-compatible REST API proxy in front of the
[opencode](https://opencode.ai) CLI. It lets any OpenAI-compatible tool use the
AI models you are signed in to with opencode.

---

## Getting started

```bash
pnpm install        # install dependencies (also fetches the opencode binary)
pnpm lint           # syntax and style checks, no dependencies
pnpm test           # run the test suite
pnpm check          # lint + test
pnpm dev            # run the proxy with --watch
```

The test suite boots a real opencode server against a mock OpenAI-compatible
provider, so it needs **no network access and no provider quota**.

Before you open a pull request:

```bash
pnpm check
```

must pass. CI runs the same commands on Node.js 20, 22 and 24, and it also
builds and smoke-tests the container image.

---

## Commit message standard

The project uses [Conventional Commits](https://www.conventionalcommits.org/).
Every commit message follows this shape:

```
<type>(<scope>): <subject>

<body>

<footer>
```

The **subject** is a short imperative summary in the present tense, without a
trailing period. Keep it under 72 characters. The **body** explains *why* the
change was made, wrapped at 72 characters. The **footer** may reference
issues (`Closes #12`) or note breaking changes (`BREAKING CHANGE: ...`).

### Types

| Type | Use it for |
| ---- | ---------- |
| `feat` | A new capability the user can see (a new endpoint, a new option). |
| `fix` | A bug fix. |
| `perf` | A change that makes it faster or lighter. |
| `refactor` | A change that neither fixes a bug nor adds a feature. |
| `docs` | Documentation only. |
| `test` | Tests only. |
| `build` | Build system, dependencies, packaging. |
| `ci` | CI configuration and workflows. |
| `chore` | Anything that does not touch `src/` or `test/` (a rename, a config tidy-up). |

### Scopes

The scope is optional and names the part of the project that changed:

`proxy` · `opencode` · `translator` · `registry` · `config` · `docker` · `ci` ·
`docs` · `deps`

### Examples

```
feat(proxy): add support for the #variant model suffix

Some clients address a model as `provider/model#high`. The variant is now
passed through to opencode instead of being treated as part of the model id.

fix(translator): keep the user prompt out of the streamed content

opencode echoes the user message as a message part. The delta filter now
ignores parts that belong to a user message.

perf(registry): store a compact projection of the catalogue

The opencode catalogue is ~7 MB of JSON with ~9 000 models. Keeping the raw
payload alive cost about 18 MB of heap; the compact projection costs 1.3 MB.

ci: run the tests on Node 20, 22 and 24

docs: describe how the function calling emulation works
```

### One commit, one change

Keep a commit focused. A pull request that does three things is three pull
requests — or at least three commits with a clear separation.

### Language

Write the subject and body in English. A short summary of the change in
another language is welcome in the pull request description.

---

## Pull requests

1. Open an issue first for anything larger than a bug fix, so the approach can
   be agreed on before the work starts.
2. Branch from `main`: `git checkout -b feat/my-change`.
3. Add or update the tests. Two properties must never regress:
   - one proxy request costs **exactly one** provider request,
   - a failing provider fails **fast** with a well-shaped error.
4. Run `pnpm check`.
5. Update `README.md` and `AGENTS.md` when behaviour or configuration changes.
6. Open the pull request and describe what changed and why.

---

## Code style

- ESM, `"type": "module"`, plain JavaScript. No TypeScript, no build step.
- 2-space indentation, double quotes.
- Comments explain *why*, not *what*.
- Prefer the platform API over a dependency: `fetch`, `AbortController`,
  `node:test`, `node:fs` are all built in. The runtime dependency list stays
  at three packages.
- The proxy is silent by default and writes no log files.

---

## The opencode API

opencode's HTTP API has a few sharp edges that are easy to get wrong. They
are documented in [AGENTS.md](AGENTS.md) — read it before touching the
opencode integration. The two that bite most often:

- opencode 1.19.x reads the **V1** config shape (`provider`, `agent`,
  `prompt`, `permission`, `tools`). Mixing V1 and V2 keys in the same object
  silently drops the V1 ones.
- opencode has no per-request custom-tool hook. Function calling is emulated
  on top of its structured output support.

---

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
