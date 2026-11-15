#!/bin/sh
# Free OpenCode API container entrypoint
# On first boot (no /app/config.json inside the container) the config is generated from `docker run -e`
# environment variables; an existing config.json (e.g. persisted via -v mount) is used as-is and is not
# overwritten by -e
# Supported (written into config.json): PORT API_KEY BIND_HOST DISABLE_TOOLS OPENCODE_PATH OPENCODE_SERVER_URL OPENCODE_BIND_HOST
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
        // Same truthy values as parseBool in index.js, so `-e DISABLE_TOOLS=yes` means the same inside and outside
        // the container
        const flag = (k, d) => ["1", "true", "yes", "y", "on"].includes(String(env(k, d)).trim().toLowerCase());
        const cfg = {
            PORT: parseInt(env("PORT", "8083"), 10),
            API_KEY: env("API_KEY", "sk-dummy-123"),
            BIND_HOST: env("BIND_HOST", "0.0.0.0"),
            DISABLE_TOOLS: flag("DISABLE_TOOLS", "true"),
            OPENCODE_PATH: env("OPENCODE_PATH", ""),
            OPENCODE_SERVER_URL: env("OPENCODE_SERVER_URL", "http://127.0.0.1:4097"),
            OPENCODE_BIND_HOST: env("OPENCODE_BIND_HOST", "0.0.0.0")
        };
        fs.writeFileSync("/app/config.json", JSON.stringify(cfg, null, 4));
        console.log("[entrypoint] first boot, config generated from env:", JSON.stringify(cfg));
        console.log("[entrypoint] log level (LOG_LEVEL env, higher priority than config.json):", env("LOG_LEVEL", "info"));
    '
else
    echo "[entrypoint] /app/config.json exists, use it as-is (recreate container without the volume to re-apply -e)"
    echo "[entrypoint] log level (LOG_LEVEL env, higher priority than config.json): $LOG_LEVEL_DISPLAY"
fi

exec "$@"
