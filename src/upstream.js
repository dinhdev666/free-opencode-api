/**
 * Classification of what a backend call threw.
 *
 * Every `@opencode/client` call rejects instead of resolving an error tuple, so every call site has to answer the same
 * questions: is this a deadline, was the connection refused (the one case the gateway retries), and what status and
 * reason should the client-facing sentence carry. The answers live here so two call sites cannot drift apart - the
 * refusal of one route reported as `500 server_error` while another reported `502` for the same backend.
 */
import { clientFacingText } from './errors.js';

/**
 * Whether the backend answered this call, rather than the transport failing before it could.
 *
 * `@opencode/client` builds a thrown error for an HTTP answer as
 * `Object.assign(new Error(body.message), body)` and then sets `error.name = body._tag` when the body carries one, so
 * **every field of a backend error body becomes a property of the thrown value**. The classifiers below therefore
 * cannot tell "node could not connect" from "the backend answered 400 with `{"_tag":"TimeoutError"}`" by reading
 * `name` or `code` - and `isConnectionRefused()` is the gate for the only retry the gateway performs
 * (`session.create` after a backend restart), the one whose duplicate `session.create` can leave a session nobody can
 * delete. Two things prove an answer: a `_tag` (the field OpenCode's error envelope carries, and the one
 * `V2_ERROR_TAG_STATUS` exists for) and a status (a body that repeats it, or the `ClientError` the client throws for a
 * status it has no typed error for, which keeps it at `cause.status`). A body that spoofs only `name` or `code`, with
 * neither of those, is not detectable from the thrown value and is the documented limit of this guard.
 * @param {unknown} error
 * @returns {boolean}
 */
const answeredByBackend = (error) => error?._tag !== undefined || typeof upstreamErrorStatus(error) === 'number';

/**
 * Whether an error is this gateway's own deadline expiring, rather than an upstream refusal.
 *
 * A wedged backend - one that still answers `/health` but never answers `/session` - used to hang the request handler
 * forever: node's fetch has no default timeout, so the SDK promise never settled, the client waited with no answer and
 * the queue slot was never released (at the default concurrency of 1 that stops the whole gateway).
 * @param {unknown} error
 * @returns {boolean}
 */
export const isTimeoutError = (error) => !answeredByBackend(error) &&
    (error?.name === 'TimeoutError' || error?.name === 'AbortError' ||
    error?.code === 'ETIMEDOUT' ||
    // The 2.x client rethrows an expired deadline as its own transport failure, carrying the message only:
    // `ClientError("Transport: The operation was aborted due to timeout")`. That is this gateway's deadline, not an
    // upstream refusal, and reporting it as `500 server_error` told the client the gateway had a bug.
    (typeof error?.message === 'string' && /aborted due to timeout/i.test(error.message)));

/**
 * Whether an error is a transport failure of any kind (as opposed to the backend answering with a refusal).
 * @param {unknown} error
 * @returns {boolean}
 */
export const isConnectionError = (error) => {
    if (answeredByBackend(error)) return false;
    const message = String(error?.message || '');
    return message.includes('fetch failed') ||
        message.includes('ECONNREFUSED') ||
        message.includes('socket hang up') ||
        error?.cause?.code === 'ECONNREFUSED';
};

/**
 * A connection that was *refused* proves nothing reached the backend; `fetch failed` / `socket hang up` do not - the
 * request may have been accepted and only the answer lost.
 *
 * The distinction matters for the one call the gateway retries (`session.create`): retrying a request that may have
 * created a session leaves that first session on the backend with no id in this process, so neither
 * `cleanupSession()` nor the shutdown drain can ever delete it.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isConnectionRefused(error) {
    // An error the backend answered with is never a refused connection, however its body is spelled.
    if (answeredByBackend(error)) return false;
    if (String(error?.message || '').includes('ECONNREFUSED')) return true;
    const cause = error?.cause;
    if (cause?.code === 'ECONNREFUSED') return true;
    // Node's `fetch` wraps the per-address failures (`127.0.0.1:4097`, `::1:4097`) in an AggregateError
    if (Array.isArray(cause?.errors) && cause.errors.some((inner) => inner?.code === 'ECONNREFUSED')) return true;
    // The 2.x client adds a wrapper of its own above Node's error, so the code sits one level deeper than 1.x put it.
    // Walking the chain (bounded, cycle-safe) covers both without guessing a fixed depth.
    for (const link of errorCauseChain(error)) {
        if (link?.code === 'ECONNREFUSED') return true;
        if (Array.isArray(link?.errors) && link.errors.some((inner) => inner?.code === 'ECONNREFUSED')) return true;
    }
    return false;
}

/**
 * The chain of causes behind an error, outermost first.
 *
 * The 1.x SDK handed back a resolved error tuple whose `cause` was Node's own `fetch` error, one level down. The 2.x
 * client *throws* instead, and it wraps: `ClientError("Transport: fetch failed")` → `TypeError("fetch failed")` →
 * `Error(code: ECONNREFUSED)`. Reading only `error.cause.code` therefore found nothing, so a refused backend was
 * reported as a generic unreachable error and the one retry the gateway does (a refused connection proves the request
 * never arrived) never ran.
 *
 * Bounded, because a cause chain is not guaranteed to be a tree: a library that sets `cause` to itself, or two errors
 * that point at each other, would otherwise loop forever on a path that only has to report a failure.
 * @param {unknown} error the thrown value
 * @returns {unknown[]} the outermost error followed by each cause
 */
export function errorCauseChain(error) {
    const chain = [];
    let current = error;
    // Bounded by depth and by a visited set: the depth alone stops a self-referencing cause, the set stops a longer
    // cycle (A causes B causes A) that the depth would only reach more slowly.
    const seen = new Set();
    while (current !== null && current !== undefined && chain.length < 8) {
        if (typeof current !== 'object' && typeof current !== 'string') break;
        if (seen.has(current)) break;
        seen.add(current);
        chain.push(current);
        current = current.cause;
    }
    return chain;
}

/**
 * The status the OpenCode 2.x client's own error classes stand for.
 *
 * A 2.x call rejects with a typed error (`SessionNotFoundError`, `UnauthorizedError`, …) that carries a `_tag` and a
 * message but **no HTTP status**: the generated client turns the response into a domain error and drops the number.
 * Every upstream sentence this gateway reports names a status, and `session.delete` classifies 404/410 as "already
 * gone", so the tag is mapped back onto the status the server sent. An unknown tag maps to nothing, which leaves the
 * caller's own wording in place rather than inventing a status.
 */
const V2_ERROR_TAG_STATUS = {
    UnauthorizedError: 401,
    LocationNotFoundError: 404,
    // The tag a 404 on `POST /api/session` actually carries. `LocationNotFoundError` above is a different route's
    // error and never fires here, so without this the "a 1.x CLI has no /api route" case - the one warning worth
    // printing - answered a bare `500` instead of `502 (status 404)`.
    NotFoundError: 404,
    SessionNotFoundError: 404,
    SessionArchivedError: 410,
    InvalidRequestError: 400,
    InvalidPayloadError: 400,
    ConflictError: 409,
    ServiceUnavailableError: 503
};

/**
 * The HTTP status behind a thrown backend error, or `null`.
 * @param {unknown} error the thrown value
 * @returns {number|null}
 */
export function upstreamErrorStatus(error) {
    for (const link of errorCauseChain(error)) {
        const tag = link?._tag;
        // `Object.hasOwn`, not a truthiness test: the map is a plain object literal, so `_tag` of `constructor`,
        // `toString` or `__proto__` read an inherited member and returned a function or an object as the "status",
        // which `upstreamFailureReason()` then interpolated into a client-facing 502 and a log line. `_tag` is
        // backend-controlled (`declared()` copies the body onto the thrown error), so that was reachable from a
        // single error payload.
        if (typeof tag === 'string' && Object.hasOwn(V2_ERROR_TAG_STATUS, tag)) return V2_ERROR_TAG_STATUS[tag];
        // A status on any link of the chain is the real answer: a wrapper that does carry `response.status` (a proxy,
        // a Node `fetch` failure with a response) is more precise than a tag guess.
        const status = link?.response?.status ?? link?.status ?? link?.statusCode;
        if (typeof status === 'number') return status;
    }
    return null;
}

/**
 * The body a backend error carries, in every shape the 2.x client and the 1.x one produce: a plain string, an object
 * with `message`, one with a nested `error`, or the `{error:{message}}` / `{message}` envelopes.
 * @param {unknown} value
 * @returns {string}
 */
const bodyMessage = (value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    return value.data?.message
        ?? value.message
        ?? (typeof value.error === 'string' ? value.error : value.error?.message)
        ?? '';
};

/**
 * Describe a failed backend call: the status and the reason the backend gave.
 *
 * Two shapes, one helper. The 1.x SDK resolved a non-2xx answer with `{error, response}` and never threw, so the tuple
 * was read here. The 2.x client throws a typed error (`_tag`, `message`, no status) or a `ClientError` wrapping Node's
 * `fetch` failure, so the thrown value is read the same way - a call site that only understood the tuple reported a
 * refused backend as "no reason" and an invalid request as a bare 500.
 *
 * The body the SDK hands back is used as-is, so taking the first object would print "[object Object]" in a
 * client-facing message.
 * @param {unknown} res the resolved tuple or the thrown value
 * @returns {{status: number|null, reason: string}} the status and a `: reason` suffix (empty when there is none)
 */
export const upstreamFailureReason = (res) => {
    // A call site that caught a rejection and stored it as `{error}` (the poll loop does) is unwrapped here, so the
    // status on the real error is read instead of being lost behind the wrapper object.
    const thrown = res instanceof Error
        ? res
        : (res?.error instanceof Error ? res.error : null);
    const status = upstreamErrorStatus(thrown || res);
    // A 2.x `ClientError` for a status the generated client has no typed error for carries an **empty** message and
    // hangs the response body off `.error`, so reading only `message` reported a failing poll as "failed while
    // polling the answer: Error" - the reason the backend actually gave was one property further in. When there is a
    // body, it wins: for those statuses the message is nothing but the status echoed back (`UnexpectedStatus: 502`),
    // and a reason is what the reader is looking for.
    const raw = thrown
        ? (bodyMessage(thrown.error) || (typeof thrown.message === 'string' ? thrown.message : ''))
        : bodyMessage(res?.error);
    // A thrown call carries the runtime's own wording (`fetch failed` for a dead or refused backend), which names
    // no cause at all; the same phrase a client would read from the top-level handler is used here.
    const text = clientFacingText(raw);
    const reason = text && isConnectionError(thrown || { message: raw })
        ? `the backend is not reachable (${text})`
        : text;
    return {
        status,
        reason: typeof reason === 'string' && reason ? `: ${reason}` : ''
    };
};

/**
 * A backend that could not be reached, or could not be started, is an upstream failure and not a bug in the gateway:
 * the sentences behind this tag ("the CLI is missing", "it exited during startup", "the port is taken", "a start is
 * still running") describe a cause the *operator* must fix, and they were answered as `500 server_error` with no
 * `code`, which is what this gateway says about its own defect. The tag is what the handler's catch maps to `502`; it
 * travels on the error instead of matching the message text, so a future sentence cannot silently fall back to `500`.
 * @param {string} message
 * @returns {Error & {backendUnavailable: true}}
 */
export const backendUnavailable = (message) => Object.assign(new Error(message), { backendUnavailable: true });