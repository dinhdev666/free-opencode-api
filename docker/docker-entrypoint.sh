#!/bin/sh
# Free OpenCode API container entrypoint
# On first boot (no /app/config.json inside the container) the config is generated from `docker run -e`
# environment variables; an existing config.json (e.g. persisted via -v mount) is left untouched. The file is the
# fallback for settings, not an override: index.js reads environment variables first, so `-e KEY=value` applies on
# every start even when the file already holds a different value.
# Supported (written into config.json): PORT API_KEY BIND_HOST OPENCODE_PATH OPENCODE_SERVER_URL OPENCODE_BIND_HOST
# and the two boolean flags, under both their names. In index.js the first *non-blank* value wins, with the
# OPENCODE_-prefixed name first (`flagSource()`/`readFlag()`: a blank `OPENCODE_X=` falls through to `X`), so the
# prefixed spelling wins here too - otherwise the file this script writes and the value the process reads could
# disagree once the variables are no longer set.
# The log level LOG_LEVEL (error/warn/info/debug, case-insensitive) is NOT written into config.json:
#   the node process reads the environment variable directly, so it takes precedence over the LOG_LEVEL field in
#   config.json; when unset it defaults to info
set -eu

CONFIG=/app/config.json
# The level is operator text and this line is a `docker logs` record, so it is normalised before it is printed - the
# same rule `loggableConfigValue()` applies to the gateway's own lines (control characters become '?', the value is
# capped at 128 characters). This script cannot import that helper, so the rule is repeated here.
LOG_LEVEL_DISPLAY=$(printf '%s' "${LOG_LEVEL:-info}" | tr '[:cntrl:]' '?' | cut -c1-128)

if [ -d "$CONFIG" ]; then
    # `-v /some/host/path:/app/config.json` creates a *directory* at that path when the host path does not exist, and
    # the write below then failed with a bare EISDIR stack trace that named no cause
    echo "[entrypoint] ERROR: $CONFIG is a directory. A bind mount of a host path that does not exist is created as a" >&2
    echo "[entrypoint]        directory: create the file on the host first (or mount a directory, not a file)." >&2
    exit 1
fi

if [ ! -f "$CONFIG" ]; then
    # The masking helpers live in src/logger.js and are imported instead of copied: the hand-copied copy of the
    # credential-name list here had already drifted (it missed the `#` separator a raw request target can carry and the
    # `%XX`-encoded parameter names), and a name added to one copy only leaves a secret in one of the two dumps. The
    # module is ESM, so the snippet runs as one (`--input-type=module`) and awaits the import; the path is passed in
    # rather than hardcoded.
    node --input-type=module -e '
        const fs = await import("node:fs");
        const { pathToFileURL } = await import("node:url");
        // A logger that cannot be imported (an image whose /app was rearranged) must not leave the key unmasked: both
        // values are then shown as `***`, which is a coarser rule than maskSecret()/maskBackendUrl() and never a leak.
        let maskSecret = () => "***";
        let maskBackendUrl = () => "***";
        try {
            const helpers = await import(pathToFileURL(process.argv[1]).href);
            maskSecret = helpers.maskSecret;
            maskBackendUrl = helpers.maskBackendUrl;
        } catch (e) {
            console.error("[entrypoint] could not import the logger helpers, masking the whole values instead:", String(e && e.message));
        }
        const env = (k, d) => { const v = process.env[k]; return (v === undefined || v === "") ? d : v; };
        // The OPENCODE_-prefixed name wins, exactly like `process.env.OPENCODE_X ?? process.env.X` in index.js
        const either = (keys, d) => { for (const k of keys) { const v = process.env[k]; if (v !== undefined && v !== "") return v; } return d; };
        // Same truthy values as parseBoolean() in src/proxy.js, so the value written here agrees with what the
        // process reads from the environment (`-e DISABLE_TOOLS=yes` and `-e DISABLE_TOOLS=n` both mean the same
        // thing inside and outside the container)
        const flag = (keys, d) => ["1", "true", "yes", "y", "on"].includes(String(either(keys, d)).trim().toLowerCase());
        const cfg = {
            // Written as text: index.js validates the port and warns about a bad value, so there is one validator
            // rather than a silent parseInt() here and a real check there
            PORT: String(env("PORT", "8083")).trim(),
            API_KEY: env("API_KEY", "sk-dummy-123"),
            BIND_HOST: env("BIND_HOST", "0.0.0.0"),
            DISABLE_TOOLS: flag(["OPENCODE_DISABLE_TOOLS", "DISABLE_TOOLS"], "true"),
            OPENCODE_PATH: env("OPENCODE_PATH", ""),
            OPENCODE_SERVER_URL: env("OPENCODE_SERVER_URL", "http://127.0.0.1:4097"),
            // Loopback by default: `opencode serve` has no authentication of its own, so publishing it on every
            // interface of the container bypasses the gateway that guards it. `-e OPENCODE_BIND_HOST=0.0.0.0` is the
            // documented opt-in for `-p 4097:4097` (docker/README.md).
            OPENCODE_BIND_HOST: env("OPENCODE_BIND_HOST", "127.0.0.1"),
            USE_ISOLATED_HOME: flag(["OPENCODE_USE_ISOLATED_HOME", "USE_ISOLATED_HOME"], "false")
        };
        // Atomic: written to a temporary file and renamed, so a kill during the write cannot leave a truncated
        // config.json behind (which stopped every later start with "is not valid JSON" until a human deleted it).
        // Mode 0600 because the file carries the API key.
        const tmp = "/app/.config.json.tmp";
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 4), { mode: 0o600 });
        fs.renameSync(tmp, "/app/config.json");
        // The generated config holds the API key, and this line ends up in `docker logs` (collected and shipped as
        // often as not): print where the key came from, never the key itself. Same rule as maskSecret() in
        // src/logger.js, which is the same function used here now.
        // The backend URL can carry credentials too (`http://user:secret@host:4097`, a proxy in front of the backend),
        // so it goes through maskBackendUrl() for the same reason.
        const shown = Object.assign({}, cfg, {
            API_KEY: maskSecret(cfg.API_KEY),
            OPENCODE_SERVER_URL: maskBackendUrl(cfg.OPENCODE_SERVER_URL)
        });
        console.log("[entrypoint] first boot, config generated from env:", JSON.stringify(shown));
        // Normalised like the shell branch below, and like loggableConfigValue() in src/proxy.js: one log record.
        const levelShown = String(env("LOG_LEVEL", "info")).replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 128);
        console.log("[entrypoint] log level (LOG_LEVEL env, higher priority than config.json):", levelShown);
    ' /app/src/logger.js
else
    echo "[entrypoint] /app/config.json exists, keeping it (environment variables still win over the file)"
    echo "[entrypoint] log level (LOG_LEVEL env, higher priority than config.json): $LOG_LEVEL_DISPLAY"
fi

if [ "$#" -eq 0 ]; then
    echo "[entrypoint] ERROR: no command to run (the image CMD is 'node index.js')" >&2
    exit 1
fi

exec "$@"
