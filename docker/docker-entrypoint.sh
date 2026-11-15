#!/bin/sh
# Free OpenCode API container entrypoint
# On first boot (no /app/config.json inside the container) the config is generated from `docker run -e`
# environment variables; an existing config.json (e.g. persisted via -v mount) is left untouched. The file is the
# fallback for settings, not an override: index.js reads environment variables first, so `-e KEY=value` applies on
# every start even when the file already holds a different value.
# Supported (written into config.json): PORT API_KEY BIND_HOST OPENCODE_PATH OPENCODE_SERVER_URL OPENCODE_BIND_HOST
# and the two boolean flags, under both their names (DISABLE_TOOLS / OPENCODE_DISABLE_TOOLS,
# USE_ISOLATED_HOME / OPENCODE_USE_ISOLATED_HOME)
# The log level LOG_LEVEL (error/warn/info/debug, case-insensitive) is NOT written into config.json:
#   the node process reads the environment variable directly, so it takes precedence over the LOG_LEVEL field in
#   config.json; when unset it defaults to info
set -e

CONFIG=/app/config.json
LOG_LEVEL_DISPLAY="${LOG_LEVEL:-info}"

if [ ! -f "$CONFIG" ]; then
    # config.json carries the API key: create it readable by the container user only
    umask 077
    node -e '
        const fs = require("fs");
        const env = (k, d) => { const v = process.env[k]; return (v === undefined || v === "") ? d : v; };
        // The first name that is set wins, so both spellings of a flag behave the same as they do in index.js
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
            DISABLE_TOOLS: flag(["DISABLE_TOOLS", "OPENCODE_DISABLE_TOOLS"], "true"),
            OPENCODE_PATH: env("OPENCODE_PATH", ""),
            OPENCODE_SERVER_URL: env("OPENCODE_SERVER_URL", "http://127.0.0.1:4097"),
            OPENCODE_BIND_HOST: env("OPENCODE_BIND_HOST", "0.0.0.0"),
            USE_ISOLATED_HOME: flag(["USE_ISOLATED_HOME", "OPENCODE_USE_ISOLATED_HOME"], "false")
        };
        fs.writeFileSync("/app/config.json", JSON.stringify(cfg, null, 4));
        // The generated config holds the API key, and this line ends up in `docker logs` (collected and shipped as
        // often as not): print where the key came from, never the key itself
        const key = String(cfg.API_KEY);
        const masked = (key.length <= 8 ? "***" : key.slice(0, 3) + "***") + ` (${key.length} chars)`;
        const shown = Object.assign({}, cfg, { API_KEY: masked });
        console.log("[entrypoint] first boot, config generated from env:", JSON.stringify(shown));
        console.log("[entrypoint] log level (LOG_LEVEL env, higher priority than config.json):", env("LOG_LEVEL", "info"));
    '
else
    echo "[entrypoint] /app/config.json exists, keeping it (environment variables still win over the file)"
    echo "[entrypoint] log level (LOG_LEVEL env, higher priority than config.json): $LOG_LEVEL_DISPLAY"
fi

exec "$@"
