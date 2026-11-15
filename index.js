import { startProxy, DEFAULT_API_KEY, parseBoolean, resolveApiKey } from './src/proxy.js';
import { readConfigFile } from './src/config.js';
import { logger } from './src/logger.js';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
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
if (fs.existsSync(configPath)) {
    logger.info('[Config] Loaded from config.json');
}

// Merge configs: env > file > default
// Note: by design LOG_LEVEL takes env over the config.json logLevel field (same merge direction as the other keys
// below, where env comes first)
// A port must be digits only: parseInt('8083abc') is 8083, so a typo used to be accepted silently while the operator
// believed the gateway listened where they asked
const rawPort = String(process.env.PORT ?? fileConfig.PORT ?? '').trim();
const portIsValid = /^\d{1,5}$/.test(rawPort) && Number(rawPort) > 0 && Number(rawPort) < 65536;
const parsedPort = portIsValid ? Number(rawPort) : defaultConfig.PORT;
if (!portIsValid && (process.env.PORT !== undefined || fileConfig.PORT !== undefined)) {
    logger.warn(`[Config] PORT '${rawPort}' is not a valid TCP port (1-65535), falling back to ${defaultConfig.PORT}`);
}

const finalConfig = {
    PORT: portIsValid ? parsedPort : defaultConfig.PORT,
    // Never empty: an unset/blank API_KEY falls back to the built-in default (authentication stays on)
    API_KEY: resolveApiKey(process.env.API_KEY ?? fileConfig.API_KEY ?? defaultConfig.API_KEY),
    OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL || fileConfig.OPENCODE_SERVER_URL || defaultConfig.OPENCODE_SERVER_URL,
    OPENCODE_BIND_HOST: process.env.OPENCODE_BIND_HOST || fileConfig.OPENCODE_BIND_HOST || defaultConfig.OPENCODE_BIND_HOST,
    OPENCODE_PATH: process.env.OPENCODE_PATH || fileConfig.OPENCODE_PATH || defaultConfig.OPENCODE_PATH,
    BIND_HOST: process.env.BIND_HOST || fileConfig.BIND_HOST || defaultConfig.BIND_HOST,
    // The legacy OPENCODE_-prefixed name keeps working; the bare name matches every other key and the container's
    // `-e DISABLE_TOOLS=...` flag
    DISABLE_TOOLS: parseBoolean(
        process.env.OPENCODE_DISABLE_TOOLS ?? process.env.DISABLE_TOOLS,
        parseBoolean(fileConfig.DISABLE_TOOLS, defaultConfig.DISABLE_TOOLS)
    ),
    // Run the backend under an isolated HOME (a throwaway directory instead of the real one). The legacy
    // OPENCODE_-prefixed environment variable keeps working
    USE_ISOLATED_HOME: parseBoolean(
        process.env.OPENCODE_USE_ISOLATED_HOME ?? process.env.USE_ISOLATED_HOME,
        parseBoolean(fileConfig.USE_ISOLATED_HOME, defaultConfig.USE_ISOLATED_HOME)
    ),
    // LOG_LEVEL: env takes precedence over config.json; when neither is explicitly set, undefined is passed
    // through and startProxy falls back to the default info while keeping the legacy DEBUG -> debug level interlock
    LOG_LEVEL: process.env.LOG_LEVEL || fileConfig.LOG_LEVEL || undefined
};

if (finalConfig.API_KEY === DEFAULT_API_KEY) {
    logger.warn(`[Security] API_KEY is not configured, using the built-in default '${DEFAULT_API_KEY}'. Set API_KEY for production use.`);
}

// Validate required configuration
if (!finalConfig.OPENCODE_PATH) {
    logger.error('[Error] OPENCODE_PATH is not set. Please configure it in config.json or environment variable.');
    process.exit(1);
}

// Check if opencode is available. The timeout matters: a backend that waits for input (or a wrapper that never
// returns) must not block the gateway from starting, and the probe result is a warning at most. execFileSync (no
// shell) keeps a path with quotes or spaces intact and cannot be turned into a shell command.
try {
    execFileSync(finalConfig.OPENCODE_PATH, ['--version'], { stdio: 'ignore', timeout: 5000 });
} catch (e) {
    logger.warn(`[Warning] Cannot verify OpenCode installation: ${finalConfig.OPENCODE_PATH}`);
    logger.warn('[Warning] Please ensure OpenCode is installed:');
    logger.warn('  Windows: npm install -g opencode-ai');
    logger.warn('  Linux/macOS: curl -fsSL https://opencode.ai/install | bash');
    logger.warn('[Warning] Or specify the full path in config.json:');
    logger.warn('  { "OPENCODE_PATH": "C:\\\\Users\\\\YourName\\\\AppData\\\\Roaming\\\\npm\\\\opencode.cmd" }');
}

logger.info('[Config] Starting with configuration:');
logger.info(`  - Port: ${finalConfig.PORT}`);
logger.info(`  - Bind Host: ${finalConfig.BIND_HOST}`);
logger.info(`  - Backend: ${finalConfig.OPENCODE_SERVER_URL}`);
logger.info(`  - Bind Host for OpenCode backend: ${finalConfig.OPENCODE_BIND_HOST}`);
logger.info(`  - OpenCode Path: ${finalConfig.OPENCODE_PATH}`);
logger.info(`  - API Key: ${finalConfig.API_KEY === DEFAULT_API_KEY ? `default (${DEFAULT_API_KEY})` : 'custom'} - authentication always enforced`);
logger.info(`  - Disable Tools: ${finalConfig.DISABLE_TOOLS ? 'Yes' : 'No'}`);
logger.info(`  - Isolated HOME for OpenCode: ${finalConfig.USE_ISOLATED_HOME ? 'Yes' : 'No'}`);
logger.info(`  - Log Level (requested): ${finalConfig.LOG_LEVEL || 'info (default)'}`);

// Start the proxy
try {
    const proxy = startProxy(finalConfig);

    // Graceful shutdown: stop accepting connections, stop the backend, then exit. Long-lived SSE streams can keep
    // server.close() pending, so in-flight sockets get a short grace period before being dropped and a watchdog
    // guarantees the process leaves even if a client never disconnects.
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`[Shutdown] Received ${signal}, shutting down gracefully...`);

        const watchdog = setTimeout(() => {
            logger.warn('[Shutdown] Forcing exit, connections did not close in time');
            process.exit(0);
        }, 6000);
        watchdog.unref();

        proxy.killBackend();
        proxy.server.close(() => {
            clearTimeout(watchdog);
            logger.info('[Shutdown] Server closed');
            process.exit(0);
        });
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
