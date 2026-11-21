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
        // One key array, not two: the list used to be built again (`Object.keys(value).length`) only to learn how many
        // keys the cap hid, which doubled the enumeration of every object in the payload.
        const allKeys = Object.keys(value);
        const keys = allKeys.length > MAX_OBJECT_KEYS ? allKeys.slice(0, MAX_OBJECT_KEYS) : allKeys;
        keys.forEach((key) => {
            setOwnProperty(out, key, safeClone(value[key], seen, depth + 1));
        });
        if (allKeys.length > keys.length) out['[hiddenKeys]'] = allKeys.length - keys.length;
    }
    seen.delete(value);
    return out;
}

/**
 * Serialize any value into a single-line JSON string; on failure emit a placeholder with the reason
 * (never swallow silently)
 * @param {*} value any value
 * @param {boolean} preBounded true when the value came from `maskDetail()`, whose copy is already acyclic and bounded
 *        (depth, member count and string lengths), so the second tree walk `safeClone()` performs can find nothing to
 *        change: on a body with about a million nodes that walk cost 36 ms of a 91 ms debug line, in exactly the mode
 *        an operator turns on to investigate. A value that still defeats `JSON.stringify` (a BigInt, a getter) is
 *        cloned the normal way, so the annotated placeholder is unchanged.
 * @returns {string}
 */
export function serializeDetail(value, preBounded = false) {
    if (value === undefined) return '';
    let text;
    try {
        text = JSON.stringify(preBounded ? value : safeClone(value));
    } catch (e) {
        if (preBounded) return serializeDetail(value, false);
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
// Name segments that carry a credential in a header **or** in a query string. Exported because the same list answers
// for the container entrypoint's first-boot dump and for the smoke suite's own table; the entrypoint imports this
// module (`node --input-type=module -e`) rather than repeating the list, so there is one copy to change. `key`, `code`,
// `sig`, `signature`, `credential` and `bearer` were missing, and those are exactly the spellings other clients use for
// the same secret: Google's `?key=AIza…`, an OAuth `?code=…`, an Azure SAS `?sig=…`, `?access_token=`'s relatives
// (`?bearer=…`, `?credential=…`). A request URL is logged at the default level, so each of them reached `docker logs`.
// `passw` alone was a prefix rather than a name: the anchors around the alternation require a whole segment, so it only
// ever matched a name spelled exactly `passw`, and the ordinary spellings (`?password=…`, an `x-db-password` header)
// went out in clear. The full words are listed next to it, and a segment separator (`_`, `-`) is what makes
// `db_password` match.
export const SENSITIVE_NAME_ALTERNATIVES = 'auth|token|secret|cookie|session|passw|password|passwd|pwd|pass|key|code|sig|signature|credential|bearer|jwt|assertion|saml|ticket|mfa|pat';
// Node lower-cases every incoming header name before `request.headers` is built, so `X-AccessToken` reaches
// `maskHeaders()` as `accesstoken` and `credentialNameKey()` has no case boundary to split: the segment anchors below
// then match nothing, because `accesstoken` is one word that no alternative spells. The camel-case split that fixed
// the JavaScript spellings (`accessToken`) therefore never runs for a real header, and the concatenated compounds -
// the shape every non-browser client uses for its own metadata - were dumped in clear at debug level. `[-_]?` keeps
// both spellings: `x-access-token` already matched through the `token` segment, `x-accesstoken` did not.
// Only the compounds are added here and `SENSITIVE_NAME_ALTERNATIVES` is left alone for the header pattern, because
// that string is also the query-name list: a query is not lower-cased and not split, so `?accessToken=` is still one
// name there. A compound that is not a credential (`monkey`, `keyboard`, `tokenizer`) still matches nothing: every
// alternative is anchored by a separator or by a word boundary on both sides. The Cloudflare Access and SAML
// assertions are header names a proxy in front of the backend can inject, and `Cf-Access-Jwt-Assertion` is one word
// after the camel-case split that no alternative spelled, so it is listed as a compound alongside the others.
// Note: query names *are* checked through `credentialNameKey()` → `isSensitiveHeader()` in `maskUrlQuery()`, so
// `?accessToken=` is masked too - the comment above is about why the *alternatives* string is not widened, not about
// what is checked.
const SENSITIVE_HEADER_PATTERN = new RegExp(
    `(^|[-_])(${SENSITIVE_NAME_ALTERNATIVES})([-_]|$)|authorization|authentication|api[-_]?key` +
        `|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret|secret[-_]?key|session[-_]?id` +
        `|cf[-_]?access[-_]?jwt[-_]?assertion|x[-_]?saml[-_]?assertion|saml[-_]?response|x[-_]?cas[-_]?ticket`,
    'i'
);

// A name is matched in its separated form, so `accessToken` and `x-authToken` are read as `access-token` / `x-auth-token`:
// the pattern's segment anchors require a `_` or `-` around a word, and a camelCase compound has neither, so every
// camelCase spelling (`accessToken`, `authToken`, `refreshToken`, `clientSecret`, `sessionId` - the shape a JavaScript
// client uses for its own metadata) collapsed into one word that matched no alternative and was written to
// `docker logs` in clear by the request summary line and the masked header dump. The split runs before the lower-case
// so the case boundary survives; it allocates one short string per name that is checked, and headers are dumped only
// at debug while a query name is checked only when the URL carries a `=` (the existing fast path).
const credentialNameKey = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const isSensitiveHeader = (name) => {
    const key = credentialNameKey(name);
    return SENSITIVE_HEADER_NAMES.has(key) || SENSITIVE_HEADER_PATTERN.test(key);
};

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
 * `;` separates pairs as well (a legacy CGI-style query, `?x=1;api_key=…`): the value after it was logged in clear, and
 * a `;` is never part of a credential *name*, so treating it as a separator changes no real URL either.
 * Not covered: a credential nested inside another pair's **value** (`?redirect=http://h/?token=…`), because the first
 * pair consumes the rest as its value. Masking that needs a recursive walk of client text on the serving thread, and a
 * client that puts its own credential in a redirect target is already publishing it to the peer it names.
 * @param {string} url raw request URL
 * @returns {string} the URL with credential query values masked
 */
// A query *name* is decoded only to answer "does this spell a credential?", so the decode must answer that question
// without allocating an exception. `decodeURIComponent()` throws on any malformed escape, and `?%zz=1` is ordinary
// client noise - one thrown `URIError` costs an object plus a captured stack, about 1 µs against ~130 ns, once per
// `&`-separated pair. The name is bounded only by Node's 16 KiB header limit and the summary line that calls this runs
// before the auth check, so an unauthenticated caller chose the price: 1600 malformed pairs measured 1.8 ms of blocked
// event loop per request (2.9 ms end-to-end against 0.27 ms with the summary off). The credential words are ASCII, so
// decoding the escapes byte-wise decides identically, and a name carrying no escape is returned without a copy.
const decodeQueryName = (name) => {
    if (name.indexOf('%') === -1) return name;
    return name.replace(/%([0-9A-Fa-f]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
};

/**
 * Mask a `name=value` pair whose **name** looks like a credential, wherever the pair sits in a short value.
 *
 * `maskUrlQuery()` is written for a URL: it requires a `?`, `&`, `#` or `;` in front of the name, which is exactly
 * right for a request target and not enough for the other client-controlled values the gateway echoes into a response
 * body - a `Content-Encoding` header (`api_key=…`), a media type with parameters (`application/x-api-key=…`) and the
 * `type` of an unsupported content part. Those are single tokens with no query string, so a credential a client
 * copied into one was returned verbatim to the caller and into any log that quotes the body.
 *
 * The *name* test is the same one `maskUrlQuery()` uses (`isSensitiveHeader()`), so the two rules cannot disagree
 * about what counts as a credential: `token`, `api_key`, `accessToken`, `password`, `authorization` and friends are
 * masked, and an ordinary pair (`status=ok`, `model=gpt-4`) is left alone. That reuse is also why the rule is narrow
 * enough for prose: a sentence has to contain a credential *name* followed by `=` to be rewritten at all.
 *
 * Not anchored at the end of the value, and bounded on both runs: a pair is a name of at most 64 characters and a
 * value of at most 256, which is far beyond any real token, and the bound is what keeps the scan linear on a value
 * that carries no pair at all.
 *
 * A **flag** spelling is a pair too. The separator class already accepts whitespace, so `opencode --api-key=…` reached
 * this rule with `opencode` as the name run and `--api-key` as ordinary prose: the name had to start with a letter,
 * and both characters in front of `api-key` are dashes. That is the spelling a CLI wrapper uses (`opencode serve
 * --api-key=…`, `--token=…`, `--password=…`), and a wrapper's own error sentence is exactly the client text
 * `maskFreeText()` exists to sanitise, so the flag run is consumed separately and the credential *name* is what the
 * sensitive-name test sees. `-x-api-key=…` and `--x-api-key=…` now read as the header name they spell.
 *
 * A quote is a separator too (`yaml: "password=…"`, `syntax error near "token=…"`): a pair quoted inside a sentence
 * is the shape a configuration parser and a wrapper both produce, and without the quote in the separator class the
 * name run started at the quote and matched nothing. The quotes are written back unchanged and the **unquoted** value
 * class excludes them, so a quoted pair keeps both its delimiters (`"key=***"`, not `"key=***`) while a value that
 * opens a quote it never closes is still masked up to it.
 *
 * The separator itself is `=` **or** `:` (with optional spaces on either side), and an optional quote may sit between
 * the name and that separator: `api_key = "..."`, `api_key: "..."` and `{"api_key":"..."}` are all pairs, and all
 * three were returned verbatim by the `=`-only rule. See `CREDENTIAL_PAIR_RE`.
 * @param {string} text any short value
 * @returns {string} the value with credential pairs masked
 */
// One copy of the pair rule, named rather than inlined because `maskCredentialPairs()` reads the character in front of
// the captured value to decide whether the pair was quoted: the rule and its reader have to change together.
// The value alternation is quoted-first so a quoted value is captured **whole** (a space inside a quoted secret is not
// where the value ends), and the unquoted alternative excludes the quote characters so the quoted branch is reachable.
const CREDENTIAL_PAIR_RE =
    /(^|[,;&#?\s()])(--?)?["']?([A-Za-z][A-Za-z0-9_./-]{0,63})[ \t]*=[ \t]*("[^"]{0,4096}"|'[^']{0,4096}'|[^&;,\s"']{0,4096})|(^|[,;&#?\s(){])"([A-Za-z][A-Za-z0-9_./-]{0,63})"[ \t]*:[ \t]*("[^"]{0,4096}"|'[^']{0,4096}')/g;

export function maskCredentialPairs(text) {
    const value = String(text);
    // The warm path: a pair is only ever separated by `=` or `:`, so a value carrying neither cannot change. `:` is
    // part of the test because a JSON/YAML body writes `"api_key": "..."`, which the `=`-only test skipped entirely.
    if (!value.includes('=') && !value.includes(':')) return value;
    // The **whole** value run is masked, not its first 256 characters: the caller cuts the result at 64, so masking a
    // prefix of a long secret and leaving the rest behind published the tail of the credential in a 415 body. 4096 is
    // far beyond any value that can reach this function (an echoed value is bounded to a 16x window of 64 characters
    // before the mask runs, and a media type or content-part name is shorter still), and it keeps the run bounded the
    // way every other rule here is. `/` is part of a name because a media type is `type/subtype`.
    //
    // The separator is `=` **or** `:`, with optional spaces around it, and an optional quote may sit between the name and
    // the separator. Each of the three shapes is a pair an upstream error body or a wrapper actually quotes:
    // `api_key = "..."` (hand-written config), `api_key: "..."` (YAML) and `{"api_key":"..."}` (JSON, where the closing
    // quote of the key precedes the colon). All three used to be returned verbatim, because the rule required a literal
    // `=` immediately after the name - so a sentence quoting any of them published the credential in the 5xx body and in
    // `docker logs`, which is the one thing this function exists to prevent. The name test is still what decides, so
    // prose and non-credential pairs (`the admin: bob@...`, `ratio: 3:4`, `status: ok`) are untouched.
    //
    // Writing the pair back keeps the shape it arrived in, and only the shape: the opening quote is re-emitted when the
    // value carried its closing partner, and the value - quotes included - is replaced by `***`. Reconstructing from the
    // captures instead of reusing `match` is what stops a `"` from being left behind or duplicated.
    // Two flat alternatives, so one callback signature reads either match. The groups line up as
    // (match, eqBoundary, flag, name, eqValue, jsonBoundary, jsonName, jsonValue): the  spelling fills the first
    // four after the match and the JSON spelling the last three, which is why  decides which branch ran and why
    // each branch reads its own boundary capture (they are separate groups, not one shared prefix).
    return value.replace(CREDENTIAL_PAIR_RE, (match, eqBoundary, flag, name, eqValue, jsonBoundary, jsonName, jsonValue) => {
        if (name === undefined) {
            if (!isSensitiveHeader(jsonName)) return match;
            // The JSON spelling `"name": "value"`: the key and its delimiters are written back, the value is not.
            return `${jsonBoundary}"${jsonName}": "***"`;
        }
        if (!isSensitiveHeader(name)) return match;
        // The separator and any quote in front of the name are read back out of `match`, so a quoted pair keeps its
        // delimiter (`"key=***"`) while an unquoted one stays unquoted.
        const beforeName = `${eqBoundary}${flag || ''}`;
        const nameAt = match.indexOf(name, beforeName.length);
        const prefix = match.slice(0, nameAt + name.length);
        const openingQuote = match[match.length - eqValue.length - 1];
        const quoted = (openingQuote === '"' || openingQuote === "'")
            && eqValue.length >= 2 && eqValue[eqValue.length - 1] === openingQuote;
        return quoted ? `${prefix}=${openingQuote}***${openingQuote}` : `${prefix}=***`;
    });
}

export function maskUrlQuery(url) {
    const text = String(url);
    // A masked credential is always a `name=value` pair, so a text carrying no `=` cannot change: this is the warm path
    // of the request summary line (`loggableUrl()` runs it on every `/v1/*` request at the default level), and most
    // request targets carry no query string at all.
    if (!text.includes('=')) return text;
    return text.replace(/([?&#;])([^=&#?;]+)=([^&#;]*)/g, (match, separator, name, value) =>
        (isSensitiveHeader(decodeQueryName(name)) ? `${separator}${name}=***` : match));
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
/**
 * Mask the `user:pass@` of every `scheme://` URL in a piece of text, whatever the credential contains.
 *
 * The rule both `maskBackendUrl()` and `maskUrlCredentials()` rely on, and the one the smoke suite pins down: the
 * userinfo of a URL ends at the **last** `@` that lies between its scheme's `://` and the next scheme, and every
 * character between the two is a credential.
 *
 * That "last `@`" is what makes a credential containing a reserved character work. `http://alice:s3#cr3t@host:4097`
 * and `http://alice:s3/cr3t@host:4097` are both spellings a generated password - or a value decoded once too often -
 * really produces, and a strict parse reads the `/`, `?` or `#` in them as the end of the authority. A pattern classed
 * `[^/?#]*@` therefore never reached the `@` at all: it matched nothing and returned the value **unchanged**, so
 * `/health` (which needs no key) published the operator's intended secret, and so did the startup summary. A masker
 * fails closed, and the reserved-character spelling is the one that must lose - reading a path `@` as a credential
 * costs a cosmetic detail in a log line, while reading a credential `@` as a path publishes a secret.
 *
 * The one case that is *not* a credential is an `@` with a `/` before it and nothing after it but a path: an `@` in a
 * path is not userinfo (`http://host:4097/a@b`), and masking it would corrupt a value that never held a credential.
 * That is what the "next scheme" bound and the `/` test below decide between.
 *
 * Only the credential is replaced: scheme, host, port and path stay readable. Every `indexOf()` starts where the
 * previous one stopped, so the pass is linear on arbitrary text - each character is read a constant number of times,
 * and no global regex restarts at every offset.
 * @param {string} text the text to rewrite
 * @returns {string} the text with every `scheme://userinfo@` reduced to `scheme://**
 * Mask the `user:pass@` of every `scheme://` URL in a piece of text, whatever the credential contains.
 *
 * The rule both `maskBackendUrl()` and `maskUrlCredentials()` rely on, and the one the smoke suite pins down: after a
 * scheme's `://`, the userinfo ends at the first `@` that has no plain `@` and no `/` before it, and everything from
 * the scheme to that `@` is a credential.
 *
 * - A `/` before it means the `@` sits in a path rather than in userinfo - `http://host:4097/a@b` is a path, and
 *   masking it would corrupt a value that never held a credential. A plain `@` before it means userinfo already ended
 *   at that earlier one. In either case the scan moves past this `@` and tries the next.
 * - Otherwise the pair is userinfo, which is what makes a credential containing a reserved character work:
 *   `http://alice:s3#cr3t@host:4097` and `http://alice:s3/cr3t@host:4097` are spellings a generated password - or a
 *   value decoded once too often - really produces, and a strict parse reads the `/`, `?` or `#` in them as the end of
 *   the authority. A pattern classed `[^/?#]*@` never reached the `@` at all: it matched nothing and returned the
 *   value **unchanged**, so `/health` (which needs no key) published the operator's intended secret, and so did the
 *   startup summary.
 *
 * A masker fails closed, and the reserved-character spelling is the one that must lose: reading a path `@` as a
 * credential costs a cosmetic detail in a log line, while reading a credential `@` as a path publishes a secret.
 *
 * Only the credential is replaced: scheme, host, port and path stay readable. Every `indexOf()` starts where the
 * previous one stopped, so the pass is linear on arbitrary text - each character is read a constant number of times,
 * and no global regex restarts at every offset.
 * @param {string} text the text to rewrite
 * @returns {string} the text with every `scheme://userinfo@` reduced to `scheme://**
 * Mask the `user:pass@` of every `scheme://` URL in a piece of text, whatever the credential contains.
 *
 * The rule both `maskBackendUrl()` and `maskUrlCredentials()` rely on, and the one the smoke suite pins down: after a
 * scheme's `://`, the userinfo ends at the first `@` that no plain `@` and no `/` precedes.
 *
 * - A plain `@` before it means userinfo already ended, and a `/` before it means the `@` is in a path rather than in
 *   userinfo - `http://host:4097/a@b` is a path, and masking it would corrupt a value that never held a credential. In
 *   both cases the scan moves past that `@` and looks at the next one.
 * - Otherwise everything from the scheme to that `@` is userinfo, and it is replaced with `***`.
 *
 * The non-`/` half is what makes a credential containing a reserved character work. `http://alice:s3#cr3t@host:4097`
 * and `http://alice:s3/cr3t@host:4097` are spellings a generated password, or a value decoded once too often, really
 * produces - and a strict parse reads the `/`, `?` or `#` as the end of the authority. A pattern classed `[^/?#]*@`
 * therefore never reached the `@` at all: it matched nothing and returned the value **unchanged**, so `/health` (which
 * needs no key) published the operator's intended secret and so did the startup summary. A masker fails closed, and the
 * reserved-character spelling is the one that must lose: reading a path `@` as a credential costs a cosmetic detail in
 * a log line, while reading a credential `@` as a path publishes a secret.
 *
 * Only the credential is replaced: scheme, host, port and path stay readable. Every `indexOf()` starts where the
 * previous one stopped, so the pass is linear on arbitrary text - each character is read a constant number of times,
 * and no global regex restarts at every offset.
 * @param {string} text the text to rewrite
 * @returns {string} the text with every `scheme://userinfo@` reduced to `scheme://**
 * Mask the `user:pass@` of every `scheme://` URL in a piece of text, whatever the credential contains.
 *
 * The rule both `maskBackendUrl()` and `maskUrlCredentials()` rely on, and the one the smoke suite pins down: within
 * one URL (from its scheme's `://` to the next scheme), walk the `@`s and take the first one whose preceding run has
 * **no `/` and no earlier `@`**. Everything from the scheme to that `@` is the userinfo, and it is replaced with `***`.
 *
 * The two halves of that test are each a case the others get wrong:
 *
 * - no earlier `@` means userinfo has not already ended at an earlier one, so this `@` is its terminator;
 * - no `/` means the `@` is userinfo rather than part of a path - `http://host:4097/a@b` is a path, and masking it
 *   would corrupt a value that never held a credential;
 * - but a `/` that appears **only after a candidate was rejected** is the one a reserved character produces:
 *   `http://alice:s3#cr3t@host:4097` and `http://alice:s3/cr3t@host:4097` are spellings a generated password - or a
 *   value decoded once too often - really produces, and a strict parse reads their `/`, `?` or `#` as the end of the
 *   authority. A pattern classed `[^/?#]*@` never reached the `@` at all, so it matched nothing and returned the value
 *   **unchanged**: `/health` (which needs no key) published the operator's intended secret, and so did the startup
 *   summary. Once the run before a rejected candidate held a `/`, the slash is consumed as part of the credential, and
 *   the next `@` is judged on its own run.
 *
 * A masker fails closed, and the reserved-character spelling is the one that must lose: reading a path `@` as a
 * credential costs a cosmetic detail in a log line, while reading a credential `@` as a path publishes a secret.
 *
 * Only the credential is replaced: scheme, host, port and path stay readable. Every `indexOf()` starts where the
 * previous one stopped, so the pass is linear on arbitrary text - each character is read a constant number of times,
 * and no global regex restarts at every offset.
 * @param {string} text the text to rewrite
 * @returns {string} the text with every `scheme://userinfo@` reduced to `scheme://**
 * Mask the `user:pass@` of every `scheme://` URL in a piece of text, whatever the credential contains.
 *
 * The rule both `maskBackendUrl()` and `maskUrlCredentials()` rely on, and the one the smoke suite pins down: within
 * one URL (from its scheme's `://` to the next scheme), an `@` ends the userinfo when
 *
 * - no `/` and no earlier `@` lies between the scheme and it, or
 * - what follows it looks like an authority (`host:port`, or a host followed by `/`, `?` or `#`).
 *
 * The second half is what makes a credential containing a reserved character work. `http://alice:s3#cr3t@host:4097`
 * and `http://alice:s3/cr3t@host:4097` are spellings a generated password - or a value decoded once too often -
 * really produces, and a strict parse reads their `/`, `?` or `#` as the end of the authority. A pattern classed
 * `[^/?#]*@` never reached the `@` at all, so it matched nothing and returned the value **unchanged**: `/health`
 * (which needs no key) published the operator's intended secret, and so did the startup summary.
 *
 * The first half is what keeps an `@` **in a path** readable: `http://host:4097/a@b` has a `/` before its `@` and `b`
 * after it is not a host, so it is a path and masking it would corrupt a value that never held a credential - while
 * `http://host:4097/a@b:1` still ends in an authority and is masked.
 *
 * A masker fails closed, and the reserved-character spelling is the one that must lose: reading a path `@` as a
 * credential costs a cosmetic detail in a log line, while reading a credential `@` as a path publishes a secret.
 *
 * Only the credential is replaced: scheme, host, port and path stay readable. Every `indexOf()` starts where the
 * previous one stopped, so the pass is linear on arbitrary text - each character is read a constant number of times,
 * and no global regex restarts at every offset.
 * @param {string} text the text to rewrite
 * @returns {string} the text with every `scheme://userinfo@` reduced to `scheme://***@`
 */
const maskUserinfoAfterScheme = (text) => {
    const value = String(text);
    // A URL with userinfo needs both markers; this runs on every request log line and most carry neither.
    if (!value.includes('://') || !value.includes('@')) return value;
    let out = '';
    let from = 0;
    let searchAt = 0;
    for (;;) {
        const schemeAt = value.indexOf('://', searchAt);
        if (schemeAt === -1) break;
        const authorityStart = schemeAt + 3;
        // One URL runs to the next scheme; nothing may be read past it, or two URLs in a sentence would share one `@`.
        const nextSchemeAt = value.indexOf('://', authorityStart);
        const urlEnd = nextSchemeAt === -1 ? value.length : nextSchemeAt;
        // Walk this URL's `@`s for the one that ends its userinfo.
        let at = value.indexOf('@', authorityStart);
        let terminator = -1;
        while (at !== -1 && at < urlEnd) {
            const run = value.slice(authorityStart, at);
            if (!run.includes('@') && !run.includes('/')) {
                terminator = at;
                break;
            }
            // A `/` or an earlier `@` before this one: it is userinfo only when what follows looks like an authority
            // (`host`, optionally `:port`, optionally a path/query/fragment) - the reserved-character credential case.
            if (/^[^\s/?#@]+(?::\d+|[/?#])/.test(value.slice(at + 1, urlEnd))) {
                terminator = at;
                break;
            }
            at = value.indexOf('@', at + 1);
        }
        // Nothing in this URL is userinfo: move to the next scheme, and stop when there is none.
        if (terminator === -1) {
            if (nextSchemeAt === -1) break;
            searchAt = nextSchemeAt;
            continue;
        }
        out += `${value.slice(from, authorityStart)}***@`;
        if (terminator >= from) from = terminator + 1;
        // Resume at the next scheme, so a `://` inside the credential that was just masked
        // (`http://alice:s3/cr3t@host`) is never read as a second URL.
        const afterSchemeAt = value.indexOf('://', from);
        if (afterSchemeAt === -1) break;
        searchAt = afterSchemeAt;
    }
    return out + value.slice(from);
};




export function maskBackendUrl(url) {
    const text = maskUrlQuery(String(url));
    // Everything between the scheme and the **last** `@` is userinfo (`user:pass`), and the last `@` is the one that
    // separates it from the host in every spelling an operator writes.
    //
    // The scheme is optional, because the value `normalizeBackendUrl()` is about to *correct* is the one it also quotes:
    // `OPENCODE_SERVER_URL='alice:s3cr3t@host:4398' has no scheme, assuming http://` was built from the raw value before
    // the scheme was added, and a pattern anchored on `scheme://` left that credential in the startup log - the one line
    // that publishes a secret to `docker logs`, in a configuration the gateway supports and repairs.
    //
    // The userinfo run deliberately does **not** stop at `/`, `?` or `#`. A credential containing one of them is written
    // `http://alice:s3#cr3t@host:4097` (a generated password, a URL-encoded value that was decoded once too often), and
    // a pattern that ended the authority at the reserved character never reached the `@` at all: it matched nothing and
    // returned the value **unchanged**, so `/health` - which needs no key - published the operator's intended secret and
    // so did the startup summary. Failing closed is the only safe direction for a masker: a URL whose *path* contains an
    // `@` is reported as `scheme://***@…`, which costs a cosmetic detail in a log line and never a secret.
    // The userinfo scan is shared with `maskUrlCredentials()` (`maskUserinfoAfterScheme`). This function used to carry
    // its own `at`/`rest` split here, and the free-text masker carried a *different* one whose class stopped at the
    // authority delimiters - so the same URL was masked by one and published by the other. The hostless case is still
    // the reason this cannot simply be "mask everything before the last `@`": what follows the `@` may be a path, a
    // query or a fragment rather than a host, so there is no authority left to keep readable, and the run *before* the
    // `@` is still the operator's credential. Only a bare trailing `@` (`http://host@`, with no userinfo in front of it)
    // A value with no scheme is masked whole, because every character before its `@` is userinfo.
    if (looksLikeSchemeLessUrl(text)) {
        const at = text.lastIndexOf('@');
        return `***${text.slice(at)}`;
    }
    return maskUserinfoAfterScheme(text);
}

// The length of a leading `scheme://` run, or 0 when the value carries none. `normalizeBackendUrl()` *corrects* a value
// like `alice:s3cr3t@host:4398` (it adds the scheme) and then quotes the raw value back in its `[Config]` note, so the
// scheme-less spelling is a credential-bearing URL that reaches the startup log - the one line that publishes a secret
// to `docker logs`. `maskUrlCredentials()` cannot mask that shape (see its own comment: without a `://` anchor, any
// colon in prose would start a match), but a configured backend URL is exactly the case where the whole run before the
// `@` *is* userinfo, so `maskBackendUrl()` masks it whole.
const looksLikeSchemeLessUrl = (text) => {
    const at = text.lastIndexOf('@');
    if (at <= 0) return false;
    // A leading `scheme://` means the scheme-qualified scan owns the value; a `://` later in the text (a path, a query,
    // a sentence quoting two URLs) does not make the value a scheme-less URL, so it is read from the start.
    return !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text);
};

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
// URI schemes whose `name:value@text` shapes are addresses, not credentials - `mailto:` first: an e-mail address is the
// one `user:pass@host` lookalike a log line carries in bulk. Fixed vocabulary, so a set is the whole rule.
const NON_CREDENTIAL_SCHEMES = new Set([
    'mailto', 'tel', 'sms', 'data', 'file', 'urn', 'news', 'xmpp', 'javascript', 'about', 'magnet', 'geo'
]);

export function maskUrlCredentials(text) {
    const value = String(text);
    // Masking needs userinfo, which needs an `@`: this runs on every request log line and on every upstream sentence,
    // and the vast majority of both carry none.
    if (!value.includes('@')) return value;
    // Two cheap necessary conditions. The scan below cannot find userinfo without a literal `://`, and the scheme-less
    // rule cannot match without a `:` somewhere before the last `@` (its match is `boundary user ":" secret "@"`, so
    // `indexOf(':') < lastIndexOf('@')` is implied by any match). Neither test can change the output - they only skip a
    // scan that provably finds nothing - and together they answer the shapes a client can send for the price of two
    // `indexOf()` calls: `/v1/models?@` + 16 000 `a` carries neither `://` nor `:` and measured 1.2 ms of blocked
    // serving thread before, ~0 afterwards.
    const lastAt = value.lastIndexOf('@');
    const firstColon = value.indexOf(':');
    const schemeLess = firstColon !== -1 && firstColon < lastAt;
    // The scheme-qualified pass is `maskUserinfoAfterScheme()`, shared with `maskBackendUrl()`. It replaced a regex whose
    // userinfo class stopped at `/`, `?` or `#`: that class could never reach the `@` of `http://alice:s3#cr3t@host`, so
    // the credential came back **unchanged** in a client-facing 502 and in the log line. Its scan is anchored on each
    // `://` instead of being retried at every offset, which is what keeps it linear on arbitrary text.
    const scheme = value.includes('://') ? maskUserinfoAfterScheme(value) : value;
    // A URL written **without** a scheme is the form `normalizeBackendUrl()` repairs and then quotes back, and it is the
    // form a hand-written sentence uses (`connect alice:s3cr3t@proxy failed`): requiring `scheme://` left both in clear.
    // The `:` before the `@` is what separates userinfo from an e-mail address, so `alice@example.com` - the shape a
    // log line carries in bulk - is still left alone, and the name class cannot cross a separator or `:`.
    //
    // `mailto:someone@example.com` is the shape that breaks that rule: read literally, `mailto` is the user name, the
    // `:` is the separator and the address is the credential, so the text was rewritten to `***@example.com` - not an
    // address any more, and never a secret. The two are told apart by what follows the `@`: an authority (`host:port`,
    // or a host followed by a path/query/fragment) proves a credential whatever the leading word is, and a bare host
    // does too unless the leading word is a URI scheme the login and address forms use.
    // The name class cannot cross a separator, `:`, `=` or a quote: `KEY=user:pass@host` is a note naming the value, and
    // starting at the `=` keeps the key readable while the credential goes.
    // The scheme-less secret run is bounded (`{0,256}`) for the same reason the scheme run above is: `[^…]*` had to reach
    // the `@` to succeed, so a target with one `@` early and no other retried the scan from every `=`, `:`, quote and space
    // after it - `/v1/@x==a:=a:=a:…` measured 1.2 ms at 3 KiB, 16.9 ms at 12 KiB and 126 ms at 32 KiB, quadratic, on
    // the request-summary line that is built before the auth check (the debug body dump hits the same rule with every
    // string it masks, at 32 KiB each). The shared `://` scan above masks a real `scheme://user:pass@` credential of any
    // length, so this rule only ever sees the scheme-less form a hand-written sentence or `normalizeBackendUrl()`
    // produces, where 256 characters is far beyond any credential: measured 31.1 ms -> 2.3 ms at 16 KiB, byte-identical
    // output on every credential-bearing shape.
    //
    // The secret class keeps excluding whitespace, for the reason a class that allowed it would not be usable here: with
    // no `://` to anchor it, a class that allowed spaces would match from any `:` earlier in the sentence (`the admin:
    // bob@example.com replied` reads as user `admin`, secret ` bob`) and rewrite ordinary prose. The scheme-less spelling
    // of a credential containing a space is therefore not covered here; `maskFreeText()` masks it through the `://` scan
    // when a scheme is present, and `maskBackendUrl()` covers the configured URL by construction.
    if (!schemeLess) return scheme;
    return scheme.replace(
        /(^|[\s="'(<])([^\s/?#@"'()<>=:]+):([^\s/?#@]{0,256})@(?=[^\s/?#@]+)/g,
        (match, boundary, user, secret, offset, whole) => {
            const afterAt = whole.slice(offset + match.length);
            const looksLikeAuthority = /^[^\s/?#@]+(?::\d+|[/?#])/.test(afterAt);
            return looksLikeAuthority || !NON_CREDENTIAL_SCHEMES.has(user.toLowerCase())
                ? `${boundary}***@`
                : match;
        });
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

// The credentials this process actually holds, removed **by value** from any text that leaves it.
//
// `maskQuotedCredentials()` needs 16 characters of token to tell a credential from prose ("basic setup", "Bearer of good
// news"), and `base64("u:pw")` is 8: the gateway's own backend credential, echoed back by a proxy that refused it, is
// the one credential a reader can pair with the host it opens. `clientFacingText()` removes it by value, but that is
// the client-facing copy only - the log-side chain (`maskFreeText()`, `loggableError()`, `maskDetail()`, every stack)
// did not know the value, so a backend that quoted the header inside a JSON body or an error message published it at
// debug. Registered once from `resolveBackendAuth()`, which is the single place that lifts the credential out of
// `OPENCODE_SERVER_URL`, so one `includes()` per registered value stands between the secret and every sentence here.
const sensitiveValues = [];
const MIN_REGISTERED_VALUE_LENGTH = 8;
/**
 * Register a value that must never be printed, whatever text it turns up in.
 * @param {string|null|undefined} value the credential (a token, an encoded header value)
 */
export function registerSensitiveValue(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    // A short value is not a credential: a one-character password would mask every occurrence of that character.
    if (text.length < MIN_REGISTERED_VALUE_LENGTH || sensitiveValues.includes(text)) return;
    sensitiveValues.push(text);
    // Bounded: the list is written by this process, not by a client, and a longer one only slows down every log line.
    if (sensitiveValues.length > 8) sensitiveValues.shift();
}
const redactRegisteredValues = (text) => {
    let out = text;
    for (let i = 0; i < sensitiveValues.length; i += 1) {
        if (out.includes(sensitiveValues[i])) out = out.split(sensitiveValues[i]).join('***');
    }
    return out;
};

// Upstream text on its way to a client or a log line is masked and bounded. A backend (or a proxy in front of it) can
// quote a URL inside an error payload, and a configured backend URL may carry a credential, so every sentence that
// leaves the process goes through the same chain - the `500` body, the `502` body, the request log and the stack a
// fatal handler prints.
const MAX_UPSTREAM_TEXT_CHARS = 512;
// A stack is bounded separately, and much lower: it is written by whatever threw, and 32 KB of frames helps nobody
// (the same limit `safeClone()` applies to an `Error` it copies).
export const MAX_LOGGED_STACK_CHARS = 1000;
// How much of a sentence `maskFreeText()` masks before it truncates (a multiple of the retained length, see there).
// Exported because `src/text.js` bounds a value before it masks one for the same reason (see `boundedForLog()`), and
// the two must not disagree about how much of a value is worth transforming: a value longer than this window can only
// contribute its first `maxChars` characters to the output, because every masking rule shortens what it matches.
export const MASK_TEXT_WINDOW_FACTOR = 16;

// Only the URL-shaped words of the text are masked. `maskUrlQuery()` is written for a URL: given a sentence it
// read everything after the first `?` as that parameter's value, so `…?x=1: connection refused` answered
// `…?x=***` and lost the half of the reason that explains the failure.
//
// The words are found by splitting on whitespace rather than with `/\S+:\/\/\S+/`, which backtracked over a
// million-character token with no `://` in it one character at a time: a provider error of 1 MB parked the request
// for longer than its whole budget. `includes('://')` decides per token, and a token is at most a word.
//
// A **relative** URL carries a credential too (`backend said: /session?token=SECRET42 failed`, and a debug detail whose
// endpoint has no host): requiring `://` skipped the query masking as well, so the value went out in clear although the
// rule ("a URL is masked") already promised it. A token needs nothing but a `=` to be a candidate for that; the
// per-token `maskUrlQuery()` call decides, and it cannot mask ordinary prose (`x=1:` carries no pair separator).
//
// One pass over the whole string handles a credential whose userinfo contains a **space** (`http://alice:s3 cr3t@host`):
// splitting into whitespace-delimited tokens first cut that credential in half, and the tail then read as ordinary prose,
// so the password survived while the rule appeared to have run. The split is kept for the query rule (it must not see a
// sentence as one URL), but the credential rule runs on the unsplit text first - a bounded, anchored scan that is
// skipped entirely when the text carries no `://` or no `user:pass@` shape at all.
//
// That pass covers **both** spellings. `maskUrlCredentials()` masks a scheme-qualified userinfo
// (`http://user:secret@host:4097`) and, when the text carries no `://`, a scheme-less `user:secret@host` as well
// (`connect alice:s3cr3t@proxy failed` - the shape `normalizeBackendUrl()` repairs and then quotes back, and the shape
// a hand-written sentence uses). Its scheme-less secret class cannot cross whitespace on purpose: without the `://`
// anchor, a class that allowed spaces would match `the admin: bob@example.com` from any colon earlier in the sentence.
// A scheme-less credential **containing a space** is therefore the one shape this rule leaves alone, and it is not
// reachable from anything the gateway composes: `normalizeBackendUrl()` adds the scheme before a value is quoted into
// a `[Config]` note, and `maskBackendUrl()` masks the userinfo whatever it contains. The residual case is a
// third-party sentence quoting such a URL verbatim.
export function maskUrlsInText(text) {
    const value = String(text);
    // `@` is a candidate on its own: a credential written **without** a scheme (`connect alice:s3cr3t@proxy failed`,
    // the form `normalizeBackendUrl()` repairs and a hand-written sentence uses) carries neither `://` nor `=`, so the
    // early return below skipped the one rule that recognises it and the sentence was published verbatim although
    // `maskUrlCredentials()` documents that form as covered. `maskUrlCredentials()` itself needs no `://` and no `=`
    // to decide - it looks for a `:` before the last `@` - and a text with no `@` at all leaves it at its own warm
    // exit, so the extra call costs one `lastIndexOf()` on the sentences that carry an address at all.
    if (!value.includes('://') && !value.includes('=') && !value.includes('@')) return value;
    const withSchemeCredentials = value.includes('://') || value.includes('@') ? maskUrlCredentials(value) : value;
    if (!withSchemeCredentials.includes('=')) return withSchemeCredentials;
    return withSchemeCredentials
        .split(/(\s+)/)
        .map((token) => {
            const withCredentials = token.includes('://') ? maskUrlCredentials(token) : token;
            return withCredentials.includes('=') ? maskUrlQuery(withCredentials) : withCredentials;
        })
        .join('');
}

// A value that did not come from this process can carry control characters - a newline in an upstream error payload,
// a tab in a provider sentence - and every `loggable*` helper in `src/text.js` replaces them, so a value put into a log
// *message* (not a detail object, which escapes them through `JSON.stringify`) could start a second record the gateway
// never wrote. `maskFreeText()` is the single chain every outbound sentence passes through, so it is the one place that
// has to apply the same rule. The regex is duplicated here rather than imported from `src/text.js` because that module
// already imports from this one, and a shared constant would close the cycle into an import error at load time.
const MASK_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Free text that is about to leave the process - a client-facing 5xx sentence, an error log line, a stack, a string
 * inside a debug dump - masked and bounded in one place.
 *
 * Three credentials can hide in a sentence and none of them is the sentence's own: a URL carrying userinfo or a query
 * value (`http://user:secret@host:4097/session?token=…`, which Node's `fetch` refuses out loud), an authorization
 * header value a proxy echoed back (`Authorization: Basic b3BzOnMzY3I…`), and a bare `name=value` pair or CLI flag
 * (`opencode --api-key=…`, `x-api-key=…`) copied out of a wrapper's command line. All three used to reach a client
 * body and `docker logs` verbatim; masking one and not the others is why the chain lives here rather than at each
 * call site.
 * @param {*} value any text (non-strings are stringified the way `maskUrlQuery` does it)
 * @param {number} [maxChars] length bound; 512 by default, and the marker matches `loggableUrl()`
 * @returns {string} the masked, bounded text
 */
export function maskFreeText(value, maxChars = MAX_UPSTREAM_TEXT_CHARS) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    // Bound the work before masking it, not after. `maskUrlsInText()` splits the sentence and rebuilds it, and only the
    // first `maxChars` characters survive: a 1 MB provider error carrying URLs cost ~10 ms of the serving thread
    // (measured: 0.3 ms with no `://`, 4.8 ms with one and no `@`, 10.2 ms with URLs) to keep 0.05 % of it. The window
    // is 16× the retained length because masking *shortens* the text - a credential early in the sentence shifts later
    // characters left into the retained window - and the final truncation below still applies unchanged.
    const window = Number.isFinite(maxChars) && maxChars > 0 ? maxChars * MASK_TEXT_WINDOW_FACTOR : 0;
    const bounded = window && text.length > window ? text.slice(0, window) : text;
    // `maskCredentialPairs()` runs before the URL rules for the same reason it runs inside `loggableUrl()`: a
    // `name=value` pair is not a URL, and the URL rule only ever looks at a `?`, `&`, `#` or `;` in front of a name.
    // Without it a sentence that quotes a CLI flag (`opencode --api-key=…`) or a bare pair (`x-api-key=…`) was
    // published verbatim, because the separator the URL rule needs is a query separator and a flag has a space.
    const masked = redactRegisteredValues(maskQuotedCredentials(maskCredentialPairs(maskUrlsInText(bounded))))
        .replace(MASK_CONTROL_CHARS_RE, '?');
    if (!Number.isFinite(maxChars) || masked.length <= maxChars) return masked;
    return `${masked.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
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
        const value = headers[name];
        setOwnProperty(masked, name, isSensitiveHeader(name) ? maskSecret(value) : value);
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
        // The cap is lower than `safeClone()`'s because masking walks every member; leaving it silent made a debug dump
        // of a long conversation look complete. `debugBounded()` skips the second walk that would have annotated it, so
        // the marker has to be added here.
        if (value.length > 100) out.push(`[+${value.length - 100} more items]`);
    } else {
        out = {};
        const allKeys = Object.keys(value);
        const keys = allKeys.length > 100 ? allKeys.slice(0, 100) : allKeys;
        keys.forEach((key) => {
            const entry = value[key];
            setOwnProperty(out, key, isSensitiveHeader(key) ? maskSecret(entry) : maskDetail(entry, seen, depth + 1));
        });
        if (allKeys.length > keys.length) out['[hiddenKeys]'] = allKeys.length - keys.length;
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

    function write(stream, levelName, message, detail, preBoundedDetail = false) {
        // A logging call must never be the thing that fails a request: the message is interpolated into the line, so a
        // non-string (a Symbol throws on coercion) would surface as an exception from inside the logger
        const text = typeof message === 'string' ? message : String(message);
        let line = `${prefix} ${isoTimestamp()} [${levelName.toUpperCase()}] ${text}`;
        if (detail !== undefined) {
            const serialized = serializeDetail(detail, preBoundedDetail);
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
        },
        /**
         * debug level for a detail that `maskDetail()` already masked and bounded. The function is the contract: it
         * promises an acyclic copy whose depth, member count and string lengths are capped, which is what
         * `serializeDetail(value, true)` relies on to skip the second tree walk. Anything else (a bare request body, a
         * backend payload) belongs in `debug()`, which clones and bounds it itself.
         */
        debugBounded(message, detail) {
            if (LEVELS[state.level] >= LEVELS.debug) write(process.stdout, 'debug', message, detail, true);
        }
    };
}

// Process-wide default instance: initialized from the LOG_LEVEL environment variable (startProxy re-calibrates it
// against its options and emits a warning when needed)
export const logger = createLogger({ level: process.env.LOG_LEVEL });
