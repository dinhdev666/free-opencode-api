/**
 * The sentences this gateway shows a client when something upstream failed.
 *
 * Every one of them is text the process did not compose: a backend sentence, a proxy's refusal, an OS message quoting a
 * path. Such a sentence can carry a credential (a URL with userinfo, an `Authorization` header echoed back by a proxy
 * that refused it), so it goes through one chain before it leaves - the response body and the log line print the same
 * words, and masking one while leaving the other in clear is how the token reached `docker logs`.
 */
import { maskFreeText } from './logger.js';

/**
 * Upstream text on its way to a client or a log line: masked and bounded.
 *
 * A backend (or a proxy in front of it) can quote a URL inside an error payload, and a configured backend URL may carry
 * a credential - Node's `fetch` answered `Request cannot be constructed from a URL that includes credentials:
 * http://user:secret@host:4097/session`, which reached the client-facing 502 body and this process's log verbatim. A
 * proxy can also echo the `Authorization: Basic …` header it refused, which is the credential the gateway lifted out of
 * `OPENCODE_SERVER_URL` and sent as a header.
 *
 * The chain itself lives in `src/logger.js` (`maskFreeText()`), because the same sentence is written to a response body
 * *and* to a log line, and a second copy of it here is how the two drifted apart: the 500 body was masked while the
 * `stack` field of the same log record printed it verbatim.
 * @param {*} value any text (non-strings become '')
 * @returns {string} the masked, bounded text
 */
export const clientFacingText = (value) => {
    if (typeof value !== 'string' || value === '') return '';
    // The by-value removal of the gateway's own backend credential lives in `maskFreeText()` now
    // (`registerSensitiveValue()`): the log-side chain needed the same rule, and a second copy here is how the two
    // would drift - the body was masked while the `stack` field of the same record printed the token.
    return maskFreeText(value);
};

/**
 * What a `500` says when the handler was rejected with something that carries no message at all. Declared before
 * `handlerFailureMessage()` reads it, so the sentence cannot be a `ReferenceError` from a `const` read ahead of its
 * declaration.
 * @type {string}
 */
export const HANDLER_FAILURE_FALLBACK = 'the request handler failed';

/**
 * The sentence a failed completion shows a client and logs, read from whatever the route handler caught.
 *
 * `error.message` is the usual shape, but the handler can also be rejected with something else - a thrown string, an
 * object without a `message`, a library that throws `undefined`. `String(error)` named two of those shapes instead of
 * describing them: `undefined` answered the literal `"undefined"`, `null` answered `"null"` and `{}` answered
 * `"[object Object]"`, and each was then printed as the cause of a `500` in a client body and in the log line.
 * Anything that is not a message - including an **empty** one - is therefore described
 * (`HANDLER_FAILURE_FALLBACK`) rather than stringified: a body whose `message` is `""` sends the reader nowhere, and
 * an invented `Error` would name a cause that does not exist.
 * @param {*} error whatever was thrown or rejected with
 * @returns {string} the sentence to send and log
 */
export const handlerFailureMessage = (error) => {
    // A thrown string is a message the author wrote, so it is kept; anything else that is not an object with a string
    // `message` (`undefined`, `null`, `{ code: 'EPIPE' }`) is described instead of stringified.
    const raw = typeof error?.message === 'string'
        ? error.message
        : (typeof error === 'string' ? error : '');
    const masked = clientFacingText(raw);
    return masked || raw || HANDLER_FAILURE_FALLBACK;
};

/**
 * The sentence a provider failure shows a client when the provider gave no text of its own.
 *
 * One constant for both answer modes: the streaming path and the non-streaming one each had their own fallback
 * (`Unknown error`, `OpenCode provider error`), so the same failed completion read differently depending on whether the
 * client asked for a stream.
 * @type {string}
 */
export const PROVIDER_FAILURE_FALLBACK = 'the model provider returned an error';