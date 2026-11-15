/**
 * Zero-dependency lightweight logging module for the Free OpenCode API gateway
 *
 * - Log levels: error < warn < info < debug, controlled by the LOG_LEVEL environment variable
 *   (case-insensitive). Invalid values fall back to info with a warning; when unset, defaults to info.
 * - All output goes to stdout/stderr (visible via `docker logs`), always prefixed with [gateway]:
 *   error/warn -> stderr, info/debug -> stdout
 * - Sensitive data masking: authorization / x-api-key / cookie style headers must pass through
 *   maskHeaders/maskSecret before being written, a URL through maskUrlQuery, and a configured outbound URL
 *   through maskBackendUrl (it can carry userinfo)
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
 * Write one key of a copy that is about to be serialised.
 *
 * A key named `__proto__` is an ordinary own property on what `JSON.parse` returns (a backend payload logged as a
 * detail, the object behind a copy), but `target[key] = value` runs the `__proto__` setter instead: the key disappeared
 * from the dump while nothing else changed, so a debug line silently misreported what had arrived - which is the one
 * thing that dump is read for. Assigning a non-object through that setter is also a silent no-op, so the value was
 * lost with no trace at all. `defineProperty` writes it as a data property, and only that one key pays for it.
 * (A request body cannot reach these helpers with that name: Fastify's poisoning guard refuses it first. Node's own
 * header parser drops a header named `__proto__`, so `maskHeaders` only ever sees one from a caller that built the
 * object itself - both are reasons the helpers must not be the thing that loses it.)
 */
export function setOwnProperty(target, key, value) {
    if (key === '__proto__') {
        Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
        return;
    }
    target[key] = value;
}

/**
 * Safe clone: handles circular references, excessive nesting, Error and BigInt so that the following
 * JSON.stringify call never throws (non-JSON values become readable placeholders instead of being dropped)
 */
function safeClone(value, seen = new WeakSet(), depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') return `${value}n`;
    // A single long string is the common shape of an over-large detail (a request body's message content), and the
    // 32 KB cap at the end of serializeDetail() only applies after the whole payload has been cloned and stringified:
    // one debug line carrying a 50 MB body (the default OPENCODE_PROXY_MAX_BODY_MB) allocated ~2x that and blocked the
    // event loop for ~43 ms. Cutting it here keeps the same output and the same annotation for a fraction of the cost.
    if (typeof value === 'string') {
        return value.length > MAX_SERIALIZED_LENGTH ? truncateText(value, MAX_SERIALIZED_LENGTH) : value;
    }
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
            setOwnProperty(out, key, safeClone(value[key], seen, depth + 1));
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

// Request header names that must be masked before output (lowercase). The set covers the names this gateway and
// OpenAI clients use, and the pattern below covers the rest: a client or an upstream proxy can forward any credential
// under its own name (`x-goog-api-key`, `x-auth-token`, `openai-api-key`, `authentication`,
// `x-forwarded-authorization`), and the full header dump at debug level used to print those verbatim.
const SENSITIVE_HEADER_NAMES = new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'openai-organization',
    'cookie',
    'set-cookie'
]);
// Name segments that carry a credential in a header **or** in a query string. Shared as a string rather than written
// into the pattern directly because `docker/docker-entrypoint.sh` cannot import this module and repeats it verbatim for
// its own first-boot config dump: the smoke suite compares the two copies, so they cannot drift apart. `key`, `code`,
// `sig`, `signature`, `credential` and `bearer` were missing, and those are exactly the spellings other clients use for
// the same secret: Google's `?key=AIza…`, an OAuth `?code=…`, an Azure SAS `?sig=…`, `?access_token=`'s relatives
// (`?bearer=…`, `?credential=…`). A request URL is logged at the default level, so each of them reached `docker logs`.
export const SENSITIVE_NAME_ALTERNATIVES = 'auth|token|secret|cookie|session|passw|key|code|sig|signature|credential|bearer';
const SENSITIVE_HEADER_PATTERN = new RegExp(
    `(^|[-_])(${SENSITIVE_NAME_ALTERNATIVES})([-_]|$)|authorization|authentication|api[-_]?key`,
    'i'
);

const isSensitiveHeader = (lowerName) => SENSITIVE_HEADER_NAMES.has(lowerName) || SENSITIVE_HEADER_PATTERN.test(lowerName);

/**
 * Mask a value carried in the query string. A client that sends its key as `?api_key=…` (an OpenAI-compatible
 * convention some tools still use) wrote it into `docker logs` on every request, because the request summary, the
 * debug dump and the rejected-request warning log the raw URL. The URL itself is kept: only values whose *name* looks
 * like a credential are replaced.
 *
 * `#` separates too, not just `?` and `&`: a browser and `curl` drop a fragment before sending, but a raw client can
 * put one in the request target (`GET /v1/models#access_token=…`), Node hands that URL over as it arrived, and the
 * gateway logged the credential at the default level. A fragment is not part of an HTTP request, so masking one costs
 * nothing, and an unmasked one is a secret in `docker logs`.
 * @param {string} url raw request URL
 * @returns {string} the URL with credential query values masked
 */
export function maskUrlQuery(url) {
    return String(url).replace(/([?&#])([^=&#]+)=([^&#]*)/g, (match, separator, name, value) => {
        let decoded = name;
        try {
            decoded = decodeURIComponent(name);
        } catch {
            // a name that is not valid percent-encoding is compared as written
        }
        return isSensitiveHeader(decoded.toLowerCase()) ? `${separator}${name}=***` : match;
    });
}

/**
 * Mask the credentials a configured **outbound** URL can carry. `OPENCODE_SERVER_URL` is printed in the startup
 * summary, in the `[Config]` normalisation notes and in `/health` - the last one without a key - so a URL written as
 * `http://user:secret@host:4097` (a reverse proxy in front of the backend) published that secret to every caller and to
 * `docker logs`. Only the credential is replaced: the scheme, host and path stay readable, which is what an operator
 * needs from both lines. The query string goes through `maskUrlQuery()` for the same reason it does on request URLs.
 * @param {string} url configured backend URL
 * @returns {string} the URL with userinfo and credential query values masked
 */
export function maskBackendUrl(url) {
    const text = maskUrlQuery(String(url));
    // Everything between `//` and the last `@` before the path is userinfo (`user:pass`); a host cannot contain `@`
    return text.replace(/^(\w[\w+.-]*:\/\/)[^/?#]*@/, '$1***@');
}

/**
 * Mask the userinfo of any URL inside an arbitrary piece of text.
 *
 * `maskBackendUrl()` takes a URL; this takes a *message* that can contain one. An upstream error message is the case
 * that matters: Node's `fetch` answered `Request cannot be constructed from a URL that includes credentials:
 * http://user:secret@host:4097/session`, and that sentence went into a client-facing `502` body and into the error
 * log - a configured backend credential published to every caller. A backend, or a proxy in front of it, can also
 * quote a URL back in its own error payload, so the masking is applied to whatever text is about to leave the process.
 * Only the credential is replaced: scheme, host, port and path stay readable.
 * @param {*} text any text (non-strings are stringified the way `maskUrlQuery` does it)
 * @returns {string} the text with every `scheme://user:pass@` reduced to `scheme://***@`
 */
export function maskUrlCredentials(text) {
    // Not anchored: the URL can sit anywhere in the sentence, and a `@` in a path or query is not userinfo (the
    // authority is everything up to the first `/`, `?` or `#`, which the character class excludes)
    return String(text).replace(/(\w[\w+.-]*:\/\/)[^\s/?#@]*@/g, '$1***@');
}

/**
 * Copy a request-header object and mask sensitive headers (authorization/api-key/cookie/token etc.)
 * @param {object} headers original request headers
 * @returns {object} masked copy (the original object is left untouched)
 */
export function maskHeaders(headers) {
    const masked = {};
    Object.keys(headers || {}).forEach((name) => {
        const lower = String(name).toLowerCase();
        const value = headers[name];
        setOwnProperty(masked, name, isSensitiveHeader(lower) ? maskSecret(value) : value);
    });
    return masked;
}

/**
 * Copy a JSON payload and mask the values whose *key* names a credential, the way `maskHeaders()` does for headers.
 * A request body is as client-chosen as the headers: a wrapper that forwards `{"api_key": …}` or
 * `{"metadata":{"authorization":…}}` wrote a credential to `docker logs` at `LOG_LEVEL=debug`, because the debug
 * dump bounded the body (`serializeDetail()`) but never masked it. The walk is bounded (depth, keys, items) and only
 * runs when debug logging is on, so it costs nothing on the request path.
 * @param {*} value any JSON value from a parsed request body
 * @param {WeakSet} seen objects already visited, for circular payloads
 * @param {number} depth nesting level
 * @returns {*} masked copy (the original object is left untouched)
 */
export function maskDetail(value, seen = new WeakSet(), depth = 0) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    if (depth >= 8) return '[MaxDepthExceeded]';
    seen.add(value);
    let out;
    if (Array.isArray(value)) {
        out = value.slice(0, 100).map((item) => maskDetail(item, seen, depth + 1));
    } else {
        out = {};
        Object.keys(value).slice(0, 100).forEach((key) => {
            const entry = value[key];
            setOwnProperty(out, key, isSensitiveHeader(String(key).toLowerCase()) ? maskSecret(entry) : maskDetail(entry, seen, depth + 1));
        });
    }
    seen.delete(value);
    return out;
}

/**
 * Create a logger instance
 * @param {{level?: string, prefix?: string}} options
 */
export function createLogger(options = {}) {
    const prefix = options.prefix || PREFIX;
    const state = { level: resolveLogLevel(options.level).level };

    // The ISO second is only reformatted when the second it names changes: `new Date().toISOString()` allocates a Date
    // and formats it on every line (measured 355 ns vs 31 ns for the cached form), log lines are written on the request
    // path, and a burst of debug lines per completion is exactly where that adds up. The milliseconds are appended from
    // Date.now() itself: caching the *whole* stamp kept the first line's millisecond for the rest of the second, so a
    // line could be stamped up to 1 s before it was written and a reader correlating a request's logged duration with
    // the wall clock was reading a timestamp that was never taken.
    let stampSecond = -1;
    let stampText = '';
    const isoTimestamp = () => {
        const now = Date.now();
        const second = Math.floor(now / 1000);
        if (second !== stampSecond) {
            stampSecond = second;
            stampText = new Date(now).toISOString().slice(0, 19);
        }
        return `${stampText}.${String(now % 1000).padStart(3, '0')}Z`;
    };

    function write(stream, levelName, message, detail) {
        // A logging call must never be the thing that fails a request: the message is interpolated into the line, so a
        // non-string (a Symbol throws on coercion) would surface as an exception from inside the logger
        const text = typeof message === 'string' ? message : String(message);
        let line = `${prefix} ${isoTimestamp()} [${levelName.toUpperCase()}] ${text}`;
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
