import {
    startProxy,
    DEFAULT_API_KEY,
    resolveApiKey,
    getQueueLimits,
    normalizeBackendUrl,
    loggableConfigValue,
    readFlag
} from './src/proxy.js';
import { readConfigFile, envOrFile, findUnknownKeys } from './src/config.js';
import { logger, maskBackendUrl } from './src/logger.js';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default configuration
// LOG_LEVEL has no default declared here: when not explicitly configured, undefined is passed through and
// startProxy supplies the fallback (default info, plus the legacy DEBUG switch interlock)
const defaultConfig = {
    PORT: 8083,
    // Authentication is mandatory: this built-in key is used when nothing else is configured
    API_KEY: DEFAULT_API_KEY,
    OPENCODE_SERVER_URL: 'http://127.0.0.1:4097',
    OPENCODE_BIND_HOST: '127.0.0.1',
    OPENCODE_PATH: 'opencode',
    BIND_HOST: '127.0.0.1',
    DISABLE_TOOLS: false,
    USE_ISOLATED_HOME: false
};

// Load config from file. A config.json that exists but cannot be used stops the gateway: continuing with defaults
// would ignore the port and the API key the operator wrote there and serve traffic with the built-in dummy key.
const configPath = path.join(__dirname, 'config.json');
const { config: fileConfig, error: configError } = readConfigFile(configPath);
if (configError) {
    logger.error(`[Config] config.json ${configError}`);
    logger.error('[Config] Fix or remove the file, then start the gateway again.');
    process.exit(1);
}
const configPathLoaded = fs.existsSync(configPath);
// A key the gateway never reads is a typo or a key from another tool: naming it (and the key it probably meant) is the
// difference between "my setting had no effect" and finding the misspelling. The value itself is never printed - a
// mistyped API_KEY is still a credential.
// One log line is one record, the same rule the client-controlled ids follow in src/proxy.js: a key with a control
// character or a kilobyte of text must not break or bloat the line
const loggableKey = (key) => String(key).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 64);
const unknownConfigKeys = findUnknownKeys(fileConfig);
if (unknownConfigKeys.length > 0) {
    const shown = unknownConfigKeys.slice(0, 5);
    for (const { key, suggestion } of shown) {
        logger.warn(`[Config] config.json has an unknown key '${loggableKey(key)}'` +
            `${suggestion ? ` (did you mean '${suggestion}'?)` : ''} - it is ignored`);
    }
    if (unknownConfigKeys.length > shown.length) {
        logger.warn(`[Config] config.json has ${unknownConfigKeys.length - shown.length} more unknown key(s)`);
    }
}
// Merge configs: env > file > default
// Note: by design LOG_LEVEL takes env over the config.json logLevel field (same merge direction as the other keys
// below, where env comes first)
// A port must be digits only: parseInt('8083abc') is 8083, so a typo used to be accepted silently while the operator
// believed the gateway listened where they asked. A blank environment value counts as unset (`envOrFile`), so a unit
// file's `Environment=PORT=` no longer hides the port written in config.json.
const rawPort = String(envOrFile(process.env, 'PORT', fileConfig.PORT) ?? '').trim();
const portIsValid = /^\d{1,5}$/.test(rawPort) && Number(rawPort) > 0 && Number(rawPort) < 65536;
const parsedPort = portIsValid ? Number(rawPort) : defaultConfig.PORT;
// Warn only when a value was actually configured: a blank variable is "not configured", so there is nothing to report
if (!portIsValid && rawPort !== '') {
    logger.warn(`[Config] PORT '${rawPort}' is not a valid TCP port (1-65535), falling back to ${defaultConfig.PORT}`);
}

// The raw value of each flag has to survive until it is read: `parseBoolean()` collapses an unusable value into the
// fallback, so the warning below needs the operator's own text and the name they used (an environment variable or a
// config.json key). A blank value counts as unset, like every other key.
const flagSource = (envNames, fileKey) => {
    for (const name of envNames) {
        const envValue = process.env[name];
        if (envValue !== undefined && String(envValue).trim() !== '') return { label: name, value: envValue };
    }
    const fileValue = fileConfig[fileKey];
    if (fileValue !== undefined && fileValue !== null && String(fileValue).trim() !== '') {
        return { label: `config.json ${fileKey}`, value: fileValue };
    }
    return { label: fileKey, value: undefined };
};
const disableToolsSource = flagSource(['OPENCODE_DISABLE_TOOLS', 'DISABLE_TOOLS'], 'DISABLE_TOOLS');
const isolatedHomeSource = flagSource(['OPENCODE_USE_ISOLATED_HOME', 'USE_ISOLATED_HOME'], 'USE_ISOLATED_HOME');
const debugSource = flagSource(['OPENCODE_PROXY_DEBUG'], 'DEBUG');

const finalConfig = {
    PORT: portIsValid ? parsedPort : defaultConfig.PORT,
    // Never empty: an unset/blank API_KEY falls back to the built-in default (authentication stays on). A blank
    // environment value counts as unset, so `-e API_KEY=` cannot replace a key written in config.json with the public
    // default one
    API_KEY: resolveApiKey(envOrFile(process.env, 'API_KEY', fileConfig.API_KEY) ?? defaultConfig.API_KEY),
    OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL || fileConfig.OPENCODE_SERVER_URL || defaultConfig.OPENCODE_SERVER_URL,
    OPENCODE_BIND_HOST: process.env.OPENCODE_BIND_HOST || fileConfig.OPENCODE_BIND_HOST || defaultConfig.OPENCODE_BIND_HOST,
    OPENCODE_PATH: process.env.OPENCODE_PATH || fileConfig.OPENCODE_PATH || defaultConfig.OPENCODE_PATH,
    // `OPENCODE_PROXY_BIND_HOST` is documented as an alias, and it is the only one that used to be dead: startProxy()
    // reads it only when no BIND_HOST is passed, and this line always passed one, so setting it changed nothing while
    // the README advertised it.
    BIND_HOST: process.env.BIND_HOST || fileConfig.BIND_HOST || process.env.OPENCODE_PROXY_BIND_HOST || defaultConfig.BIND_HOST,
    // The legacy OPENCODE_-prefixed name keeps working; the bare name matches every other key and the container's
    // `-e DISABLE_TOOLS=...` flag
    DISABLE_TOOLS: readFlag(disableToolsSource.label, disableToolsSource.value, defaultConfig.DISABLE_TOOLS),
    // Run the backend under an isolated HOME (a throwaway directory instead of the real one). The legacy
    // OPENCODE_-prefixed environment variable keeps working
    USE_ISOLATED_HOME: readFlag(isolatedHomeSource.label, isolatedHomeSource.value, defaultConfig.USE_ISOLATED_HOME),
    // LOG_LEVEL: env takes precedence over config.json; when neither is explicitly set, undefined is passed
    // through and startProxy falls back to the default info while keeping the legacy DEBUG -> debug level interlock
    LOG_LEVEL: process.env.LOG_LEVEL || fileConfig.LOG_LEVEL || undefined,
    // Legacy switch, still honoured (also read by startProxy); a service manager may set it on a version that predates
    // LOG_LEVEL
    DEBUG: readFlag(debugSource.label, debugSource.value, false),
    // Tuning keys with no default here: startProxy() resolves them (environment first, then these file values, then its
    // own default) so a value written in config.json takes effect instead of being ignored in silence
    OPENCODE_PROXY_MAX_CONCURRENCY: fileConfig.OPENCODE_PROXY_MAX_CONCURRENCY,
    OPENCODE_PROXY_MAX_QUEUE: fileConfig.OPENCODE_PROXY_MAX_QUEUE,
    OPENCODE_PROXY_MAX_BODY_MB: fileConfig.OPENCODE_PROXY_MAX_BODY_MB,
    OPENCODE_PROXY_REQUEST_TIMEOUT_MS: fileConfig.OPENCODE_PROXY_REQUEST_TIMEOUT_MS,
    OPENCODE_PROXY_HEALTH_CACHE_MS: fileConfig.OPENCODE_PROXY_HEALTH_CACHE_MS,
    OPENCODE_PROXY_START_RETRY_MS: fileConfig.OPENCODE_PROXY_START_RETRY_MS
};

// Apply the resolved level before the startup summary: a LOG_LEVEL coming from config.json used to be applied only
// inside startProxy(), which runs after this banner, so `LOG_LEVEL: "error"` still printed every info line of it.
// startProxy() keeps ownership of the fallback warning for an invalid value, so nothing is reported twice here.
const startupLevel = logger.setLevel(finalConfig.LOG_LEVEL);
if (!startupLevel.explicit && finalConfig.DEBUG) logger.setLevel('debug');

// Reported after the level is applied, so `LOG_LEVEL: "error"` in config.json silences the note about that file too.
// The "wrong directory" warning is a warning: it stays visible at every level, which is the point of warning about it.
if (configPathLoaded) {
    logger.info('[Config] Loaded from config.json');
} else {
    // The file is read from the application directory, not from the working directory: a `config.json` written next to
    // the shell's cwd is silently ignored, and the startup summary (port, key) is the only hint that it was not read.
    const cwdConfigPath = path.join(process.cwd(), 'config.json');
    if (path.resolve(cwdConfigPath) !== path.resolve(configPath) && fs.existsSync(cwdConfigPath)) {
        logger.warn(`[Config] config.json is read from ${configPath}; the file at ${cwdConfigPath} is ignored`);
    }
}

if (finalConfig.API_KEY === DEFAULT_API_KEY) {
    // The default key is public, and the CORS set is `Access-Control-Allow-Origin: *` with no Origin check by
    // contract, so any page the browser loads - or a DNS-rebinding host - can preflight, send that key and read the
    // answers of the local agent. The bind address is the other half of that exposure and was printed on its own
    // line, so neither line named the combination. One line an operator can act on.
    logger.warn(
        `[Security] API_KEY is not configured, using the built-in default '${DEFAULT_API_KEY}'. Set API_KEY for production use. ` +
        `The built-in key is public and the CORS headers allow any origin, so any web page can use this gateway; ` +
        `it listens on ${finalConfig.BIND_HOST}:${finalConfig.PORT} - keep that on 127.0.0.1 or set a real key.`
    );
}

// Validate required configuration
if (!finalConfig.OPENCODE_PATH) {
    logger.error('[Error] OPENCODE_PATH is not set. Please configure it in config.json or environment variable.');
    process.exit(1);
}

// The CLI check and its version are a warning at most, so they run *after* the server is listening (see
// probeOpencodeVersion below): the synchronous probe sat here and spent up to its whole 5 s timeout before the gateway
// bound - a wrapper script that waits for input, a cold npm shim - and during that window the process had not
// installed its signal handlers yet, so Ctrl-C killed it abruptly instead of shutting it down. execFile (no shell)
// keeps a path with quotes or spaces intact and cannot be turned into a shell command.

// The backend URL is normalised before the summary is printed, and its correction notes are emitted here rather than
// from startProxy(): the summary is where an operator copies the value from (a `/health` check, a container inspect,
// a bug report), and it printed the raw form - `http://host:4097/` or a value with a trailing space - while the
// gateway used the trimmed, slash-free one. A note that contradicts the line above it is worse than no note, and the
// trailing slash is exactly the `//session` 404 the normalisation exists to prevent. startProxy() normalises what it
// is handed once more, which is a no-op for an already-normalised value and keeps it correct for an embedder.
const normalisedBackendUrl = normalizeBackendUrl(finalConfig.OPENCODE_SERVER_URL);
finalConfig.OPENCODE_SERVER_URL = normalisedBackendUrl.url;
normalisedBackendUrl.notes.forEach((note) => logger.warn(`[Config] ${note}`));

logger.info('[Config] Starting with configuration:');
logger.info(`  - Port: ${finalConfig.PORT}`);
logger.info(`  - Bind Host: ${loggableConfigValue(finalConfig.BIND_HOST)}`);
logger.info(`  - Backend: ${maskBackendUrl(finalConfig.OPENCODE_SERVER_URL)}`);
logger.info(`  - Bind Host for OpenCode backend: ${loggableConfigValue(finalConfig.OPENCODE_BIND_HOST)}`);
logger.info(`  - OpenCode Path: ${loggableConfigValue(finalConfig.OPENCODE_PATH)}`);
logger.info(`  - API Key: ${finalConfig.API_KEY === DEFAULT_API_KEY ? `default (${DEFAULT_API_KEY})` : 'custom'} - authentication always enforced`);
logger.info(`  - Disable Tools: ${finalConfig.DISABLE_TOOLS ? 'Yes' : 'No'}`);
logger.info(`  - Isolated HOME for OpenCode: ${finalConfig.USE_ISOLATED_HOME ? 'Yes' : 'No'}`);
logger.info(`  - Log Level (requested): ${loggableConfigValue(finalConfig.LOG_LEVEL || 'info (default)')}`);
const queueLimits = getQueueLimits(finalConfig);
logger.info(`  - Concurrency: ${queueLimits.concurrency} completion(s) processed in parallel`);
logger.info(`  - Wait queue: ${queueLimits.queue} waiting completion(s) before 503 queue_full`);
// The clamp/typo warnings for these two keys are emitted by startProxy(), which owns that resolution: warning here too
// printed every note twice.

// Reads the CLI version beside the running server. The major version decides whether the API this gateway drives
// exists at all: a 2.x `opencode serve` is the web UI, answers /health with HTML and rejects POST /session, so every
// completion fails with a 502 whose message names only the status. Saying it at startup puts the cause in front of the
// operator before the first request instead. A probe that cannot answer (no binary, a wrapper that never returns) is
// reported the same way it always was - as a warning, never as a reason not to serve.
function probeOpencodeVersion(binPath) {
    return new Promise((resolve) => {
        // The version probe is still a child of this gateway: it gets the same scrubbed environment the backend
        // spawn uses, so the gateway's own key is not inherited by a CLI that has no use for it.
        const env = { ...process.env };
        delete env.API_KEY;
        delete env.OPENCODE_PROXY_DEBUG;
        execFile(binPath, ['--version'], { timeout: 5000, encoding: 'utf8', env }, (error, stdout) => {
            if (error) {
                resolve({ error });
                return;
            }
            resolve({ version: (String(stdout).match(/\d+\.\d+\.\d+/) || [])[0] || null });
        });
    });
}

function reportOpencodeVersion(result) {
    if (result.error) {
        logger.warn(`[Warning] Cannot verify OpenCode installation: ${loggableConfigValue(finalConfig.OPENCODE_PATH)}`);
        logger.warn('[Warning] Please ensure OpenCode is installed (a 1.x release is required):');
        logger.warn('  Windows: npm install -g "opencode-ai@1"');
        logger.warn('  Linux/macOS: curl -fsSL https://opencode.ai/install | bash  (then check `opencode --version`)');
        logger.warn('[Warning] Or specify the full path in config.json:');
        logger.warn('  { "OPENCODE_PATH": "C:\\\\Users\\\\YourName\\\\AppData\\\\Roaming\\\\npm\\\\opencode.cmd" }');
        return;
    }
    const version = result.version;
    if (!version) return;
    logger.info(`  - OpenCode CLI version: ${version}`);
    if (Number(version.split('.')[0]) >= 2) {
        logger.warn(
            `[Warning] OpenCode CLI ${version} is a 2.x release: its \`serve\` is the web UI, not the session API this gateway drives, ` +
            'so every completion will fail with 502 "rejected session creation". Install a 1.x release (npm install -g "opencode-ai@1") ' +
            'or point OPENCODE_PATH at one.'
        );
    }
}

// Start the proxy
try {
    const proxy = startProxy(finalConfig);
    // Deliberately not awaited: the gateway is already serving, and the answer only adds a line (or a warning)
    probeOpencodeVersion(finalConfig.OPENCODE_PATH).then(reportOpencodeVersion).catch(() => {});

    // Graceful shutdown: stop accepting connections, let the responses in flight finish, then stop the backend and
    // exit. Long-lived SSE streams can keep server.close() pending, so in-flight sockets get a short grace period
    // before being dropped and a watchdog guarantees the process leaves even if a client never disconnects.
    let shuttingDown = false;
    let finishing = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`[Shutdown] Received ${signal}, shutting down gracefully...`);

        // The backend answers the requests that are still in flight, so it is stopped only once they are gone: it
        // used to be killed first, which turned a completion the gateway was already serving into an upstream error.
        let backendStopped = null;
        const stopBackend = () => {
            if (!backendStopped) backendStopped = Promise.resolve(proxy.killBackend()).catch(() => {});
            return backendStopped;
        };
        const finish = (message, warn) => {
            if (finishing) return;
            finishing = true;
            clearTimeout(watchdog);
            if (warn) logger.warn(message);
            else logger.info(message);
            // The backend is awaited before exiting: SIGTERM used to be followed by process.exit() on the next line, so
            // the SIGKILL escalation inside killBackend() never ran and a backend that ignores SIGTERM outlived the
            // gateway that owns it. A second watchdog bounds the teardown itself.
            const hardExit = setTimeout(() => process.exit(0), 5000);
            hardExit.unref();
            stopBackend().then(() => process.exit(0));
        };

        const watchdog = setTimeout(
            () => finish('[Shutdown] Forcing exit, connections did not close in time', true),
            6000
        );
        watchdog.unref();

        // Stop accepting new connections; whatever is already being served keeps the backend it depends on
        proxy.server.close(() => finish('[Shutdown] Server closed', false));
        // Give responses in flight a moment to finish, then drop whatever is still connected (open SSE streams)
        setTimeout(() => {
            try {
                proxy.server.server?.closeAllConnections?.();
            } catch (e) {
                // best effort
            }
        }, 1500).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // A single failed request must not take the gateway down silently: a stray rejection is logged with its stack and
    // the process keeps serving, while an uncaught exception (state unknown) goes through the normal shutdown path.
    process.on('unhandledRejection', (reason) => {
        logger.error('[Fatal] Unhandled promise rejection:', {
            error: reason?.message || String(reason),
            stack: reason?.stack
        });
    });
    process.on('uncaughtException', (err) => {
        logger.error('[Fatal] Uncaught exception:', { error: err.message, stack: err.stack });
        shutdown('uncaughtException');
    });
} catch (error) {
    logger.error('[Fatal] Failed to start proxy:', { error: error.message, stack: error.stack });
    process.exit(1);
}
