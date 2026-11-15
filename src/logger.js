/**
 * Zero-dependency lightweight logging module for the Free OpenCode API gateway
 *
 * - Log levels: error < warn < info < debug, controlled by the LOG_LEVEL environment variable
 *   (case-insensitive). Invalid values fall back to info with a warning; when unset, defaults to info.
 * - All output goes to stdout/stderr (visible via `docker logs`), always prefixed with [gateway]:
 *   error/warn -> stderr, info/debug -> stdout
 * - Sensitive data masking: authorization / x-api-key / cookie style headers must pass through
 *   maskHeaders/maskSecret before being written
 * - Output format: [gateway] <ISO timestamp> [LEVEL] message {"detail":"json"}
 */

const PREFIX = '[gateway]';
const DEFAULT_LEVEL = 'info';

// A closed reader on the other end of stdout/stderr (a pipe into `head`, a log shipper that restarted, `docker logs`
// closing mid-write) makes the next write emit EPIPE. A stream 'error' with no listener is thrown as an uncaught
// exception, so `node index.js | head -3` killed a gateway that was still serving requests: the log line is lossy by
// then, the process must not be. Nothing else is swallowed - a real stream failure stays visible.
const IGNORED_STREAM_ERRORS = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);
const ignoreClosedReader = (error) => {
    if (error && IGNORED_STREAM_ERRORS.has(error.code)) return;
    throw error;
};
process.stdout.on('error', ignoreClosedReader);
process.stderr.on('error', ignoreClosedReader);

// Level values: higher means more verbose; the output check is "current level value >= target level value"
// (both sides are numbers, not a string comparison)
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Maximum length of a single serialized detail value (full request/response bodies at debug level can be
// large; overlong values are truncated and annotated)
const MAX_SERIALIZED_LENGTH = 32 * 1024;
// Maximum recursion depth and array/object member limits, to keep deeply nested payloads from exploding the log
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 200;

/**
 * Parse a log level string
 * @param {string|undefined|null} raw raw value (e.g. from the LOG_LEVEL environment variable)
 * @returns {{level: string, valid: boolean, explicit: boolean, requested: string|null}}
 *          level = resolved level; valid=false means invalid (already fell back to info);
 *          explicit=false means it was not provided
 */
export function resolveLogLevel(raw) {
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
        return { level: DEFAULT_LEVEL, valid: true, explicit: false, requested: null };
    }
    const requested = String(raw).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEVELS, requested)) {
        return { level: requested, valid: true, explicit: true, requested };
    }
    return { level: DEFAULT_LEVEL, valid: false, explicit: true, requested: String(raw) };
}

/** Truncate an overlong string and annotate how many characters were cut */
function truncateText(text, maxLen) {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}…[truncated ${text.length - maxLen} chars]`;
}

/**
 * Safe clone: handles circular references, excessive nesting, Error and BigInt so that the following
 * JSON.stringify call never throws (non-JSON values become readable placeholders instead of being dropped)
 */
function safeClone(value, seen = new WeakSet(), depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value !== 'object') return value;
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: truncateText(String(value.stack || ''), 1000)
        };
    }
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[MaxDepthExceeded]';
    seen.add(value);
    let out;
    if (Array.isArray(value)) {
        out = value.slice(0, MAX_ARRAY_ITEMS).map((item) => safeClone(item, seen, depth + 1));
        if (value.length > MAX_ARRAY_ITEMS) out.push(`[+${value.length - MAX_ARRAY_ITEMS} more items]`);
    } else {
        out = {};
        const keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
        keys.forEach((key) => {
            out[key] = safeClone(value[key], seen, depth + 1);
        });
        const hiddenKeys = Object.keys(value).length - keys.length;
        if (hiddenKeys > 0) out['[hiddenKeys]'] = hiddenKeys;
    }
    seen.delete(value);
    return out;
}

/**
 * Serialize any value into a single-line JSON string; on failure emit a placeholder with the reason
 * (never swallow silently)
 * @param {*} value any value
 * @returns {string}
 */
export function serializeDetail(value) {
    if (value === undefined) return '';
    let text;
    try {
        text = JSON.stringify(safeClone(value));
    } catch (e) {
        // JSON.stringify should not throw (safeClone already removes circular references); fall back with the reason
        return `[Unserializable detail: ${e && e.message ? e.message : 'unknown error'}]`;
    }
    if (text === undefined) return '[Unserializable detail: undefined]';
    return truncateText(text, MAX_SERIALIZED_LENGTH);
}

/**
 * Mask a sensitive string. The prefix is kept so an operator can tell which credential was used, but nothing is
 * revealed from the tail: keeping four trailing characters leaked 8 of the 12 characters of a short key such as
 * `sk-dummy-123`, which is most of its entropy in a log that is collected as often as not. Very short values reveal
 * nothing at all, and the length is reported instead (the container entrypoint uses the same shape).
 */
export function maskSecret(text) {
    const str = String(text);
    if (str.length <= 16) return `***(${str.length} chars)`;
    return `${str.slice(0, 4)}***(${str.length} chars)`;
}

// Request header names that must be masked before output (lowercase)
const SENSITIVE_HEADER_NAMES = new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'openai-organization',
    'cookie',
    'set-cookie'
]);

/**
 * Copy a request-header object and mask sensitive headers (authorization/api-key/cookie etc.)
 * @param {object} headers original request headers
 * @returns {object} masked copy (the original object is left untouched)
 */
export function maskHeaders(headers) {
    const masked = {};
    Object.keys(headers || {}).forEach((name) => {
        const lower = String(name).toLowerCase();
        const value = headers[name];
        masked[name] = SENSITIVE_HEADER_NAMES.has(lower) ? maskSecret(value) : value;
    });
    return masked;
}

/**
 * Create a logger instance
 * @param {{level?: string, prefix?: string}} options
 */
export function createLogger(options = {}) {
    const prefix = options.prefix || PREFIX;
    const state = { level: resolveLogLevel(options.level).level };

    function write(stream, levelName, message, detail) {
        let line = `${prefix} ${new Date().toISOString()} [${levelName.toUpperCase()}] ${message}`;
        if (detail !== undefined) {
            const serialized = serializeDetail(detail);
            if (serialized !== '') line += ` ${serialized}`;
        }
        stream.write(`${line}\n`);
    }

    return {
        /** Currently effective level (read-only) */
        get level() {
            return state.level;
        },
        /**
         * Update the level
         * @param {string} raw raw new level value
         * @returns {{level: string, valid: boolean, explicit: boolean, requested: string|null}} parse result
         */
        setLevel(raw) {
            const result = resolveLogLevel(raw);
            state.level = result.level;
            return result;
        },
        /**
         * Whether a level is enabled (numeric comparison, both sides converted to number via the LEVELS table)
         * @param {string} levelName target level
         */
        isEnabled(levelName) {
            const current = LEVELS[state.level];
            const target = LEVELS[levelName];
            return current >= target;
        },
        /** error level: upstream failures / fatal startup problems, always emitted, goes to stderr */
        error(message, detail) {
            if (LEVELS[state.level] >= LEVELS.error) write(process.stderr, 'error', message, detail);
        },
        /** warn level: invalid-config fallbacks / self-recoverable anomalies, goes to stderr */
        warn(message, detail) {
            if (LEVELS[state.level] >= LEVELS.warn) write(process.stderr, 'warn', message, detail);
        },
        /** info level: startup info / per-request summary, visible at the default level, goes to stdout */
        info(message, detail) {
            if (LEVELS[state.level] >= LEVELS.info) write(process.stdout, 'info', message, detail);
        },
        /** debug level: full request bodies / responses / flow details, only visible with LOG_LEVEL=debug, goes to stdout */
        debug(message, detail) {
            if (LEVELS[state.level] >= LEVELS.debug) write(process.stdout, 'debug', message, detail);
        }
    };
}

// Process-wide default instance: initialized from the LOG_LEVEL environment variable (startProxy re-calibrates it
// against its options and emits a warning when needed)
export const logger = createLogger({ level: process.env.LOG_LEVEL });
