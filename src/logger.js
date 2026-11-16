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
export const MAX_SERIALIZED_LENGTH = 32 * 1024;
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
        // Masked like every other sentence that leaves the process: an `Error` handed to a log line is the shape whose
        // message quotes a credential, and its stack repeats that message on its first line.
        return {
            name: value.name,
            message: maskFreeText(value.message),
            stack: maskFreeText(String(value.stack || ''), MAX_LOGGED_STACK_CHARS)
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
// `passw` alone was a prefix rather than a name: the anchors around the alternation require a whole segment, so it only
// ever matched a name spelled exactly `passw`, and the ordinary spellings (`?password=…`, an `x-db-password` header)
// went out in clear. The full words are listed next to it, and a segment separator (`_`, `-`) is what makes
// `db_password` match.
export const SENSITIVE_NAME_ALTERNATIVES = 'auth|token|secret|cookie|session|passw|password|passwd|pwd|key|code|sig|signature|credential|bearer';
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
 * The name run is bounded by the separators that start a pair, `?` included: a `?` inside `[^=&#]` started a fresh
 * scan at every character of a `?` run (the name class accepted the next `?`), so a client could spend the serving
 * thread's CPU with one request target - 14 000 `?` after `/v1/models` measured 96 ms per request, unauthenticated,
 * because the summary line is built for every `/v1/*` response. A real credential name never contains a `?` (it is
 * `%3F` when encoded), so excluding it changes no real URL.
 * @param {string} url raw request URL
 * @returns {string} the URL with credential query values masked
 */
export function maskUrlQuery(url) {
    return String(url).replace(/([?&#])([^=&#?]+)=([^&#]*)/g, (match, separator, name, value) => {
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
    // authority is everything up to the first `/`, `?` or `#`, which the character class excludes).
    //
    // The scheme run is bounded (`{0,31}`): no real scheme is longer, and an unbounded one made this quadratic in the
    // length of a whitespace-free token. `[\w+.-]*` swallowed the whole token before `://`, then the authority class
    // scanned it again and failed at every `@`-less offset - 32 000 characters measured 1.9 s on the serving thread,
    // reachable through the debug dump of a request body (each string up to 32 KiB) and through an upstream error
    // sentence quoted into a 502. With the bound, a start position can only be a candidate when `://` follows within
    // 32 characters, so the scan is linear (1 MiB measured ~70 ms).
    return String(text).replace(/(\w[\w+.-]{0,31}:\/\/)[^\s/?#@]*@/g, '$1***@');
}

/**
 * Mask a credential that is quoted as an authorization header value inside arbitrary text.
 *
 * The gateway lifts the credential out of `OPENCODE_SERVER_URL` and sends it as a Basic header
 * (`resolveBackendAuth()`). A backend, or a proxy in front of the backend, can echo the header it rejected in its own
 * error payload - `invalid credentials: Authorization: Basic b3BzOnMzY3JldA==` - and that payload is copied into a
 * client-facing `502` body and into the error log. Masking a URL inside a sentence does not cover a bare encoded
 * token, so the value after the scheme word is replaced too.
 *
 * Only a token that looks like one is replaced: the word has to be followed by whitespace and at least 16 characters
 * of the base64/URL-safe alphabet, so ordinary prose ("basic setup", "Bearer of good news") is left alone and a
 * reader still sees which header was refused.
 * @param {*} text any text (non-strings are stringified the way `maskUrlQuery` does it)
 * @returns {string} the text with `Basic <token>` / `Bearer <token>` reduced to `Basic ***` / `Bearer ***`
 */
export function maskQuotedCredentials(text) {
    return String(text).replace(/(\bbasic\s+|\bbearer\s+)([A-Za-z0-9+/=_.~-]{16,})/gi, '$1***');
}

// Upstream text on its way to a client or a log line is masked and bounded. A backend (or a proxy in front of it) can
// quote a URL inside an error payload, and a configured backend URL may carry a credential, so every sentence that
// leaves the process goes through the same chain - the `500` body, the `502` body, the request log and the stack a
// fatal handler prints.
const MAX_UPSTREAM_TEXT_CHARS = 512;
// A stack is bounded separately, and much lower: it is written by whatever threw, and 32 KB of frames helps nobody
// (the same limit `safeClone()` applies to an `Error` it copies).
export const MAX_LOGGED_STACK_CHARS = 1000;

// Only the URL-shaped words of the text are masked. `maskUrlQuery()` is written for a URL: given a sentence it
// read everything after the first `?` as that parameter's value, so `…?x=1: connection refused` answered
// `…?x=***` and lost the half of the reason that explains the failure.
//
// The words are found by splitting on whitespace rather than with `/\S+:\/\/\S+/`, which backtracked over a
// million-character token with no `://` in it one character at a time: a provider error of 1 MB parked the request
// for longer than its whole budget. `includes('://')` decides per token, and a token is at most a word.
export function maskUrlsInText(text) {
    const value = String(text);
    if (!value.includes('://')) return value;
    return value
        .split(/(\s+)/)
        .map((token) => (token.includes('://') ? maskUrlQuery(maskUrlCredentials(token)) : token))
        .join('');
}

/**
 * Free text that is about to leave the process - a client-facing 5xx sentence, an error log line, a stack, a string
 * inside a debug dump - masked and bounded in one place.
 *
 * Two credentials can hide in a sentence and neither is the sentence's own: a URL carrying userinfo or a query value
 * (`http://user:secret@host:4097/session?token=…`, which Node's `fetch` refuses out loud) and an authorization header
 * value a proxy echoed back (`Authorization: Basic b3BzOnMzY3I…`). Both used to reach a client body and `docker logs`
 * verbatim; masking one and not the other is why the chain lives here rather than at each call site.
 * @param {*} value any text (non-strings are stringified the way `maskUrlQuery` does it)
 * @param {number} [maxChars] length bound; 512 by default, and the marker matches `loggableUrl()`
 * @returns {string} the masked, bounded text
 */
export function maskFreeText(value, maxChars = MAX_UPSTREAM_TEXT_CHARS) {
    if (value === null || value === undefined) return '';
    const masked = maskQuotedCredentials(maskUrlsInText(String(value)));
    if (!Number.isFinite(maxChars) || masked.length <= maxChars) return masked;
    return `${masked.slice(0, maxChars)}…[truncated ${masked.length - maxChars} chars]`;
}

/**
 * The `{ error, stack }` pair an error log line prints, masked and bounded the way a response body is.
 *
 * A stack's first line *is* the message, so a line that masked `message` and printed `stack` verbatim published the
 * sentence it had just masked - and the fatal handlers (`uncaughtException`, `unhandledRejection`, a failed start) did
 * exactly that, with no masking at all. Reading `.message` off a rejection that carries none also wrote `undefined`.
 * @param {*} error whatever was thrown or rejected with
 * @returns {{error: string, stack: string}} the sentence and the (bounded) stack, both masked
 */
export function loggableError(error) {
    const stack = typeof error?.stack === 'string' ? error.stack : '';
    return {
        error: maskFreeText(typeof error?.message === 'string' ? error.message : error),
        stack: maskFreeText(stack, MAX_LOGGED_STACK_CHARS)
    };
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
    // A string is masked too, and by content rather than by key: a client that forwards
    // `{"endpoint":"http://user:secret@host:4097/session?token=abc"}` in a field named something ordinary wrote that
    // credential to `docker logs` at debug level, because only values whose *key* looked like a credential were masked.
    //
    // It is cut **before** it is masked, because `serializeDetail()` cuts the finished line at the same 32 KB: nothing
    // past it can be printed, so walking the rest only to throw it away cost what the body cost - one 48 MB message
    // (the default body limit is 50 MiB) measured 688 ms and +375 MB of heap churn per debug line, against 0.1 ms for
    // the line itself. Masking the first 32 KB of it costs the same as masking a 32 KB string.
    if (typeof value === 'string') {
        return maskFreeText(value.length > MAX_SERIALIZED_LENGTH ? value.slice(0, MAX_SERIALIZED_LENGTH) : value,
            MAX_SERIALIZED_LENGTH);
    }
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
