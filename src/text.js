/**
 * Text, byte and clock helpers shared by the gateway modules.
 *
 * Everything here is pure apart from reading `PATH`, and none of it knows about HTTP, the backend or the queue, so any
 * other module may depend on it. The values built here are all on their way into a log line or a response body, which is
 * why the bounds live in one place: one log line is one record, and a client-controlled value carrying a newline would be
 * read as a *second* one (a forged request summary, a fake `[Security]` line), an ANSI escape would reach the operator's
 * terminal, and an unbounded value would turn one request body into an arbitrarily large record.
 */
import { maskUrlCredentials, maskUrlQuery } from './logger.js';

/**
 * Control characters, including the DEL and the C1 range: replaced wherever a value that did not come from this process
 * is put into a log line, a response body or a prompt line.
 * @type {RegExp}
 */
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

/**
 * A value cut to `maxLen` characters with its control characters replaced, plus the cut marker when it was cut.
 *
 * The bound is applied *before* the replace, because the regex is per character: a client value at the 50 MiB body limit
 * is then not transformed in full just to keep a couple of hundred characters of it (measured 3.9 ms for 5 MiB). The
 * output is the same either way - the replace is one character for one character.
 * @param {unknown} raw
 * @param {number} maxLen
 * @param {boolean} [counted] name how much was cut, instead of a bare ellipsis
 * @returns {string}
 */
const boundedForLog = (raw, maxLen, counted = true) => {
    const value = String(raw);
    const clean = (value.length > maxLen ? value.slice(0, maxLen) : value).replace(CONTROL_CHARS_RE, '?');
    if (value.length <= maxLen) return clean;
    return counted ? `${clean}…[truncated ${value.length - maxLen} chars]` : `${clean}…`;
};

// Two completions that reach this counter in the same millisecond used to receive the same `chatcmpl-<epoch>` id (a
// client that keys its messages by id merged two answers); the counter keeps ids distinct without a random source, and
// the millisecond stamp keeps them roughly sortable.
let completionIdSeq = 0;

/**
 * A completion id, unique per response.
 * @returns {string} `chatcmpl-<base36 stamp><counter>`
 */
export const newCompletionId = () => `chatcmpl-${Date.now().toString(36)}${String(completionIdSeq++).padStart(3, '0')}`;

/**
 * Resolves after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The type of a value from a request body as a word, for an error message that names what arrived. `Array.isArray`
 * comes first because `typeof []` is `'object'`: the reader of "found an object" would be told the field they sent is
 * the wrong kind of object without ever learning what it actually was.
 * @param {unknown} value
 * @returns {string}
 */
export function jsonTypeName(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    const type = typeof value;
    if (type === 'object') return 'an object';
    if (type === 'number') return 'a number';
    if (type === 'boolean') return 'a boolean';
    if (type === 'string') return 'a string';
    return type;
}

const MAX_LOGGED_MODEL_LENGTH = 128;
const MAX_LOGGED_URL_LENGTH = 512;
const MAX_LOGGED_CONFIG_LENGTH = 128;
// An OS or upstream sentence is bounded lower than a URL: it is prose quoting a path, not an address.
const MAX_LOGGED_UPSTREAM_LENGTH = 256;
// A client-supplied value echoed into a response body. The marker is the same one a log line uses, so a truncated value
// reads the same wherever it appears.
export const MAX_ECHOED_VALUE_LENGTH = 64;

/**
 * A model id on its way into a log line.
 *
 * The id is normalised for logging only; the backend still receives it verbatim, because the contract does not restrict
 * model ids - only what is logged.
 * @param {unknown} id
 * @returns {string}
 */
export const loggableModelId = (id) => boundedForLog(id, MAX_LOGGED_MODEL_LENGTH, false);

/**
 * A client-supplied value on its way into a response body: bounded, with its control characters replaced.
 * @param {unknown} value
 * @returns {string}
 */
export const echoedValue = (value) => boundedForLog(value, MAX_ECHOED_VALUE_LENGTH);

/**
 * An operator-supplied value on its way into a log line, under the rule client input follows: `config.json` and the
 * environment are text a script can write, so a path or a level is no more trustworthy than a model id.
 * @param {unknown} value
 * @returns {string}
 */
export const loggableConfigValue = (value) => boundedForLog(value, MAX_LOGGED_CONFIG_LENGTH);

/**
 * Text quoted from an OS or upstream error, on its way into a log line.
 *
 * `spawn()` repeats the command back inside its error message, so `[Proxy] Failed to spawn OpenCode: ${err.message}`
 * quoted `OPENCODE_PATH` verbatim and a newline in it started a second record the gateway never wrote.
 * @param {unknown} value
 * @returns {string}
 */
export const loggableUpstreamText = (value) => boundedForLog(value, MAX_LOGGED_UPSTREAM_LENGTH);

/**
 * A request URL on its way into a log line or a response body: credential query values masked, userinfo masked, and an
 * unbounded URL cut, because the URL is client input bounded only by the HTTP parser's header limit.
 *
 * A URL can carry credentials in its userinfo as well, which `maskUrlQuery()` does not touch: an HTTP client may send an
 * **absolute-form** request target (`GET http://user:secret@host:4097/v1/models HTTP/1.1`), and Node hands that target
 * over verbatim. The chain is the same one `maskFreeText()` uses.
 * @param {string} url raw request URL
 * @returns {string}
 */
export const loggableUrl = (url) => boundedForLog(maskUrlCredentials(maskUrlQuery(url)), MAX_LOGGED_URL_LENGTH);

/**
 * The request target without its query string, which the access log and the 404 body want.
 *
 * `url.split('?')[0]` allocated an array plus a second string on every request - including the ones that carry no query
 * at all - where an index scan answers the same value with no allocation in the common `no '?'` case.
 * @param {string} url
 * @returns {string}
 */
export const urlPath = (url) => {
    const query = url.indexOf('?');
    return query === -1 ? url : url.slice(0, query);
};

// The client's own trace id, when it sent one that can be copied into a header and a log line: a short printable token
// only, because the value reaches both. Module scope because the handlers that answer a request the router or the parser
// rejected run before any Fastify hook - and one of them is handed the raw request - echo it too: a client that sets its
// own trace id must find the same id in the response and in the gateway's log line, on every path.
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * The `X-Request-Id` a client sent, when it is safe to echo.
 * @param {{headers?: object}} request a Fastify request or Node's raw one
 * @returns {string|null} the id, or null when none was sent or the value cannot be copied through
 */
export const requestId = (request) => {
    const raw = request?.headers?.['x-request-id'];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return CLIENT_REQUEST_ID_RE.test(trimmed) ? trimmed : null;
};

/**
 * A generated request id, for the refusals that answer before routing (a parse error, a URL that cannot be decoded):
 * those paths log a `warn` line a client could not otherwise connect to its response.
 * @returns {string}
 */
export const generatedRequestId = () => `gw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The message for a phase that ran into its deadline.
 *
 * `remainingBudget()` floors what is left at 1 ms so a timer never gets 0 or a negative value, and interpolating that
 * floor into the message told a client and the log that a 1 500 ms request budget had timed out "after 1ms": an operator
 * reading `docker logs` could not tell a 1.5 s timeout from a 300 s one. A phase handed the floor was given nothing to
 * wait with, so the message says that instead of reporting the floor as if it were the budget.
 * @param {number} timeoutMs
 * @returns {string}
 */
export const timeoutMessage = (timeoutMs) => (timeoutMs <= 1
    ? 'Request timeout: the request budget was used up'
    : `Request timeout after ${timeoutMs}ms`);