import { startProxy, DEFAULT_API_KEY, resolveApiKey } from './src/proxy.js';
import { logger } from './src/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseBool(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
        if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    }
    if (value === undefined || value === null) return fallback;
    return Boolean(value);
}

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
    DISABLE_TOOLS: false
};

// Load config from file
const configPath = path.join(__dirname, 'config.json');
let fileConfig = {};

if (fs.existsSync(configPath)) {
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        fileConfig = JSON.parse(content);
        logger.info('[Config] Loaded from config.json');
    } catch (err) {
        logger.error('[Config] Error parsing config.json:', { error: err.message });
    }
}

// Merge configs: env > file > default
// Note: by design LOG_LEVEL takes env over the config.json logLevel field (same merge direction as the other keys
// below, where env comes first)
const finalConfig = {
    PORT: parseInt(process.env.PORT) || fileConfig.PORT || defaultConfig.PORT,
    // Never empty: an unset/blank API_KEY falls back to the built-in default (authentication stays on)
    API_KEY: resolveApiKey(process.env.API_KEY ?? fileConfig.API_KEY ?? defaultConfig.API_KEY),
    OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL || fileConfig.OPENCODE_SERVER_URL || defaultConfig.OPENCODE_SERVER_URL,
    OPENCODE_BIND_HOST: process.env.OPENCODE_BIND_HOST || fileConfig.OPENCODE_BIND_HOST || defaultConfig.OPENCODE_BIND_HOST,
    OPENCODE_PATH: process.env.OPENCODE_PATH || fileConfig.OPENCODE_PATH || defaultConfig.OPENCODE_PATH,
    BIND_HOST: process.env.BIND_HOST || fileConfig.BIND_HOST || defaultConfig.BIND_HOST,
    DISABLE_TOOLS: parseBool(process.env.OPENCODE_DISABLE_TOOLS, parseBool(fileConfig.DISABLE_TOOLS, defaultConfig.DISABLE_TOOLS)),
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

// Check if opencode is available
import { execSync } from 'child_process';
try {
    execSync(`"${finalConfig.OPENCODE_PATH}" --version`, { stdio: 'ignore' });
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
logger.info(`  - Log Level (requested): ${finalConfig.LOG_LEVEL || 'info (default)'}`);

// Start the proxy
try {
    const proxy = startProxy(finalConfig);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        logger.info('[Shutdown] Received SIGINT, shutting down gracefully...');
        proxy.killBackend();
        proxy.server.close(() => {
            logger.info('[Shutdown] Server closed');
            process.exit(0);
        });
    });

    process.on('SIGTERM', () => {
        logger.info('[Shutdown] Received SIGTERM, shutting down gracefully...');
        proxy.killBackend();
        proxy.server.close(() => {
            logger.info('[Shutdown] Server closed');
            process.exit(0);
        });
    });
} catch (error) {
    logger.error('[Fatal] Failed to start proxy:', { error: error.message, stack: error.stack });
    process.exit(1);
}
