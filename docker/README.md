# Free OpenCode API — Docker Image

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)

Container image of [Free OpenCode API](https://github.com/dinhdev666/free-opencode-api), an OpenAI-compatible gateway
for the OpenCode CLI.

The image bundles Node.js 22, the project source and the OpenCode CLI (npm package `@opencode/cli`, the 2.x line), so
nothing has to be installed on the host; dependencies come from the committed `pnpm-lock.yaml`, installed with **pnpm**
(through Corepack, pinned by the `packageManager` field in `package.json`). Point any OpenAI client at the published
port: `opencode/big-pickle` is the stable alias OpenCode routes to whichever model it serves right now (and the
gateway's default), while concrete model ids rotate — `GET /v1/models` returns what is live.

---

## Image Tag

| Tag | Description |
| --- | --- |
| `dinhdev666/free-opencode-api:latest` | Newest published release — the tag every example below uses |
| `dinhdev666/free-opencode-api:<version>` | The same build pinned to its release number (`<version>` = `version` in `package.json` at publish time) |

`latest` is moved by `docker-publish.yml` on every `v*.*.*` tag, so no example here goes stale after a release. Pin
`:<version>` only when you need one exact build; every release keeps its own number, so a pinned tag never disappears.

Both tags are multi-architecture (`linux/amd64`, `linux/arm64`); Docker pulls the variant matching the host, so no
`--platform` flag is needed on Intel servers or Apple Silicon machines.

---

## Quick Start

```bash
docker pull dinhdev666/free-opencode-api:latest

docker run -d \
  --restart=always \
  --network common-all \
  --name free-opencode-api \
  -e API_KEY=your-secret-key \
  -p 8083:8083 \
  dinhdev666/free-opencode-api:latest
```

The service is then reachable at `http://<your-ip>:8083`. `--network common-all` is optional — it only attaches the
container to an existing user-defined network.

> **Pass `-e API_KEY=…`.** Without it the gateway runs with the built-in key `sk-dummy-123`, which is public: anyone
> who can reach the port can drive your OpenCode installation. `--privileged` is **not** needed and never used here — the
> image needs no extra capability, and the backend runs model-directed tools, so keep them inside the container's
> default isolation. `DISABLE_TOOLS=true` (the image default) denies every tool that can execute something or write a
> file (`edit`, `shell`, `write`, `grep`, `webfetch`, `task`, …); the read-only `read` and `glob` stay allowed, because
> denying either makes the backend hang on a free zen model (see **Fix 1** below).
>
> The defaults also combine that key with `BIND_HOST=0.0.0.0` (every interface inside the container, so a published port
> reaches it); a **first boot** using both writes one `[entrypoint] WARNING` line to `docker logs`. The defaults are
> unchanged — a different one would break every existing `docker run` — and the line warns rather than refuses: set
> `-e API_KEY=…` and publish the port only on a trusted network.

---

## Running as a Non-Root User

The image does not run as root: [`docker/Dockerfile`](Dockerfile) ends with `USER node`, so the gateway, the
`opencode serve` backend it spawns and every tool that backend runs are the unprivileged `node` user of the official
Node.js base image — **uid/gid `1000`**. The CLI is installed as root at build time
(`npm install -g "@opencode/cli@${OPENCODE_VERSION}"`, `2.3.2` by default) and `/app` is handed to `node:node`, because
the entrypoint writes `/app/config.json` there on first boot.

| Situation | Effect |
| --- | --- |
| `docker exec free-opencode-api stat -c '%a %U' /app/config.json` | Works — `docker exec` also joins as `node`, and the generated file belongs to that user (`600 node`) |
| A bind-mounted `config.json` | Must be **readable by uid 1000**. Otherwise the container stops with `[Config] config.json cannot be read: EACCES: …` instead of starting with the built-in key. `chmod 0644` or `chown 1000` it — the key it holds is readable by that uid anyway |
| A bind-mounted OpenCode credentials/state directory | Must be readable **and writable** by uid 1000, because `opencode` keeps writing there: `chown -R 1000:1000 ~/.local/share/opencode` on the host, or let the container create it (option 1 below) |
| Any other mounted directory | Must be writable by uid 1000; the writable locations inside the image are `HOME` = `/home/node`, `/app` and the temp directory |
| `docker run --rm --entrypoint id <image>` | Prints `uid=1000(node) gid=1000(node) groups=1000(node)`; CI fails the build when the uid is `0` |

Because the user is `node`, `HOME` is **`/home/node`**, not `/root`, and `opencode` writes its state under
`/home/node/.local/...` — see below for mounting host credentials.

---

## OpenCode Authentication

The OpenCode CLI inside the container must be authenticated before it can call model providers. Pick one option.

**Option 1 — log in inside the container** (follow the prompts to pick a provider and authorize):

```bash
docker exec -it free-opencode-api opencode auth login
```

**Option 2 — mount credentials already created on the host** (`~` is the host user's home; the container runs as uid
1000, so `HOME` is `/home/node` and the mounted directory must be readable *and writable* by that uid — `sudo chown -R
1000:1000 ~/.local/share/opencode` once, see [Running as a Non-Root User](#running-as-a-non-root-user)):

```bash
docker run -d \
  --restart=always \
  --network common-all \
  --name free-opencode-api \
  -e API_KEY=your-secret-key \
  -p 8083:8083 \
  -v ~/.local/share/opencode:/home/node/.local/share/opencode \
  dinhdev666/free-opencode-api:latest
```

---

## API Self-Check

`/health` is the only unauthenticated route besides `/`:

```bash
curl http://127.0.0.1:8083/health
```

The image also declares a `HEALTHCHECK` calling the same endpoint (it follows `-e PORT=…`), so `docker ps` shows
`healthy` once the gateway is listening:

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
```

Models, then a non-streaming chat completion. `sk-dummy-123` is the built-in default key; the container never runs
without authentication.

```bash
curl -H "Authorization: Bearer sk-dummy-123" http://127.0.0.1:8083/v1/models

curl -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-dummy-123" \
  -d '{"model":"opencode/big-pickle","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

---

## Configuration

Nothing is baked in at build time. The gateway reads **environment variables first, then `/app/config.json`, then the
built-in defaults**, so `docker run -e KEY=value` always applies. On the container's **first boot** (no
`/app/config.json`) the entrypoint `docker-entrypoint.sh` also writes the `-e` values into `/app/config.json`, so the
container carries a readable record of what it was started with and keeps working if it is later started without them.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8083` | Gateway listen port |
| `API_KEY` | `sk-dummy-123` | Gateway auth key; mandatory — an empty value falls back to the default key instead of disabling authentication |
| `BIND_HOST` | `0.0.0.0` | Must listen on `0.0.0.0` inside the container for port mapping to work (program default is `127.0.0.1`; the entrypoint overrides it) |
| `DISABLE_TOOLS` (or `OPENCODE_DISABLE_TOOLS`) | `true` | Denies OpenCode tool calls so the model cannot run commands or modify files (`1`, `true`, `yes`, `y`, `on` on; `0`, `false`, `no`, `n`, `off` off). The `OPENCODE_`-prefixed spelling wins when both are set |
| `OPENCODE_PATH` | `opencode` | Path to the `opencode` executable; a bare name resolves through `PATH` (the npm global install puts it at `/usr/local/bin/opencode`), and the program also probes `~/.opencode/bin` and the npm/pnpm global directories. The CLI version is pinned at build time, so the name resolves to the bundled `2.3.2` |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4097` | Address of the OpenCode backend the gateway launches internally; rarely changed (a trailing slash is stripped) |
| `OPENCODE_SERVER_PASSWORD` | unset (generated per process) | Password for the backend's HTTP Basic auth (username `opencode`), passed to `opencode serve` under the same name — 2.x authenticates every `/api/*` route, so a child with no password answers `401` to every call. Set it yourself only when `OPENCODE_SERVER_URL` points at a **separate** 2.x server, which needs the same value. Never printed: the first-boot dump masks it |
| `OPENCODE_USE_ISOLATED_HOME` (or `USE_ISOLATED_HOME`) | unset | Runs the backend with a throwaway `HOME` inside the container (rarely needed — the container is already isolated) |
| `OPENCODE_BIND_HOST` | `127.0.0.1` | Listen address of the OpenCode backend (4097). Loopback by default: publishing it puts the OpenCode API and its web UI outside the gateway, the only thing that checks a key, applies the queue limits and strips tool markup. Set `0.0.0.0` to serve it outside the container — see [Exposing the 4097 Backend Port](#exposing-the-4097-backend-port) |
| `OPENCODE_PROXY_BIND_HOST` | unset | Alias for `BIND_HOST`, read only when `BIND_HOST` is absent (program default `127.0.0.1`); environment only — in `config.json` only `BIND_HOST` exists |
| `OPENCODE_PROXY_DEBUG` | unset | Turns on debug logging **when no explicit `LOG_LEVEL` is set**; an explicit level wins and the switch is ignored with a `[Config]` warning. This is the **environment** name (in `config.json` the same switch is `DEBUG`, and the variable `DEBUG` has no effect); `LOG_LEVEL=debug` is the documented way |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` (case-insensitive; invalid values fall back to `info` with a warning). **Never written into `config.json`** — it still follows the normal precedence, but the entrypoint does not copy it into the generated file. See [Logging](#logging) |

Example with a custom API key (authentication is always on; omitting `API_KEY` uses `sk-dummy-123`):

```sh
docker run -d --restart=always --network common-all --name free-opencode-api -p 8083:8083 \
  -e PORT=8083 -e API_KEY=your-key -e DISABLE_TOOLS=true \
  dinhdev666/free-opencode-api:latest
```

> Advanced tuning variables (`OPENCODE_PROXY_REQUEST_TIMEOUT_MS`, `OPENCODE_PROXY_HEALTH_CACHE_MS`,
> `OPENCODE_PROXY_START_RETRY_MS`, `OPENCODE_PROXY_MAX_CONCURRENCY`, `OPENCODE_PROXY_MAX_QUEUE`,
> `OPENCODE_PROXY_MAX_BODY_MB`) are read from the environment or from `config.json` and documented in the main
> [README](../README.md#configuration).

### Precedence rules

- **Environment > `config.json` > built-in defaults** for every key. `-e KEY=value` therefore applies on **every**
  start, mounted `config.json` included: the file is the fallback, never an override.
- The entrypoint writes the `-e` values into `/app/config.json` **only when that file is missing**. On later starts the
  stored file is untouched, so after changing `-e` values it can disagree with the running gateway; delete it (or drop
  the `-v` mount) and recreate the container to make the stored copy match again.
- **`LOG_LEVEL` is the exception on the write path**: it is never copied into `config.json`. It still follows the normal
  precedence (environment, then the `LOG_LEVEL` field of an existing file, then `info`); the image sets no
  `ENV LOG_LEVEL`, precisely so a value in the file stays reachable.
- The generated file is written through a temporary file and an atomic `rename`, mode `0600`: a container killed
  mid-write cannot leave a truncated `config.json` behind, which used to make every later start exit with "is not valid
  JSON" until a human deleted it.
- The first-boot line in `docker logs` shows the generated settings with the **API key masked** (`sk-a***(22 chars)`,
  nothing but its length up to 16 characters — the same rule the in-process logger uses) and a credential in
  `OPENCODE_SERVER_URL` masked the same way (`http://***@host:4097`, `?token=***`). The file itself is `0600`, owned by
  `node` (uid 1000), and holds the real key, but container logs are usually collected, so the key must never be printed.
  The startup `[Security]` warning still names the built-in `sk-dummy-123` when it is in use.
- A `config.json` that exists but is invalid, or holds a value of the wrong type for a known key (`"API_KEY": true`, an
  object where a string belongs), stops the container with a message naming the key instead of silently running with the
  built-in key or a stringified value (a boolean `API_KEY` would make the literal word `true` the credential). A UTF-8
  BOM is tolerated; the file must be a regular file of at most 1 MiB (a symbolic link or a FIFO is refused by name).
- The image's own defaults (used when generating `config.json`) differ from the program defaults for the container:
  `BIND_HOST=0.0.0.0` and `DISABLE_TOOLS=true`. `OPENCODE_BIND_HOST` keeps the program default `127.0.0.1`.

---

## Logging

All logs go to stdout/stderr (visible through `docker logs`), prefixed with `[gateway]`:

```text
[gateway] <ISO time> [LEVEL] message {"detail":"json"}
```

`error`/`warn` are written to stderr, `info`/`debug` to stdout. Control verbosity with
`docker run -e LOG_LEVEL=<level>` (case-insensitive; invalid values fall back to `info` with a warning; the image
default is `info`):

```bash
docker run -d --restart=always --name free-opencode-api -p 8083:8083 -e LOG_LEVEL=debug dinhdev666/free-opencode-api:latest
```

| Level | Output |
| --- | --- |
| `error` | Upstream (`opencode serve`, 4097) request failures with status code and error-body summary — always emitted — plus fatal startup problems |
| `warn` | Invalid `LOG_LEVEL` fallbacks and self-recoverable anomalies |
| `info` (default) | Startup information and **a one-line summary per OpenAI request**: method, path, model, streaming, status, latency in ms, request id (all lines for one request share that id). Non-`/v1/` paths such as `/health` are logged at `debug` only, to avoid noise |
| `debug` | Adds inbound requests (sensitive headers masked), the **final payload** sent to `opencode serve`, and full responses (complete JSON when not streaming; for SSE an end-of-stream summary: chunk count, text length, `finish_reason`) |

Example output:

```text
# info — startup, then one line per request
[gateway] 2026-11-06T12:00:05.456Z [INFO] POST /v1/chat/completions -> 200 3210ms [gw-m1abc2x3] model=opencode/example-model-a stream=true
# debug — adds the request, the upstream payload and the stream/response summary
[gateway] 2026-11-06T12:00:05.460Z [DEBUG] SSE stream summary {"reqId":"gw-m1abc2x3","chunks":12,"contentChars":866,"finishReason":"stop","clientGone":false}
# error — always emitted on an upstream failure
[gateway] 2026-11-06T12:01:00.000Z [ERROR] [Proxy] API Error (upstream call failed) {"reqId":"gw-o7ghi8z9","message":"Request timeout after 300000ms","status":null,"bodySummary":null}
```

---

## Stopping the Container

`docker stop` sends `SIGTERM`, and the gateway uses it to finish what it is doing: requests still waiting for a
completion slot are answered `503 gateway_shutting_down` (`Retry-After: 1`) instead of being dropped, responses already
streaming finish, and the `opencode serve` child is stopped and its leftover sessions deleted before the process exits.
That teardown is bounded — a 6 s connection watchdog plus an 8 s teardown budget, with a hard exit 10 s after it starts.

**Docker's default is 10 s**, shorter than that worst case: the runtime sends `SIGKILL` while the gateway is still
draining, and a client's stream ends in a reset instead of the documented refusal. Allow more:

```bash
docker run -d --name free-opencode-api --stop-timeout=20 -p 8083:8083 dinhdev666/free-opencode-api:latest
```

Compose uses a different key for the same thing:

```yaml
services:
  free-opencode-api:
    image: dinhdev666/free-opencode-api:latest
    stop_grace_period: 20s
```

Swarm services take `stop_grace_period` in the service definition; Kubernetes uses
`terminationGracePeriodSeconds: 20` (its default is 30, so only a lowered value needs attention).

---

## Exposing the 4097 Backend Port

When the gateway (8083) starts it launches the `opencode serve` backend (4097) inside the container. Its listen address
comes from `OPENCODE_BIND_HOST` and defaults to `127.0.0.1` — loopback only, unreachable from outside the container.
That is deliberate: 2.x authenticates the backend's `/api/*` routes (HTTP Basic, with a password the gateway generates
per container and keeps to itself), but publishing 4097 still hands the OpenCode API and its web UI to the network while
the gateway's key, queue limits and tool guard stay on the side that is no longer in the path.

To reach 4097 from outside, set the address *and* publish the port:

```bash
docker run -d \
  --restart=always \
  --network common-all \
  --name free-opencode-api \
  -e API_KEY=your-secret-key \
  -e OPENCODE_BIND_HOST=0.0.0.0 \
  -p 8083:8083 \
  -p 4097:4097 \
  dinhdev666/free-opencode-api:latest
```

Notes:

- `OPENCODE_BIND_HOST` controls the backend (4097) only; the gateway's own listen address (8083) is `BIND_HOST`. The two
  are independent.
- The gateway always reaches the backend through `OPENCODE_SERVER_URL` (default `http://127.0.0.1:4097`);
  `OPENCODE_BIND_HOST=0.0.0.0` does not change gateway-to-backend traffic inside the container, since `0.0.0.0` also
  covers loopback.
- To return to container-only access, set `OPENCODE_BIND_HOST=127.0.0.1`.
- `-e OPENCODE_BIND_HOST=…` works on an existing container as well (environment beats `config.json`, see
  [Precedence rules](#precedence-rules)); a mounted `config.json` only decides what happens when the variable is absent,
  so set `OPENCODE_BIND_HOST` there too if it must survive a start without the flag.

---

## Known Issues and Compatibility Fixes

Two OpenCode 2.x behaviour differences are handled in [`src/proxy.js`](../src/proxy.js) of the source repository, not
patched inside the image: the image builds straight from the repository and the Dockerfile contains no runtime patching.

**Fix 1 — tool hang.** With 2.x and the free zen models, `DISABLE_TOOLS=true` (the image default) denies every tool
action when the session is created, and as soon as either `read` or `glob` is denied the prompt hangs forever and the
gateway never returns content. The fix denies the whole action set first (`edit`, `shell`, `write`, `grep`, `webfetch`,
`websearch`, `subagent`, `external_directory`, `question`, `skill`, `task`, `todowrite`, `todoread`, `lsp`, `browser`,
`patch`, `multiedit`, `invalid`), then `deny *` so an action a newer server grows is covered too, and re-allows exactly
`read` and `glob` **last**. Both are read-only with no write or execution capability; `stripFunctionCalls` output
filtering plus the `TOOL_GUARD_MESSAGE` prompt text are a second line of defense.

**Fix 2 — streaming SSE compatibility.** In 2.x the stream names the kind in `type` (dot-separated: `session.text.delta`,
`session.reasoning.delta`, `session.text.ended`, `session.step.ended`, …) and the payload in `data`. A `*.delta` event
carries a real `delta`, but the closing `session.text.ended` / `session.reasoning.ended` events carry **no `delta` at
all** — only the part's whole `text` — so reading the increment from `event.properties.delta` yielded `undefined` on
every closing event and a stream carried no content, only a finish chunk. Worse, a fast assistant finish delivers
`session.step.ended` (finish=stop) before the 4 s first-chunk timer, resolving the collector early with empty content —
a path the noData/idleTimeout fallbacks never covered. The fix takes `data.delta` when it is a string and otherwise
derives the increment from the part it came from: `snapshotDelta()` remembers that part's previous `text` and returns
what the new snapshot appended, with a length check plus a 32-character head and tail window (comparing against the whole
accumulated answer instead re-sent every part of a multi-part message on every event, and the full `startsWith` compare
cost O(answer) per event). When nothing has been streamed at all it polls `pollForAssistantResponse` once for the full
reply (filtered through `stripFunctionCalls`) and emits no delta if polling is empty too.

---

## Publishing a Release

The image is published by `.github/workflows/docker-publish.yml`. Pushing a version tag builds `linux/amd64` +
`linux/arm64` and pushes the version tag and `latest` (whole versions only — no floating `1` or `1.2`):

```bash
# the tag must equal "version" in package.json; the workflow fails otherwise
git tag vX.Y.Z
git push origin vX.Y.Z
```

The publish job is guarded by `if: startsWith(github.ref, 'refs/tags/v')`, so a run started from a branch (a manual
dispatch) stops before it logs in to the registry: only a tag can move `latest`. Two further gates refuse the tag
outright: the tagged commit must already be on `main`, and every check run on it must have concluded `success`,
`skipped` or `neutral`. A tag on a commit CI never ran is refused, so a broken build cannot be published by tagging it.

Every published image carries a **provenance attestation** and an **SBOM** (`provenance: true`, `sbom: true` on
`docker/build-push-action`): `docker buildx imagetools inspect <image>` shows the build's inputs, and a scanner can read
the package list without unpacking the layers.

The workflow needs two repository secrets (Settings → Secrets and variables → Actions): `DOCKERHUB_USERNAME` (the
Docker Hub account) and `DOCKERHUB_TOKEN` (an access token with Read & Write scope, not the account password). Builds
run on GitHub-hosted runners, so no local Docker installation is required.

To publish from this machine instead:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f docker/Dockerfile -t dinhdev666/free-opencode-api:latest --push .
```

The image installs the OpenCode CLI from npm at build time and pins it with `ARG OPENCODE_VERSION`, defaulting to
`2.3.2` — the release the bundled `@opencode/client` (also `2.3.2`) is written against. Do not build with a 1.x version:
that is a different upstream whose `opencode serve` has no `/api/*` route at all, so the container's readiness probe
never passes and every completion answers `502 … backend_unreachable`. Override the pin deliberately with
`--build-arg OPENCODE_VERSION=<2.x version>` and keep it in step with `@opencode/client` in `package.json`; the version
in a running container is available with `docker run --rm <image> opencode --version`.

### Workflow actions are pinned to commit SHAs

Every `uses:` line in `.github/workflows/ci.yml` and `.github/workflows/docker-publish.yml` names a full 40-character
commit SHA with the release in a trailing comment (`uses: docker/build-push-action@10e90e3… # v6.19.2`), because the
publishing workflow leaves a Docker Hub token with write scope on the runner: a retagged major (`@v6`) would be code
nobody reviewed running at a version nobody froze. `ci.yml` enforces it — the step "Workflow actions are pinned to commit
SHAs" fails when any reference is not a 40-character SHA.

Nothing opens these updates automatically: Dependabot is off for this repository (AGENTS.md), so the npm dependencies,
the action pins and the `node` base image are refreshed by hand, as reviewable commits. The npm packages move with
`pnpm up` (a lockfile-only change is enough), an action pin moves as below, and the base image moves by replacing its tag
and digest together.

To update a pin by hand, resolve the commit the tag currently points at (an annotated tag needs one more hop) and
replace the SHA plus its comment:

```bash
repo=docker/build-push-action tag=v6
sha=$(gh api "repos/$repo/git/ref/tags/$tag" --jq '.object.sha')
[ "$(gh api "repos/$repo/git/ref/tags/$tag" --jq '.object.type')" = "tag" ] \
  && sha=$(gh api "repos/$repo/git/tags/$sha" --jq '.object.sha')
echo "$repo@$tag -> $sha"
```

---

## Related Links

- Repository: [dinhdev666/free-opencode-api](https://github.com/dinhdev666/free-opencode-api)
- Project overview: [README.md](../README.md)
- OpenCode: [opencode.ai](https://opencode.ai)
- License: [MIT](../LICENSE)