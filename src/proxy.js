// First import, ahead of `@opencode/client`: the shim it installs is what the client's SSE subscription needs on
// Node 20 (see `src/polyfills.js`).
import './polyfills.js';
import Fastify from 'fastify';
import { spawn } from 'child_process';
import { OpenCode } from '@opencode/client';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { timingSafeEqual, randomBytes } from 'crypto';
import {
    logger, loggableError, maskBackendUrl, maskDetail, maskFreeText, maskHeaders, maskUrlCredentials, maskUrlQuery,
    MAX_LOGGED_STACK_CHARS, registerSensitiveValue, setOwnProperty
} from './logger.js';
import {
    CONTROL_CHARS_RE, echoedValue, generatedRequestId, jsonTypeName, loggableConfigValue, loggableModelId,
    loggableUpstreamText, loggableUrl, MAX_ECHOED_VALUE_LENGTH, newCompletionId, requestId, sleep, timeoutMessage,
    urlPath
} from './text.js';
import { clientFacingText, handlerFailureMessage } from './errors.js';
import {
    backendUnavailable, errorCauseChain, isConnectionError, isConnectionRefused, isTimeoutError,
    upstreamErrorStatus, upstreamFailureReason
} from './upstream.js';
import { closeSocketAfterFlush } from './socket.js';
import { normalizeBackendUrl, normalizeBindHost, isLoopbackHost, resolveOpencodePath, isShellUnsafePath } from './env.js';
import { DEFAULT_API_KEY, resolveApiKey } from './api-key.js';
import { backendAuthorizationHeader, resolveBackendAuth, resolveBackendPassword } from './backend-auth.js';
import {
    backendDeadline, DEFAULT_REQUEST_TIMEOUT_MS, isUnusableMilliseconds, MAX_TIMER_MS, METADATA_TIMEOUT_CAP_MS,
    readLimit, readMilliseconds, resolveRequestTimeoutMs
} from './settings.js';
import { parseBoolean, readFlag } from './options.js';

// The gateway's public surface stays `src/proxy.js`: the entry point, the smoke suite and an embedder import these names
// from here, so a helper moving into its own module does not move for a caller.
export { DEFAULT_API_KEY, resolveApiKey } from './api-key.js';
export { backendAuthorizationHeader, resolveBackendAuth, resolveBackendPassword } from './backend-auth.js';
export { clientFacingText, handlerFailureMessage } from './errors.js';
export { normalizeBackendUrl, normalizeBindHost, resolveOpencodePath, isShellUnsafePath } from './env.js';
export { parseBoolean, readFlag } from './options.js';
export { DEFAULT_REQUEST_TIMEOUT_MS, resolveRequestTimeoutMs } from './settings.js';
export { echoedValue, jsonTypeName, loggableConfigValue, loggableModelId, loggableUpstreamText, loggableUrl,
    newCompletionId, timeoutMessage } from './text.js';
export {
    backendUnavailable, errorCauseChain, isConnectionError, isConnectionRefused, isTimeoutError,
    upstreamErrorStatus, upstreamFailureReason
} from './upstream.js';

// --- Mutex Logic with Timeout ---
const queue = [];

const STARTUP_WAIT_ITERATIONS = 60;
// The delays between the readiness probes of a child that is still binding: short at first (a backend that answers in
// 100 ms must not wait a full interval), then the documented interval. The iteration budget is unchanged.
const STARTUP_BACKOFF_MS = [100, 250, 500, 1000, 2000];
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;
// Deleting the OpenCode session that a completion created is cleanup: it must finish quickly or not at all, because the
// client already has its answer and a wedged delete would otherwise hold a queue slot for the full request budget.
const SESSION_CLEANUP_TIMEOUT_MS = 10000;
const DEFAULT_POLL_INTERVAL_MS = 500;
// The first polls come back quickly. An answer that lands 30-80 ms after the prompt returned - the shape a backend
// that is already writing produces - used to wait a whole 500 ms interval before the next poll saw it: measured p50
// for that shape was 507 ms with a fixed interval and 90 ms with this schedule (a few extra cheap `GET …/message`
// calls are the cost). Each entry only ever shortens the caller's interval, and the schedule stops at the fourth
// poll, so a backend that is genuinely slow is still polled twice a second.
const POLL_BACKOFF_MS = [25, 50, 100, 200];
// How many polls in a row may fail before a completion is reported as an upstream error
const MAX_POLL_FAILURES = 5;
// How many messages one poll asks for. A completion is one session with one prompt, so a small page covers it; the
// 2.x list answers newest-first by default and this bound keeps a session that somehow accumulated history from
// pushing the whole transcript across the wire on every poll.
const DEFAULT_POLLED_MESSAGE_LIMIT = 50;
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = 4000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 8000;
// A stream that has written nothing for this long gets a comment line, so a proxy or client does not drop the
// connection while the backend is still thinking. The tick is shorter so the silence stays close to the interval.
const SSE_KEEPALIVE_INTERVAL_MS = 15000;
const SSE_KEEPALIVE_TICK_MS = 5000;
// How long a streaming write may wait for a client that is not reading before the client is treated as gone. Without
// a bound, one stalled reader parked the completion in `await drain` forever and held the only completion slot.
const SSE_CLIENT_WRITE_TIMEOUT_MS = 30000;
// How long an oversized request body is still read and thrown away after it has been refused. Closing the socket at
// once left the client's remaining bytes unread, and the kernel answers those with RST, so the 413 was lost.
const BODY_DRAIN_TIMEOUT_MS = 5000;
// How long a request that announced a body may take to deliver it. Fastify sets `requestTimeout: 0` (Node's own
// 300 s default is disabled), so without this a client that sends `Content-Length: 4096` and then four bytes holds the
// socket open for as long as it likes - measured: 20 s with no response and the socket still open, and even without a
// key, because the 401 is written from the headers while Node keeps the connection to drain a body it will never read.
// The effective deadline is bounded by the request budget (see createApp): receiving a body is part of receiving the
// request, so no phase may outlive the budget the operator configured.
const BODY_RECEIVE_TIMEOUT_MS = 30000;
// After the idle timeout the gateway polls for the rest of the answer; this is how many identical polls (a full idle
// window worth) that recovery tolerates before it accepts a message the backend never marks finished.
const IDLE_RECOVERY_STALL_POLLS = Math.max(3, Math.ceil(DEFAULT_EVENT_IDLE_TIMEOUT_MS / DEFAULT_POLL_INTERVAL_MS));

// Fastify refuses a JSON body carrying `__proto__` or `constructor` before any handler runs, and the refusal reaches the
// client as `FST_ERR_CTP_INVALID_JSON_BODY` - the code a syntax error produces too, so the sentence has to name both
// causes. One copy: the mapping in the route handler's catch and the text-body guard below answer identically, because a
// client must not be able to tell which content type it sent.
const FORBIDDEN_BODY_MESSAGE = 'request body is not valid JSON, or it carries a forbidden property name '
    + '(__proto__, constructor); send Content-Type: application/json';
const FORBIDDEN_BODY_KEYS = new Set(['__proto__', 'constructor']);
// The endpoints a client that hit the wrong path is looking for, in one place: the 404 message names them and the
// smoke suite asserts the message carries this exact list. Each entry carries its method, because the same request
// reaches this handler when the path is right and the method is not (`PUT /v1/chat/completions`), and a list without
// methods answered that case with the path it had just declared missing.
const SERVED_ROUTES = 'POST /v1/chat/completions, GET /v1/models and GET /health';
// A message role becomes the `USER:`/`ASSISTANT:` label a model reads, so it is bounded like every other client value
// that reaches the prompt: the known roles are short, and anything longer is a label nobody wrote.
const MAX_ROLE_LABEL_LENGTH = 32;

const OPENCODE_BASENAME = 'opencode';

// How many chat completions may run at the same time. 1 (the default) preserves the historical behaviour of
// serializing every completions request; raise it to let independent OpenCode sessions run in parallel.
// Resolved again by startProxy() so a value in config.json takes effect too: it used to be read from the environment
// only, so the same key in the file was silently ignored while the startup summary reported the default.
let MAX_CONCURRENCY = readLimit('OPENCODE_PROXY_MAX_CONCURRENCY', { min: 1, max: 32, fallback: 1 }).value;

// Largest request body accepted, in MiB. Every waiting completion pins its parsed body, so the memory a burst can hold
// is this value times OPENCODE_PROXY_MAX_QUEUE: the 50 MiB default times the 64-entry default queue allows 3.2 GiB that
// no small host plans for, and a prompt is a few kilobytes. Lowering it is the cheap way to bound a gateway that faces
// clients it does not trust. Resolved again by startProxy() so a value in config.json takes effect too.
const DEFAULT_MAX_BODY_MB = 50;
let MAX_BODY_MB = readLimit('OPENCODE_PROXY_MAX_BODY_MB', { min: 1, max: 200, fallback: DEFAULT_MAX_BODY_MB }).value;

let activeTasks = 0;

// How long after a completion's own budget the slot watchdog waits before freeing the slot of a task that never
// settled. It only has to cover the handler's finishing path after a timeout (aborting the collector, the in-band
// error frame, the session-delete call), whose own budget is SESSION_CLEANUP_TIMEOUT_MS: five seconds leaves room for
// that plus the response write without leaving the gateway refusing work for long.
const SLOT_WATCHDOG_GRACE_MS = 5000;

function runQueuedTask() {
    const entry = queue.shift();
    const { task, timeout, resolve, reject } = entry;
    // The admission timer armed in lock() covers the wait for a slot; from here the execution budget applies instead
    if (entry.waitTimer) clearTimeout(entry.waitTimer);
    activeTasks += 1;
    // The slot is freed by the handler as soon as the response is complete, not when the task promise settles:
    // the session cleanup that follows the answer (a backend round trip) used to keep the slot busy after the client
    // already had its response, so an immediate follow-up request was refused with 503 queue_full on a gateway whose
    // queue is 0. Idempotent, because .finally() below stays the safety net for every path.
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        activeTasks -= 1;
        // Drain the queue on the next tick instead of waiting a fixed 100 ms between requests
        setImmediate(processQueue);
    };
    let settled = false;
    const timeoutMs = timeout || 120000;
    const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error(timeoutMessage(timeoutMs)), { deadlineMs: timeoutMs }));
        // The client has been answered 504, but `.finally(release)` below only runs once the task settles - and a task
        // parked in an await that never resolves (a backend call without a deadline, a stuck socket) is exactly the
        // case this timer exists for: at the default concurrency of 1 that single task pinned the only slot, so every
        // later completion queued, the queue filled, and a gateway that still answered /health 200 refused all traffic
        // with 503. The grace gives the handler's own finishing path (which releases on response completion) time to
        // run first; `release()` is idempotent, so the two cannot double-count.
        const watchdog = setTimeout(() => {
            if (released) return;
            logger.warn(
                `[Proxy] A completion outlived its ${timeoutMs}ms budget by ${SLOT_WATCHDOG_GRACE_MS}ms; releasing its slot`
            );
            release();
        }, SLOT_WATCHDOG_GRACE_MS);
        if (watchdog.unref) watchdog.unref();
    }, timeoutMs);

    Promise.resolve()
        .then(() => task(release))
        .then((result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(result);
        })
        .catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            reject(err);
        })
        .finally(release);
}

function processQueue() {
    while (activeTasks < MAX_CONCURRENCY && queue.length > 0) {
        runQueuedTask();
    }
}

// Every waiting request holds its parsed body (up to the 50 MB body limit), so the wait queue is bounded:
// past this point new requests are rejected immediately with a 503 instead of growing memory until they time out.
// A missing or malformed value must never disable the cap (Number('abc') is NaN, which would compare false forever)
let MAX_QUEUE_LENGTH = readLimit('OPENCODE_PROXY_MAX_QUEUE', { min: 0, max: 4096, fallback: 64 }).value;

// The resolved capacity, for the entry point's startup summary: an operator who sets a limit must be able to see the
// value the gateway actually uses (and why it differs from what was asked for). Resolved from the merged configuration
// so the summary and the gateway cannot disagree, and so a config.json value is visible rather than ignored.
export function getQueueLimits(fileConfig = {}) {
    const concurrency = readLimit(
        'OPENCODE_PROXY_MAX_CONCURRENCY',
        { min: 1, max: 32, fallback: 1 },
        fileConfig.OPENCODE_PROXY_MAX_CONCURRENCY
    );
    const queue = readLimit(
        'OPENCODE_PROXY_MAX_QUEUE',
        { min: 0, max: 4096, fallback: 64 },
        fileConfig.OPENCODE_PROXY_MAX_QUEUE
    );
    const notes = [concurrency.note, queue.note].filter(Boolean);
    return { concurrency: concurrency.value, queue: queue.value, notes };
}

class QueueFullError extends Error {
    constructor() {
        // `0` is a supported setting ("never queue"), so the default wording would report a full queue that is
        // configured to hold zero requests - a number that reads like a bug in the report, not like the setting it is.
        super(MAX_QUEUE_LENGTH === 0
            ? 'Queue full: waiting is disabled (OPENCODE_PROXY_MAX_QUEUE=0), retry later'
            : `Queue full: ${MAX_QUEUE_LENGTH} completions are already waiting, retry later`);
        this.name = 'QueueFullError';
    }
}

function lock(task, timeout = 120000) {
    return new Promise((resolve, reject) => {
        // A gateway that is going away must not park the request in a queue whose slots are being torn down: the
        // documented 503 is an answer the client can retry, a closed socket is not.
        if (gatewayShuttingDown) {
            reject(Object.assign(new Error('The gateway is shutting down; retry shortly'), { gatewayShuttingDown: true }));
            return;
        }
        // The cap bounds the requests *waiting* for a slot, so it is only reached when every slot is busy: a queue of
        // 0 then means "never queue" (reject instead of waiting) rather than "refuse every completion", which would
        // let one configuration value switch the whole gateway off while it sits there looking healthy.
        if (activeTasks >= MAX_CONCURRENCY && queue.length >= MAX_QUEUE_LENGTH) {
            reject(new QueueFullError());
            return;
        }
        // A request that never reaches a slot used to wait without any deadline at all: while one stalled completion
        // held the only slot, everything behind it sat in the queue forever - no 503, no 504, no closed connection.
        // Waiting for a slot is now bounded by the same budget the execution gets.
        const entry = { task, timeout, resolve, reject, waitTimer: null };
        entry.waitTimer = setTimeout(() => {
            const index = queue.indexOf(entry);
            if (index === -1) return;
            queue.splice(index, 1);
            // The deadline travels with the error so the client-facing sentence names the budget that was actually in
            // force (the queue backstop is `REQUEST_TIMEOUT_MS` plus a grace) instead of a smaller one it never had
            reject(Object.assign(
                new Error(`Request timeout after ${timeout}ms waiting for a free completion slot`),
                { deadlineMs: timeout }
            ));
        }, timeout);
        queue.push(entry);
        processQueue();
    });
}

/**
 * Marks the gateway as going away (`SIGINT`/`SIGTERM`), so a request that has not started yet is answered instead of
 * being dropped.
 *
 * The documented contract is a `503 gateway_shutting_down` with `Retry-After: 1` for a request that is not one of the
 * responses being finished. In-flight completions got that through `killBackend()`; a request still *waiting for a
 * slot* did not - `server.close()` waits for it and `closeAllConnections()` destroys the socket 1.5 s later, so the
 * client saw `fetch failed` (measured: 1 507 ms after the signal, no envelope). An OpenAI SDK treats a reset
 * differently from a 503, and the whole point of the retry hint is that this refusal is temporary.
 *
 * The queue is drained here rather than polled: every waiting entry is rejected with a tagged error, which the
 * handler's outer catch already maps to the 503 envelope.
 */
export function beginShutdown() {
    gatewayShuttingDown = true;
    while (queue.length) {
        const entry = queue.shift();
        if (entry.waitTimer) clearTimeout(entry.waitTimer);
        entry.reject(Object.assign(new Error('The gateway is shutting down; retry shortly'), { gatewayShuttingDown: true }));
    }
}

// Set by beginShutdown(); read by lock() so a request that arrives after the signal does not queue for a slot that will
// never be free, and by ensureBackend() so a process that is going away does not start a new backend.
let gatewayShuttingDown = false;

// Keep-alive socket for backend health probes: a fresh connection per chat request is measurable overhead.
// A remote (https) OPENCODE_SERVER_URL needs its own agent, otherwise the probe cannot even be sent.
const healthAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const healthAgentSecure = new https.Agent({ keepAlive: true, maxSockets: 4 });

// The credentials the readiness probe tries, in order. An OpenCode 2.x server authenticates `GET /api/info` with its
// own password, so the header built from the resolved server password comes first; a proxy sitting *in front of* the
// backend may instead authenticate the credential `OPENCODE_SERVER_URL` carries (`http://user:secret@host`), which is
// the second. One header can only carry one of them, so the probe tries the next only when the previous was refused -
// a refused connection or an HTML answer is not retried with the other credential.
let BACKEND_HEALTH_AUTHORIZATIONS = [];
// The OpenCode 2.x server password this process resolved (configured or generated). `spawnBackend()` passes it to the
// child as `OPENCODE_SERVER_PASSWORD`, which is the same variable the server itself reads - so a spawned child always
// accepts that credential, and the printed `server password …` line is never the source of truth.
let BACKEND_SERVER_PASSWORD_VALUE = null;

// How long one health probe may take, start to finish. The deadline has to cover the phases `req.setTimeout()` does not:
// that timer only starts once a socket is *assigned and connected*, so `dns.lookup()` and the TCP handshake were
// unbounded. `ensureBackend()` runs this probe on the completion path (with the completion slot already taken) and in
// the "another request is starting the backend" wait loop, so a backend host that drops SYNs - a firewall, an
// unresolvable name, a wrong port on a black-holed address - suspended the request for the OS connect timeout (~2 min
// on Linux) while every other backend call in this file carries a deadline. The probe is not a completion: a couple of
// seconds is the whole budget it gets.
const HEALTH_PROBE_TIMEOUT_MS = 2000;
// The route the readiness probe asks. `GET /api/info` answers `{"version":…}` for an authenticated v2 server, and a
// web UI, a proxy error page or a 1.x server answers it with something else - which is exactly what must be told apart
// from a usable backend.
const HEALTH_PROBE_PATH = '/api/info';
// How much of the probe's body is read to classify it. A JSON document starts with `{` or `[`, so a page of HTML is
// identified from its first bytes; the bound keeps a large body from being buffered on the completion path.
const HEALTH_PROBE_BODY_SAMPLE_CHARS = 64;
/**
 * Whether a health payload is a JSON document rather than a web page.
 *
 * The check is deliberately about the *shape* and not about a version field: the OpenCode 2.x server answers
 * `{"version":"2.x.y",…}`, and a proxy that returns its own JSON error with `200` is still a backend the gateway
 * cannot drive - but it is not this function's job to tell those apart, only to stop `text/html` from passing.
 * @param {string} text the sampled head of the response body
 * @returns {boolean}
 */
function isJsonHealthBody(text) {
    const trimmed = String(text).replace(/^\uFEFF/, '').trimStart();
    if (!trimmed) return false;
    const first = trimmed[0];
    return first === '{' || first === '[';
}

/**
 * Robust Health Check Helper
 *
 * The OpenCode 2.x server has no JSON health route: `GET /health` serves the web UI with `200 text/html`, so the
 * original "any 200 is healthy" rule accepted a backend that answers every API call with `401`/`404` - the readiness
 * probe passed, the child was considered up, and every completion failed. The probe therefore asks an API route
 * (`GET /api/info`) and additionally requires a JSON body: an HTML page, a proxy's error page or a 2.x web UI can no
 * longer pass as a usable backend.
 */
/**
 * One readiness probe against one credential.
 *
 * Two things have to be true before a backend counts as ready, and both were learned the hard way on 2.x:
 *
 * - the **status** must be 200. The probe used to classify the first bytes of the body and settle there, so the `401`
 *   a 2.x server answers an unauthenticated `GET /api/info` with (`{"_tag":"UnauthorizedError"}`, JSON) passed as a
 *   healthy backend: the spawn loop reported "backend ready", and every completion then failed on its own credential.
 * - the body must be **JSON**. There is no JSON health route any more: `/health` and `/` serve the web UI with
 *   `200 text/html`, so "any 200 is healthy" accepted a web UI - or a proxy's error page - as a drivable backend.
 * @param {string} serverUrl
 * @param {string|null} authorization value for the `Authorization` header, or null to send none
 * @returns {Promise<true>} resolves when the backend answered 200 with a JSON document
 */
function probeBackendOnce(serverUrl, authorization) {
    const secure = String(serverUrl).startsWith('https://');
    const transport = secure ? https : http;
    return new Promise((resolve, reject) => {
        let settled = false;
        let guard = null;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (guard) clearTimeout(guard);
            if (error) reject(error);
            else resolve(true);
        };
        const abandon = (reason) => {
            if (settled) return;
            finish(reason);
            try {
                req.destroy();
            } catch (e) { }
        };
        const options = { agent: secure ? healthAgentSecure : healthAgent };
        if (authorization) options.headers = { authorization, accept: 'application/json' };
        const req = transport.get(`${serverUrl}${HEALTH_PROBE_PATH}`, options, (res) => {
            // Only the first bytes are needed to tell JSON from a web page, but the body is drained either way so the
            // socket goes back to the keep-alive pool instead of being torn down per probe.
            let head = '';
            let sampled = false;
            const settle = (error) => {
                if (sampled) return;
                sampled = true;
                // A refusal still has a body, and leaving it unread would take the socket out of the keep-alive pool
                res.resume();
                finish(error);
            };
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                if (sampled) return;
                // Status first: a 401/404 body is JSON too, and reading the shape without the status called every
                // refused probe healthy.
                if (res.statusCode !== 200) {
                    settle(new Error(`Status ${res.statusCode}`));
                    return;
                }
                head += chunk;
                if (head.length < HEALTH_PROBE_BODY_SAMPLE_CHARS) return;
                settle(isJsonHealthBody(head) ? null : new Error('Backend answered with a non-JSON health payload'));
            });
            res.on('end', () => {
                if (sampled) return;
                sampled = true;
                if (res.statusCode !== 200) {
                    finish(new Error(`Status ${res.statusCode}`));
                    return;
                }
                finish(isJsonHealthBody(head) ? null : new Error('Backend answered with a non-JSON health payload'));
            });
        });
        // Armed before the socket exists, so it covers DNS and connect as well as the response; unref'd so a probe in
        // flight never keeps the process alive on its own
        guard = setTimeout(() => abandon(new Error('Timeout')), HEALTH_PROBE_TIMEOUT_MS);
        if (guard.unref) guard.unref();
        req.on('error', (e) => finish(e));
        req.setTimeout(HEALTH_PROBE_TIMEOUT_MS, () => abandon(new Error('Timeout')));
    });
}

/**
 * Is the OpenCode backend answering as a usable 2.x API?
 *
 * Each candidate credential is tried until one is accepted. A **refusal** (`401`, the credential a proxy in front wants
 * or the server's own password) is the only thing that moves on to the next one: a connection that was refused, a
 * timeout or an HTML answer means the backend is not there to be authenticated against, so trying the other header
 * would only double the wait on every request that concludes the backend is gone.
 * @param {string} serverUrl
 * @param {string[]} [authorizations] credentials to try, in order
 * @returns {Promise<true>}
 */
async function checkHealth(serverUrl, authorizations = BACKEND_HEALTH_AUTHORIZATIONS) {
    const candidates = [];
    for (const value of (Array.isArray(authorizations) ? authorizations : [authorizations])) {
        if (typeof value === 'string' && value !== '' && !candidates.includes(value)) candidates.push(value);
    }
    const attempts = candidates.length > 0 ? candidates : [null];
    let lastError = null;
    for (const authorization of attempts) {
        try {
            return await probeBackendOnce(serverUrl, authorization);
        } catch (error) {
            lastError = error;
            // Only a refusal is worth another credential
            if (!/Status 401/.test(String(error && error.message))) break;
        }
    }
    throw lastError || new Error('Backend health probe failed');
}

let BACKEND_HEALTH_CACHE_MS = readMilliseconds('OPENCODE_PROXY_HEALTH_CACHE_MS', 2000);

// After a failed start attempt (missing binary, backend never became healthy) requests fail fast for this long
// instead of repeating a multi-minute startup wait on every single request
let BACKEND_START_RETRY_COOLDOWN_MS = readMilliseconds('OPENCODE_PROXY_START_RETRY_MS', 15000);

// Jail directories this process created. Another gateway (a second instance, or one in a container sharing /tmp)
// may be using the same parent directory, so the exit hook must never delete a directory it does not own.
const ownedJailRoots = new Set();

// The parent directories holding those jails, and only the ones this process may remove: the shared
// `<tmp>/opencode-proxy-jail` (which disappears with the last instance, since `rmdir` refuses a non-empty one) and a
// private one when the shared directory turned out to belong to somebody else (see `resolveJailParent()`).
const ownedJailParents = new Set();

/**
 * The directory the per-spawn jail lives in, or a private one when the shared directory cannot be trusted.
 *
 * `/tmp` is world-writable and this name is predictable, and `mkdirSync(…, { recursive: true })` succeeds silently on a
 * directory somebody else already created. Another unprivileged account that pre-creates the path would then own the
 * **parent** of the backend's working directory - and, with `USE_ISOLATED_HOME`, of its `HOME`, which holds the provider
 * credential store. The leaf is mode 0700, but its owner can rename that leaf and put their own directory, or a symlink
 * to one, in its place, which the next respawn would use as `cwd`/`HOME` for a model-driven agent; and `0700` owned by
 * someone else makes the leaf's `mkdir` fail with an `EACCES` that the spawn error names as nothing in particular.
 *
 * So the shared parent is used only when it is a real directory (not a symlink, hence `lstat`) owned by this uid. When
 * the platform has no uid to compare (Windows), the check is the directory test alone. Otherwise the backend gets a
 * private parent from `mkdtempSync()`: atomic, unpredictable, mode 0700, and removed with the jails it contains.
 * @param {boolean} isWindows true on `win32`, where the isolation check has no uid to compare
 * @param {string} tmpDir the temporary directory to build in (`os.tmpdir()` unless a test says otherwise)
 * @returns {string} an absolute directory this process may write into
 */
export function resolveJailParent(isWindows, tmpDir = os.tmpdir()) {
    const shared = path.join(tmpDir, 'opencode-proxy-jail');
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    try {
        fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
        // lstat, not stat: a symlink here is exactly the shape an attacker would use to redirect the tree
        const stats = fs.lstatSync(shared);
        const trusted = stats.isDirectory() && (currentUid === null || stats.uid === currentUid);
        if (trusted) {
            if (!isWindows) {
                // mkdirSync does not change the mode of a directory that already exists, so a parent created by an older
                // build (0755) kept its permissions for the lifetime of the machine; re-assert them on every start.
                try {
                    fs.chmodSync(shared, 0o700);
                } catch (error) {
                    logger.warn('[Proxy] Could not restrict the backend jail directory:', { path: shared, error: error.message });
                }
            }
            ownedJailParents.add(shared);
            return shared;
        }
        logger.warn('[Proxy] The shared backend jail directory is not a directory this process owns; using a private one',
            { path: shared, uid: stats.uid, expectedUid: currentUid, symlink: stats.isSymbolicLink() });
    } catch (error) {
        logger.warn('[Proxy] Could not prepare the shared backend jail directory; using a private one',
            { path: shared, error: error.message });
    }
    const privateParent = fs.mkdtempSync(path.join(tmpDir, 'opencode-proxy-jail-'));
    ownedJailParents.add(privateParent);
    return privateParent;
}

// Sessions this process created and has not deleted yet. Every completion deletes its own (success, error, client
// abort), but a SIGTERM in the middle bypasses all three: the HTTP server closes, `stopBackend()` runs and the process
// exits while the task is still parked in the collector or the poll. A managed child takes its sessions with it, but an
// external backend (`OPENCODE_SERVER_URL`) keeps them in its store forever - one per restart. `killBackend()` drains
// this set, so shutdown leaves the backend as it found it.
const liveSessions = new Set();
// The set is bounded, because a backend that refuses every delete keeps its ids here for the drain to retry: without a
// cap that is one short string per served request for the life of the process, and it is invisible - the warning above
// is rate-limited to one line a minute. The newest ids are the ones worth retrying; the backend's own sessions cannot
// be cleaned up by this process either way, and the drain reports what it manages to delete.
const MAX_TRACKED_SESSIONS = 1000;
let liveSessionsOverflowReported = false;
const trackLiveSession = (sessionId) => {
    liveSessions.add(sessionId);
    if (liveSessions.size <= MAX_TRACKED_SESSIONS) return;
    // Insertion order is iteration order for a Set, so the first value is the oldest id
    liveSessions.delete(liveSessions.values().next().value);
    if (liveSessionsOverflowReported) return;
    liveSessionsOverflowReported = true;
    logger.warn(`[Proxy] More than ${MAX_TRACKED_SESSIONS} sessions are waiting to be deleted; tracking the newest ones only. A backend that refuses deletes keeps accumulating them.`);
};

// A session delete that fails is the only signal that a backend is accumulating sessions, so it must not be silent -
// but a backend that refuses every delete would otherwise write one warning per completion. One line per minute names
// the cause; the rest stay at debug, where an operator debugging the backend can still see each one.
const CLEANUP_FAILURE_WARN_INTERVAL_MS = 60 * 1000;
let cleanupFailureWarnedAt = 0;
const noteCleanupFailure = (sessionId, error) => {
    const now = Date.now();
    if (now - cleanupFailureWarnedAt < CLEANUP_FAILURE_WARN_INTERVAL_MS) {
        logger.debug('[Proxy] Failed to delete session:', { sessionId, error });
        return;
    }
    cleanupFailureWarnedAt = now;
    logger.warn('[Proxy] Failed to delete session:', { sessionId, error });
};

/**
 * Removes the jail directories this process created. This runs on process exit, so it cannot rely on
 * killBackend() having been called.
 */
function cleanupTempDirs() {
    // The jail is created on every platform (Windows included: `spawnBackend()` builds the workspace before it branches
    // on `isWindows`), so skipping `win32` here left one directory per run behind for good. Removal is best effort;
    // a directory the child still holds answers EBUSY and the next exit tries again.
    for (const jailRoot of ownedJailRoots) {
        try {
            fs.rmSync(jailRoot, { recursive: true, force: true });
        } catch (e) {
            logger.error('[Cleanup] Failed to remove temp dirs:', { error: e.message });
        }
    }
    ownedJailRoots.clear();
    // A parent this process owns disappears with its last jail; the shared one stays while another instance uses it
    // (`rmdir` refuses a non-empty directory), and the private one is this process's alone
    for (const jailParent of ownedJailParents) {
        try {
            fs.rmdirSync(jailParent);
        } catch (e) {
            // not empty or already gone: expected when another instance is still running
        }
    }
    ownedJailParents.clear();
}

// Register cleanup on exit
process.on('exit', cleanupTempDirs);

// Signal handling is owned by the entry point (index.js): it kills the backend and closes the HTTP server
// gracefully. Registering an exit-on-signal handler here would run first and cut that shutdown short.

/**
 * Best-effort extraction of the status code and error-body summary from an upstream (opencode serve) call failure.
 *
 * Two shapes reach here. The 1.x SDK resolved with `{error, response}` on a non-2xx answer, so `response.{status,data}`
 * was the whole story. The 2.x client throws instead: a typed error carrying `_tag` and a message (`SessionNotFoundError`,
 * `UnauthorizedError`, `InvalidRequestError`, …) and no status, or a `ClientError` wrapping Node's `fetch` failure.
 * `upstreamErrorStatus()` maps the tag back onto the status the server sent, so the sentence a client reads still names
 * one.
 * @param {unknown} error the resolved tuple or the thrown value
 * @returns {{status: number|null, bodySummary: string|null}}
 */
function extractUpstreamError(error) {
    const chain = errorCauseChain(error);
    // `error.error` is where the 2.x client hangs the response body of a status it has no typed error for: those arrive
    // as a bare `Error` whose own message is empty (`UnexpectedStatus: 500`), so without this a megabyte of backend
    // payload was logged as `bodySummary: null` - the summary bound existed and was never applied. The chain is walked
    // for it too, because the gateway's own `ProviderError` wraps the failure it was built from.
    let body = error?.response?.data ?? error?.responseBody ?? error?.data ?? error?.body
        ?? error?.error
        ?? chain.map((link) => link?.data ?? link?.body ?? link?.error).find((value) => value !== undefined) ?? null;
    // A **typed** 2.x error (`_tag`, the statuses the client declares) carries the backend's answer as its own message
    // and has no separate body. A short one is already printed in full by the `message` field, so it is summarised only
    // when it is long enough for the bound to matter - that megabyte is exactly what the bound exists for.
    if (body === null && typeof error?._tag === 'string' && typeof error?.message === 'string'
        && error.message.length > 200) {
        body = error.message;
    }
    const status = upstreamErrorStatus(error);
    // Bounded *before* it is serialised. This used to be `JSON.stringify(body).slice(0, 500)`, which built the whole
    // string - a proxy in front of the backend answering a megabyte of JSON paid a full serialisation and a megabyte
    // string on the completion's error path - to keep 500 characters of it. The summary is a log line either way.
    const MAX_SUMMARY_STRING_CHARS = 200;
    const boundedCopy = (value, depth = 0) => {
        if (typeof value === 'string') {
            return value.length > MAX_SUMMARY_STRING_CHARS ? `${value.slice(0, MAX_SUMMARY_STRING_CHARS)}…` : value;
        }
        if (value === null || typeof value !== 'object') return value;
        if (depth >= 4) return '[…]';
        if (Array.isArray(value)) return value.slice(0, 32).map((entry) => boundedCopy(entry, depth + 1));
        const copy = {};
        for (const key of Object.keys(value).slice(0, 32)) setOwnProperty(copy, key, boundedCopy(value[key], depth + 1));
        return copy;
    };
    let bodySummary = null;
    if (typeof body === 'string') {
        bodySummary = body.slice(0, 500) || null;
    } else if (body !== null && body !== undefined) {
        try {
            bodySummary = JSON.stringify(boundedCopy(body)).slice(0, 500);
        } catch (e) {
            // Never fail silently on serialization: record the reason in the summary
            bodySummary = `[unserializable: ${e?.message || 'unknown error'}]`;
        }
    }
    return { status, bodySummary };
}

const HEALTH_SCHEMA = {
    type: 'object',
    properties: {
        status: { type: 'string' },
        backend: { type: 'string' }
    }
};

const MODEL_ITEM_SCHEMA = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        object: { type: 'string' },
        owned_by: { type: 'string' }
    }
};

// The one id this gateway knows without asking the backend: the answer `/v1/models` gives when the provider list cannot
// be read, and the model a chat request that omits `model` is sent to. Both uses share this constant, so the fallback
// listing and the request default can never name different ids.
//
// `opencode/big-pickle` is an alias, not a model of its own: OpenCode routes it to whichever model it currently serves
// and never publishes which one that is. That makes the alias stable enough to hardcode while every concrete model id
// comes and goes - but it also means no capability, context or price can be claimed for it, so it carries only the four
// OpenAI fields. Do not add metadata here: it would describe a model this gateway cannot see.
const DEFAULT_MODEL = { id: 'opencode/big-pickle', name: 'Big Pickle', object: 'model', owned_by: 'opencode' };

const DEFAULT_MODEL_ID = DEFAULT_MODEL.id;

// One sentence for one mistake on every path that can see it: a body that is not there at all is a payload that went
// missing (a retry, a client that lost its buffer), and both the parser-level refusal and the text-body path name it,
// so the same request cannot be told two different things depending on the Content-Type it was sent under.
const EMPTY_BODY_MESSAGE = 'request body is empty; send a JSON object with a messages array';

const MODELS_SCHEMA = {
    type: 'object',
    properties: {
        object: { type: 'string' },
        data: { type: 'array', items: MODEL_ITEM_SCHEMA }
    }
};

const MODEL_SCHEMA = MODEL_ITEM_SCHEMA;

// Compiled once by fast-json-stringify: the non-streaming reply is serialized by schema instead of JSON.stringify,
// and the shape can no longer drift from the documented OpenAI contract.
const CHAT_COMPLETION_SCHEMA = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        object: { type: 'string' },
        created: { type: 'integer' },
        model: { type: 'string' },
        choices: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    index: { type: 'integer' },
                    message: {
                        type: 'object',
                        properties: {
                            role: { type: 'string' },
                            content: { type: 'string' },
                            reasoning_content: { type: ['string', 'null'] }
                        }
                    },
                    finish_reason: { type: 'string' }
                }
            }
        },
        usage: {
            type: 'object',
            properties: {
                prompt_tokens: { type: 'integer' },
                completion_tokens: { type: 'integer' },
                total_tokens: { type: 'integer' }
            }
        }
    }
};

/**
 * Create the Fastify application.
 */
function createApp(config) {
    // DEBUG no longer controls output directly (startProxy maps it onto the debug log level), so it is not destructured here
    const { API_KEY, OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD, REQUEST_TIMEOUT_MS, DISABLE_TOOLS } = config;

    // A request line or header the HTTP parser rejects never reaches the onRequest hook (hooks run after routing), so
    // it used to be answered by Fastify's own handler with `{"error":"Bad Request","message":"Client Error",
    // "statusCode":400}`: no `type`, no CORS headers, no X-Request-Id and no log line, all four of which the API
    // contract documents as unconditional. The status and the reason stay what Node reported (400, 431 for an
    // oversized header block, 408 for a request timeout), but the body is the OpenAI envelope and the response carries
    // the same headers every other response does, so a browser client behind a proxy sees a usable error.
    // One copy of the CORS header set. It used to be written three times (this handler, the bad-URL handler and the
    // onRequest hook), which is three chances to advertise a different list - and the list disagreed with the gateway
    // itself: an incoming `X-Request-Id` is read and echoed (it is the id in the log line and in the response), so a
    // browser client that sets its own trace id sent a header its own preflight did not allow, and the browser refused
    // the request before it left the page. `X-Requested-With` stays for jQuery-era clients that send it unasked.
    const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, X-Api-Key, X-Request-Id, X-Requested-With';
    // Every body this gateway writes is JSON or SSE, and a browser that navigates to an endpoint has nothing useful to
    // render. `nosniff` is the one security header that costs a single write and applies to an API: it stops a browser
    // from re-interpreting a JSON body as HTML or script when its own guess disagree with the Content-Type. Set beside
    // the CORS set, on the same three paths, for the same reason.
    const NO_SNIFF = 'nosniff';

    const CLIENT_ERROR_STATUS = {
        ERR_HTTP_REQUEST_TIMEOUT: { status: 408, reason: 'Request timeout' },
        HPE_HEADER_OVERFLOW: { status: 431, reason: 'Exceeded maximum allowed HTTP header size' }
    };
    const clientErrorHandler = (error, socket) => {
        // Node reports a reset connection with a socket that is already gone: there is nothing to answer
        if (error?.code === 'ECONNRESET' || socket.destroyed) return;
        // `closeSocketAfterFlush()` already answered this socket (a body deadline, an oversized body): the parse error
        // is the gateway's own close arriving back as an event, not a malformed request
        if (socket.gatewayClosed) return;
        const mapped = CLIENT_ERROR_STATUS[error?.code];
        const status = mapped ? mapped.status : 400;
        const reason = mapped ? mapped.reason : 'Malformed HTTP request';
        // The error code is the useful part for support; the message can carry raw bytes from the request, so it is
        // not logged (a log line is one record and must not be forgeable by a malformed client)
        const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : undefined;
        const reqId = generatedRequestId();
        // The id goes into the response header, so it belongs in the log line that reports the same request: a client
        // report quotes the id, and without it here there was nothing to search for it by (`AGENTS.md`: the response id
        // is the one the request log line ends with)
        logger.warn(`[Proxy] Rejected malformed request: ${code || 'parse error'} [${reqId}]`);
        const body = JSON.stringify({ error: { message: reason, type: 'invalid_request_error', ...(code ? { code } : {}) } });
        if (socket.writable) {
            socket.write(
                `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n` +
                'Content-Type: application/json; charset=utf-8\r\n' +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                'X-Content-Type-Options: nosniff\r\n' +
                'Access-Control-Allow-Origin: *\r\n' +
                'Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n' +
                `Access-Control-Allow-Headers: ${CORS_ALLOW_HEADERS}\r\n` +
                'Access-Control-Max-Age: 600\r\n' +
                'Access-Control-Expose-Headers: X-Request-Id\r\n' +
                `X-Request-Id: ${reqId}\r\n` +
                'Connection: close\r\n\r\n' +
                body
            );
        }
        // Closing has to flush: destroy() on the next line discarded buffered writes, so under backpressure the client
        // saw a reset instead of the envelope this handler exists to deliver
        closeSocketAfterFlush(socket);
    };

    // The router cannot decode a URL such as `/v1/models/%E0%A4%A`, so the request never reaches a hook. Fastify's
    // own handler answered `{"error":"Bad Request","code":"FST_ERR_BAD_URL",…}` - no `type`, no CORS headers, no
    // request id, no log line - for a class of requests the contract covers like any other: every error body carries a
    // `type` and every response an `X-Request-Id`. `find-my-way` hands this handler the raw request and response, so
    // the envelope, the CORS headers and the id are written here, the same way `clientErrorHandler` does it.
    const badUrlHandler = (path, rawRequest, rawResponse) => {
        // The client's own trace id when it sent a usable one, like every other response path; that request never
        // reached the hook that normally echoes it, so without this a client setting `X-Request-Id` got a different id
        // back for the one class of failure where the cause is least obvious.
        const reqId = requestId(rawRequest) || generatedRequestId();
        // The path is the client's own bytes: truncated and stripped of anything that could forge a log line
        logger.warn(`[Proxy] Rejected a URL that cannot be decoded: ${loggableUrl(urlPath(String(path ?? '')))} [${reqId}]`);
        const body = JSON.stringify({
            error: {
                message: 'The request URL could not be decoded',
                type: 'invalid_request_error',
                code: 'FST_ERR_BAD_URL'
            }
        });
        rawResponse.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'X-Content-Type-Options': NO_SNIFF,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
            'Access-Control-Max-Age': '600',
            'Access-Control-Expose-Headers': 'X-Request-Id',
            'X-Request-Id': reqId
        });
        rawResponse.end(body);
    };

    // The body limit this app enforces, read once: the parser gets the bytes and the 413 below quotes the number, and
    // both have to name the same value
    const bodyLimitMb = MAX_BODY_MB;

    // Performance-oriented setup: no built-in logger (we log ourselves, so Fastify's automatic request logging has
    // nothing to write to anyway), 50 MB JSON body limit, and trailing-slash tolerance matching the previous behavior.
    const app = Fastify({
        logger: false,
        // Resolved from OPENCODE_PROXY_MAX_BODY_MB (see MAX_BODY_MB): the wait queue pins every waiting request's
        // parsed body, so this is the other half of the gateway's memory bound
        bodyLimit: bodyLimitMb * 1024 * 1024,
        routerOptions: { ignoreTrailingSlash: true, onBadUrl: badUrlHandler },
        trustProxy: false,
        // Replaces Fastify's default handler for requests the HTTP parser rejects (see clientErrorHandler)
        clientErrorHandler
    });

    // Fastify parses `application/json` (and `text/plain` as an opaque string the handler reads as JSON), but a body
    // sent with `application/x-www-form-urlencoded` - which is what `curl -d '{...}'` sends when the header is left out -
    // was answered with a bare 415 "Unsupported Media Type". The body is a completion payload in every one of these
    // cases, so the form type is handed over as the same unparsed string and the handler decides: a body that is valid
    // JSON is served, one that is not answers 400 naming the content type. Only that one type is taken over; anything
    // else still gets the media-type error, because a gateway that parses every content type is a gateway that cannot
    // tell a malformed client from an unsupported one.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (request, body, done) => {
        done(null, body);
    });

    // A credential in OPENCODE_SERVER_URL (`http://user:secret@host:4097`, a proxy in front of the backend) cannot be
    // handed to the SDK: it calls every endpoint through Node's `fetch`, which refuses such a URL, so the whole gateway
    // answered 502 while the runtime's message published the secret. The userinfo leaves the URL and travels as a
    // Basic Authorization header instead - for the SDK, which merges `config.headers` into every request, and for the
    // health probe, which the backend (or the proxy) would otherwise refuse with 401 and look like a missing backend.
    const backendAuth = resolveBackendAuth(OPENCODE_SERVER_URL);
    // An OpenCode 2.x server authenticates every `/api/*` route with its own password. It is either configured (and
    // handed to a spawned child verbatim) or generated here, which the child is then given - so the two always agree.
    const backendPassword = resolveBackendPassword({ configured: OPENCODE_SERVER_PASSWORD });
    BACKEND_SERVER_PASSWORD_VALUE = backendPassword.password;
    if (backendPassword.generated) {
        logger.info('[Config] OPENCODE_SERVER_PASSWORD is not set: generated a server password for this process');
    }
    // A URL credential (a proxy in front of the backend) and the server's own password are two different secrets for two
    // different hops. The server's password is what every v2 API call needs, so it is the header the SDK sends; a URL
    // credential is tried by the readiness probe as well, because a proxy in front authenticates its own hop.
    // The probe therefore carries both, server password first: it is the one `GET /api/info` itself answers to.
    const backendSdkAuthorization = backendPassword.password
        ? backendAuthorizationHeader(backendPassword.password)
        : backendAuth.authorization;
    BACKEND_HEALTH_AUTHORIZATIONS = [];
    const addProbeCredential = (value) => {
        if (typeof value === 'string' && value !== '' && !BACKEND_HEALTH_AUTHORIZATIONS.includes(value)) {
            BACKEND_HEALTH_AUTHORIZATIONS.push(value);
        }
    };
    addProbeCredential(backendSdkAuthorization);
    addProbeCredential(backendAuth.authorization);
    // A credential sent over plain `http://` to a host that is not this machine travels in cleartext: readable by every
    // hop between here and there, which is the one thing the masking elsewhere cannot help with. Loopback is fine (the
    // bytes never leave the host), a remote host is worth a line.
    if (backendSdkAuthorization) {
        let backendHost = null;
        try {
            backendHost = new URL(backendAuth.url).hostname;
        } catch {
            // Not a URL the gateway could parse: `resolveBackendAuth()` already left it as configured
        }
        if (backendHost && !isLoopbackHost(backendHost) && String(backendAuth.url).startsWith('http://')) {
            logger.warn(
                `[Security] OPENCODE_SERVER_URL sends its credential over plain http to ${loggableConfigValue(backendHost)}: ` +
                'the Basic Authorization header is not encrypted on the wire. Use https:// or a loopback/tunnelled address ' +
                'for a remote backend.'
            );
        }
    }
    const client = OpenCode.make({
        baseUrl: backendAuth.url,
        ...(backendSdkAuthorization ? { headers: { Authorization: backendSdkAuthorization } } : {})
    });

    // Precomputed once: comparing against a ready-made buffer avoids rebuilding the token on every request.
    // resolveApiKey() guarantees a non-empty key, so authentication can never be switched off.
    const apiKeyToken = resolveApiKey(API_KEY);
    const apiKeyTokenBuffer = Buffer.from(apiKeyToken);
    // Constant-time comparison, built once for the whole app: the length checks are required because
    // timingSafeEqual throws on a size mismatch, and they have to compare bytes - a token with non-ASCII
    // characters can match in string length while differing in byte length, which used to throw and turn a wrong
    // key into a 500 instead of a 401. It lives here rather than in the auth hook because that hook runs on every
    // request, and `/health` and the 404 path never compare anything at all.
    const matchesToken = (provided) => {
        if (typeof provided !== 'string' || provided.length !== apiKeyToken.length) return false;
        const providedBuffer = Buffer.from(provided);
        return providedBuffer.length === apiKeyTokenBuffer.length && timingSafeEqual(providedBuffer, apiKeyTokenBuffer);
    };
    const AUTH_SCHEME_RE = /^Bearer[ \t]+/i;
    // Pulls the token out of an `Authorization` value; returns '' when the value does not carry one
    const authorizationToken = (value) => {
        if (typeof value !== 'string') return '';
        const trimmed = value.trim();
        if (!trimmed) return '';
        const scheme = AUTH_SCHEME_RE.exec(trimmed);
        return scheme ? trimmed.slice(scheme[0].length) : '';
    };
    // `X-Api-Key` carries the bare token (a client that adds the scheme there is read the same way)
    const apiKeyHeaderToken = (value) => {
        if (typeof value !== 'string') return '';
        const trimmed = value.trim();
        if (!trimmed) return '';
        const scheme = AUTH_SCHEME_RE.exec(trimmed);
        return scheme ? trimmed.slice(scheme[0].length) : trimmed;
    };

    // A body that never arrives must not hold a socket (BODY_RECEIVE_TIMEOUT_MS): Fastify sets `requestTimeout: 0`, so
    // nothing else bounds the wait, and the socket is held even for a request the auth check already refused - the 401
    // is written from the headers while Node keeps the connection alive to drain a body it will never read. The
    // deadline follows the request budget, so an operator (and the smoke suite) can shorten it without another knob.
    const bodyReceiveDeadlineMs = Math.max(1, Math.min(BODY_RECEIVE_TIMEOUT_MS, REQUEST_TIMEOUT_MS));
    // How long a body that *is* arriving may take in total. The window below answers "the client declared a body and
    // sent nothing"; it was applied as a hard cap on the whole upload, so a slow link (anything under ~1.7 MB/s for the
    // 50 MiB default limit) was cut off mid-body and told to send the body it was already sending. The deadline is
    // renewed while bytes arrive, and the arrival phase gets its own window before the completion budget starts (it is
    // spent before anything is queued), so a client that drizzles forever still cannot hold the socket.
    const bodyUploadBudgetMs = bodyReceiveDeadlineMs + REQUEST_TIMEOUT_MS;
    const armBodyDeadline = (request, reply, meta) => {
        const raw = request.raw;
        // Only an announced body is waited for, so every bodyless request keeps the hook's current cost
        const announced = raw.headers['transfer-encoding'] !== undefined || Number(raw.headers['content-length']) > 0;
        // A body that already arrived in full (a small body flushed with the headers) would never emit `end` here, and
        // the timer would then close the socket of a completion that is being served normally
        if (!announced || raw.complete) return;
        // The connection is the request's socket, not `reply.raw`: a keep-alive response is detached from the socket
        // once it ends (measured: `reply.raw.destroyed` was true, `reply.raw.socket` was null, and the client stayed
        // connected), so the deadline has to close what the body is arriving on.
        const socket = raw.socket;
        const armedAt = Date.now();
        let timer = null;
        const disarm = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            raw.off('end', disarm);
            raw.off('close', disarm);
            raw.off('error', disarm);
        };
        // `progressed` separates the two refusals: nothing arrived at all (a client that declared `Content-Length` and
        // never wrote it, a proxy that buffered the body) or bytes kept arriving but the upload outlived the budget.
        const expire = (progressed) => {
            disarm();
            const ms = Date.now() - armedAt;
            logger.warn('[Proxy] Request body did not finish arriving, closing the connection', {
                reqId: meta.reqId,
                method: request.method,
                ms,
                windowMs: bodyReceiveDeadlineMs,
                budgetMs: bodyUploadBudgetMs,
                progressed
            });
            // Nothing has been answered yet, so say why; when a response is already on the wire (the auth check's 401,
            // or the 413 for an oversized body) the socket is simply closed, because the client is not waiting for
            // another answer. The timeout is an error envelope like every other refusal, not a silent hang-up, and it
            // names the deadline in force plus the two things the client can do: a stuck upload (a proxy that buffered
            // the body, a script that declared `Content-Length` and never wrote it) reads a bare "not received" as an
            // unexplained hang-up on a connection that is about to be closed underneath it.
            if (!reply.raw.headersSent) {
                try {
                    reply.code(408).send({
                        error: {
                            message: progressed
                                ? `request body was still arriving after ${ms}ms and the upload budget is ${bodyUploadBudgetMs}ms; send the body faster or in fewer bytes`
                                : `request body was not received within ${bodyReceiveDeadlineMs}ms; send the declared body or close the connection`,
                            type: 'invalid_request_error'
                        }
                    });
                } catch (error) {
                    // The reply is already owned by someone else: closing the connection is what matters
                }
            }
            closeSocketAfterFlush(socket);
        };
        // The window is re-armed as long as the socket makes progress. `socket.bytesRead` is the only signal needed:
        // it counts this connection's reads, so a pipelined follow-up request cannot be mistaken for body progress
        // (`raw.complete` is announced-body specific, and a keep-alive response detaches `reply.raw` from the socket).
        let lastBytes = socket ? socket.bytesRead : 0;
        const arm = () => {
            timer = setTimeout(() => {
                const read = socket ? socket.bytesRead : 0;
                if (read > lastBytes) {
                    lastBytes = read;
                    if (Date.now() - armedAt < bodyUploadBudgetMs) {
                        arm();
                        return;
                    }
                    expire(true);
                    return;
                }
                expire(false);
            }, bodyReceiveDeadlineMs);
            timer.unref();
        };
        arm();
        raw.once('end', disarm);
        raw.once('close', disarm);
        raw.once('error', disarm);
    };

    // A single onRequest hook does bookkeeping + access log, CORS and authentication: one hook per request costs
    // fewer dispatches than three, and the order (log wiring, CORS, auth) is unchanged.
    app.addHook('onRequest', (request, reply, done) => {
        const startedAt = Date.now();
        const path = urlPath(request.url);
        // A client that supplies its own trace id keeps it, so its logs and ours can be joined. Anything that is not a
        // short, printable token is ignored instead of being echoed: a header value can carry newlines or control
        // characters, and this string ends up in the log line and in a response header.
        const meta = { reqId: requestId(request) || `gw-${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`, startedAt, path };
        request.gatewayLog = meta;
        // Armed first: an unauthenticated client that stalls mid-body is exactly the case this has to cover
        armBodyDeadline(request, reply, meta);

        // The summary is emitted from the raw response's events so hijacked SSE streams (which bypass the normal
        // reply lifecycle) are covered too; whichever event arrives first wins.
        let logged = false;
        const isApiPath = path.startsWith('/v1/');
        // The level is checked first: building this line is the only allocation the summary costs, and a gateway
        // running at LOG_LEVEL=warn paid for it on every request while the logger dropped the result
        const summaryEnabled = isApiPath ? logger.isEnabled('info') : logger.isEnabled('debug');
        const logSummary = () => {
            if (logged) return;
            logged = true;
            if (!summaryEnabled) return;
            // `meta.model` is client input (the model id from the request body) and `request.url` is bounded only by
            // the HTTP parser's header limit: the model id is normalised where it is stored, and a pathological URL
            // is cut here, so neither can forge a second log line or turn one request into an arbitrarily large log
            // record. Both are logged, never echoed to the client, so truncation loses nothing a reader needs.
            const model = meta.model || '-';
            // A credential sent in the query string (`?api_key=…`, a convention some OpenAI-compatible clients still
            // use) used to be copied into the log verbatim at the default level; only the values whose name looks like
            // a credential are masked
            const url = loggableUrl(request.url);
            const streamText = typeof meta.stream === 'boolean' ? String(meta.stream) : '-';
            const line = `${request.method} ${url} -> ${reply.raw.statusCode} ${Date.now() - startedAt}ms [${meta.reqId}] model=${model} stream=${streamText}`;
            if (isApiPath) logger.info(line);
            else logger.debug(line);
        };
        reply.raw.once('finish', logSummary);
        reply.raw.once('close', logSummary);

        // CORS headers are written on the raw response so they are present for streamed (hijacked) replies as well.
        // `X-Api-Key` is accepted as an alias for the bearer token below, and a browser only sends it when the
        // preflight advertises it: a rejected preflight breaks those clients before they ever reach the auth check.
        reply.raw.setHeader('X-Content-Type-Options', NO_SNIFF);
        reply.raw.setHeader('Access-Control-Allow-Origin', '*');
        reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        reply.raw.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
        // Cache the preflight so a browser client does not pay a round trip before every request
        reply.raw.setHeader('Access-Control-Max-Age', '600');
        // Without this a browser client cannot read the trace id back (CORS hides it from script)
        reply.raw.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
        // The same id the request log carries, so a client-side report can be traced back to a log line
        reply.raw.setHeader('X-Request-Id', meta.reqId);

        if (request.method === 'OPTIONS') return done();
        // /health and / stay open (the router tolerates a trailing slash, and probes often use HEAD); every other
        // route always requires the bearer token
        if (path === '/' || path === '/health' || path === '/health/') return done();

        // Constant-time comparison. The length checks are required because timingSafeEqual throws on a size
        // mismatch, and they have to compare bytes: a token with non-ASCII characters can match in string length
        // while differing in byte length, which used to throw and turn a wrong key into a 500 instead of a 401.
        // Defined once, outside the hook: the closure and its two captured values were rebuilt on every request,
        // including `/health` and the 404 path where no comparison happens at all.
        const hasAuthorization = Object.prototype.hasOwnProperty.call(request.headers, 'authorization');
        const hasApiKeyHeader = Object.prototype.hasOwnProperty.call(request.headers, 'x-api-key');
        const presented = hasAuthorization
            ? authorizationToken(request.headers.authorization)
            : apiKeyHeaderToken(request.headers['x-api-key']);

        if (!matchesToken(presented)) {
            // The message names the cause the client can act on - which header carried a key that did not match, or
            // that none did - and never the value it sent or the key it should have sent. `Unauthorized` alone left a
            // reader unable to tell a missing header from a wrong one, and a proxy-injected `Authorization: Basic …`
            // reads as "wrong key" while the fix is to drop that header.
            const message = hasAuthorization
                ? 'the Authorization header does not carry the gateway API key; send Authorization: Bearer <API_KEY>'
                : hasApiKeyHeader
                    ? 'the X-Api-Key header does not carry the gateway API key; send Authorization: Bearer <API_KEY>'
                    : 'the request carries no API key; send Authorization: Bearer <API_KEY>';
            reply.code(401).send({ error: { message, type: 'invalid_request_error', code: 'invalid_api_key' } });
            return;
        }

        // A compressed body is not decompressed by the gateway, so the JSON parser saw the gzip bytes and answered
        // "body is not valid JSON", blaming the payload for what is an unsupported encoding: a client behind a
        // compressing proxy got a message that pointed at the one thing that was correct. Naming the header is the
        // difference between a one-line fix and debugging a body that is valid on the wire. Checked after the auth
        // test, so an unauthenticated caller still learns nothing about the gateway.
        const contentEncoding = request.headers['content-encoding'];
        if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
            reply.code(415).send({
                error: {
                    message: `Request bodies with Content-Encoding: ${echoedValue(contentEncoding)} are not supported; send the body uncompressed (drop that header)`,
                    type: 'invalid_request_error'
                }
            });
            return;
        }
        done();
    });

    // Preflight for every path
    app.options('/*', (request, reply) => reply.code(204).send());

    // A hijacked response that already sent SSE frames cannot carry a JSON error body: the client is parsing frames,
    // so the error goes in as one final frame and the stream is closed. Before this the connection simply stayed
    // open - no terminator, no end() - and the client waited for a stream that would never finish.
    const failHijackedStream = (raw, payload) => {
        if (raw.writableEnded) return;
        raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        raw.write('data: [DONE]\n\n');
        raw.end();
    };

    // Models endpoint. The provider list changes rarely, so a short TTL cache avoids hitting the backend
    // on every client startup/probe; failures are never cached so a recovering backend is picked up immediately.
    const MODELS_CACHE_TTL_MS = 5000;
    // What a client sees when the provider list cannot be read: a single model, never an empty list
    const STATIC_FALLBACK_MODELS = [DEFAULT_MODEL];
    // A failing provider is not asked again for a second. The fallback is deliberately not cached - a recovering
    // backend must be picked up - but "not cached" became "one backend round trip per listing": with a provider that
    // answers 500, five listings produced five provider calls and the route measured 58.6k req/s against a 93.1k
    // warm-cache baseline (-37 %), all of it spent producing a constant. The hold keeps the recovery intent and states
    // its bound.
    const FALLBACK_HOLD_MS = 1000;
    let modelsFallbackAt = 0;
    const serveFallback = () => {
        modelsFallbackAt = Date.now();
        return STATIC_FALLBACK_MODELS;
    };
    const MODELS_TIMEOUT_MS = Math.min(REQUEST_TIMEOUT_MS, METADATA_TIMEOUT_CAP_MS);
    let modelsCache = null;
    let modelsCacheAt = 0;
    // The listing is serialised once per cache fill instead of once per request: `/v1/models` is the hot read route (a
    // client lists models on every startup and several SDKs re-list per connection), the bytes cannot have changed
    // while the cache is fresh, and re-running the response serializer for them cost ~1.8 % of a 516k-request CPU
    // profile. `modelsById` is a by-product, so the by-id routes stop scanning the list.
    let modelsCacheBody = '';
    let modelsById = null;

    // Shared by /v1/models and /v1/models/:modelId so both answer from the same cache
    let modelsInFlight = null;
    // An expired cache is still an answer: the provider list changes rarely, and awaiting the refresh put one full
    // backend round trip (RTT, DNS and connect included) in front of the request that crossed the TTL - measured at
    // 5.0-5.3 ms against 0.6 ms warm against a loopback stub, and one network RTT against a real backend. A five
    // millisecond old list is not wrong for a client choosing a model, so the stale one is served while the refresh
    // runs behind it. The bound is what keeps "serve stale" from meaning "never notice a backend that stopped
    // answering".
    const MODELS_STALE_MS = 60000;
    // When the last background refresh started. Serving stale would otherwise start one attempt per request: a
    // provider that keeps failing never refreshes the cache, so every listing would ask it again - the per-request
    // round trip `FALLBACK_HOLD_MS` prevents on the response path, reintroduced on the backend one. One attempt per
    // TTL is exactly what the blocking path cost before.
    let modelsRefreshAt = 0;
    const refreshModelsInBackground = () => {
        if (modelsInFlight) return;
        const now = Date.now();
        if (now - modelsRefreshAt < MODELS_CACHE_TTL_MS) return;
        modelsRefreshAt = now;
        modelsInFlight = fetchModels();
        // `fetchModels()` answers its own failures (fallback plus a log line), so this only frees the dedupe slot
        modelsInFlight.then(() => { modelsInFlight = null; }, () => { modelsInFlight = null; });
    };
    // "Usable now, and does it need a refresh?" lives in one place because the listing route and the by-id route have
    // to agree on the bound, and a second copy of these two comparisons is how they stop agreeing.
    const warmModelsCache = () => {
        if (!modelsCache) return false;
        const age = Date.now() - modelsCacheAt;
        if (age >= MODELS_STALE_MS) return false;
        if (age >= MODELS_CACHE_TTL_MS) refreshModelsInBackground();
        return true;
    };
    const loadModels = async () => {
        const now = Date.now();
        if (warmModelsCache()) return modelsCache.data;
        // A cold cache under a burst (an autoscaler probe, a client retrying a startup listing) would otherwise put
        // one provider round trip behind every request in that burst; the first caller does the work and the rest
        // await the same promise
        if (modelsFallbackAt && now - modelsFallbackAt < FALLBACK_HOLD_MS) return STATIC_FALLBACK_MODELS;
        if (modelsInFlight) return modelsInFlight;
        modelsInFlight = fetchModels();
        try {
            return await modelsInFlight;
        } finally {
            modelsInFlight = null;
        }
    };

    const fetchModels = async () => {
        try {
            // The 2.x server publishes one flat model list (`GET /api/model` → `{"data":[ModelInfo]}`) instead of a
            // provider list whose entries carry a `models` map. Each entry already names its provider (`providerID`) and
            // itself (`id`), which is what the OpenAI-facing `provider/model` id is built from.
            // The request options are the client's **second** argument (`model.list(input?, requestOptions?)`), where 1.x
            // merged them into the same object: passing the deadline as the input left the call with none at all, and a
            // silent backend held a model listing for as long as the client's own socket timeout allowed (measured 15 s
            // against a 2 s budget) instead of answering from the static fallback.
            const modelsRes = await client.model.list(undefined, backendDeadline(MODELS_TIMEOUT_MS));
            // The 2.x client **throws** on a rejected call, so the usual shape reaches the `catch` below; this guard is
            // for a client that resolves `{ error, response }` instead (a translating proxy, a future release). Both
            // paths report through `modelListingRejected()` so a refused call cannot describe itself as an empty one -
            // reading `.data` alone made "the upstream answered 500" and "the backend is gone" read as "the backend
            // reported no models", which sent the operator after a backend that was answering perfectly.
            if (modelsRes && modelsRes.error) {
                modelListingRejected(modelsRes);
                return serveFallback();
            }
            const modelsRaw = modelsRes?.data;
            const list = Array.isArray(modelsRaw)
                ? modelsRaw
                : (modelsRaw && Array.isArray(modelsRaw.data) ? modelsRaw.data : []);
            if (list.length === 0) {
                // A backend whose model payload the gateway cannot read (a changed shape, a version that reports
                // nothing) answered 200 with no models. Serving `{"data":[]}` is as useless to a client as an error -
                // clients show no models at all - so an empty list takes the same fallback path and is not cached.
                logger.warn('[Proxy] The backend reported no models, using the static fallback');
                return serveFallback();
            }

            const models = [];
            list.forEach((m) => {
                if (!m || typeof m.id !== 'string' || m.id === '') return;
                // A model the server itself disabled or retired cannot answer a completion, so offering it only earns
                // the client an upstream error. Both fields are optional: an entry that reports neither stays listed,
                // which is how a server that publishes no such flag keeps every model.
                if (m.enabled === false) return;
                if (typeof m.status === 'string' && m.status !== '' && m.status !== 'active') return;
                const providerID = typeof m.providerID === 'string' && m.providerID !== '' ? m.providerID : 'opencode';
                models.push({
                    id: `${providerID}/${m.id}`,
                    name: m.name || m.id,
                    object: 'model',
                    owned_by: providerID
                });
            });
            if (models.length === 0) {
                // Models the gateway cannot read a name out of (an empty list, a changed shape, every entry disabled)
                // answer 200 with nothing to choose from: that takes the same fallback path as an empty model
                // list, and - unlike a real listing - is not cached.
                logger.warn('[Proxy] The backend reported no models, using the static fallback');
                return serveFallback();
            }
            modelsCache = { object: 'list', data: models };
            modelsFallbackAt = 0;
            modelsCacheBody = JSON.stringify(modelsCache);
            modelsById = new Map(models.map((model) => [model.id, model]));
            // Stamped when the answer arrives, not when the round trip started: the TTL used to be measured from the
            // moment the provider call began, so a call slower than the TTL cached an entry that was already expired
            // and every listing paid a full round trip (a 6 s provider against the 5 s TTL never hit the cache).
            modelsCacheAt = Date.now();
            return models;
        } catch (error) {
            // A rejected listing is an upstream failure, not a gateway defect: name the status and the reason the same
            // way the resolved-tuple branch above does, so the sentence an operator greps for is one sentence.
            modelListingRejected(error);
            // Every other upstream payload that reaches a log line or a response goes through the masking helpers:
            // this line quoted `error.message` (the documented symptom of a credential-bearing backend URL) and the
            // raw `error.response` body, so a proxy in front of the backend could have put a secret in `docker logs`.
            logger.error('[Proxy] Model Fetch Error:', {
                error: clientFacingText(error.message),
                status: error.status,
                body: maskDetail(error.response?.data ?? error.responseBody ?? null)
            });
            // Same item shape as a provider-served model, and not cached: the next request probes the backend again
            return serveFallback();
        }
    };

    app.get('/v1/models', { schema: { response: { 200: MODELS_SCHEMA } } }, async (request, reply) => {
        // A warm cache answers with the body built when it was filled (Fastify sends a string payload as it is, the
        // way `/health` and `/` do); a cold or too-old cache takes the object path, which is also what the fallback
        // uses. `warmModelsCache()` includes the expired-but-bounded entry, so the 5 s cliff is a background refresh
        // rather than a provider round trip on this request.
        if (warmModelsCache() && modelsCacheBody) {
            return reply.type('application/json; charset=utf-8').send(modelsCacheBody);
        }
        return { object: 'list', data: await loadModels() };
    });

    // OpenAI clients (and several SDKs) look a model up by id. The gateway does not restrict the model a chat
    // request may use, so an id that is not in the provider list is described here instead of being a 404.
    const describeModel = async (requestedId) => {
        // A warm cache answers from the map built with it - both are filled together, so the map can be no fresher
        // than the entry - and an expired-but-bounded one answers from the same map instead of paying a provider round
        // trip per by-id lookup (clients resolve the model before every completion). A cold or too-old cache reloads
        // the listing, one backend round trip like the listing route.
        const known = warmModelsCache()
            ? (modelsById ? modelsById.get(requestedId) : null)
            : (await loadModels()).find((m) => m.id === requestedId);
        if (known) return known;
        // The default model answers with its own name even when a healthy backend lists other models: it is the id a
        // request that omits `model` is sent to, so it should not be described as the bare id-derived `big-pickle`.
        if (requestedId === DEFAULT_MODEL_ID) return DEFAULT_MODEL;
        const slash = requestedId.indexOf('/');
        const provider = slash > 0 ? requestedId.slice(0, slash) : 'opencode';
        // `>= 0`, not `> 0`: an id whose first segment is empty (`/big-pickle`) has its separator at index 0, and
        // `> 0` answered `name: "/big-pickle"` - the separator as part of a model name - while the documented
        // derivation (`provider` = text before `/`, default `opencode`) yields `big-pickle`. `/big-pickle` is refused
        // `400` by `/v1/chat/completions`, so the two routes named the same non-model differently.
        const name = slash >= 0 ? requestedId.slice(slash + 1) : requestedId;
        return { id: requestedId, name, object: 'model', owned_by: provider };
    };
    const modelByIdSchema = { schema: { response: { 200: MODEL_SCHEMA } } };
    // An id whose last segment is empty addresses no model: `/v1/models/%2F` and `/v1/models/opencode%2F` reached the
    // routes below with `/` and `opencode/` and were described as models with an empty (or separator) name - the same
    // class of non-model the blank id was.
    // The question is only "does the id end in a separator?": `split('/').pop()` built an array and one string per
    // segment per by-id request (97 ns against 24 ns) on one of the two documented hot read routes.
    const isDescribableModelId = (id) => Boolean(id && id[id.length - 1] !== '/');
    // A blank id (`/v1/models//`, `/v1/models/%20`) reaches this route with an empty param, because a doubled slash is
    // read as a trailing slash. Describing "" answered 200 with `{"id":"","name":""}` - not a model at all - so a blank
    // id is a missing route instead. `/v1/models/` itself still answers the listing.
    app.get('/v1/models/:modelId', modelByIdSchema, async (request, reply) => {
        const modelId = String(request.params?.modelId || '').trim();
        if (!isDescribableModelId(modelId)) return reply.callNotFound();
        return describeModel(modelId);
    });
    // Model ids contain slashes (`opencode/big-pickle`), and clients send them unencoded as often as escaped:
    // without the wildcard route the unencoded form hit the 404 handler.
    app.get('/v1/models/*', modelByIdSchema, async (request, reply) => {
        // `/v1/models/` answers the listing (a trailing slash is ignored), so an empty id here means a doubled slash or
        // a blank segment. Describing "" would answer 200 with `{"id":"","name":""}`, which is not a model at all - the
        // request addressed a route that does not exist.
        const modelId = String(request.params?.['*'] || '').trim();
        if (!isDescribableModelId(modelId)) return reply.callNotFound();
        return describeModel(modelId);
    });

    // Debug logs all go through the logger (visible with LOG_LEVEL=debug; the legacy DEBUG switch is still
    // honoured, startProxy maps DEBUG=true onto the debug level)
    // Debug lines are guarded here rather than at each call site: a disabled level must not pay for the call, and the
    // fixed two-argument form keeps the rest array out of the hot path (`logger.debug(...args)` allocated one per
    // call). Call sites that build an expensive value (`loggableUrl()`) still guard themselves, because their argument
    // is evaluated before this function runs.
    const logDebug = (message, detail) => {
        if (logger.isEnabled('debug')) logger.debug(message, detail);
    };

    const TOOL_GUARD_MESSAGE = 'Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools.';
    const applyToolGuard = (systemMsg) => {
        if (!DISABLE_TOOLS) return systemMsg || undefined;
        if (systemMsg && systemMsg.trim()) {
            return `${systemMsg}\n\n${TOOL_GUARD_MESSAGE}`;
        }
        return TOOL_GUARD_MESSAGE;
    };

    // Removes every `<function_calls>…</function_calls>` block and every stray tag of either kind, in one left-to-right
    // pass. It used to be `/<function_calls>[\s\S]*?<\/function_calls>/g`, whose lazy quantifier restarts a search for
    // the closing tag at every opening one: an answer carrying many *unclosed* tags (a model that renders its tool
    // attempts as text emits exactly that) cost O(tags x length) - 32 000 tags in 512 KB measured 2.2 s, 64 000 in
    // 1 MB measured 8.5 s - on the thread that serves `/health` and holds the only completion slot. This is linear
    // (1.6 ms and 3.1 ms for the same two inputs) and produces the identical string: `lastClose` rules out a closing
    // tag once and for all, so an unclosed opener is dropped without rescanning the rest of the answer.
    const TOOL_OPEN_TAG = '<function_calls>';
    const TOOL_CLOSE_TAG = '</function_calls>';
    const removeToolMarkup = (text) => {
        const lastClose = text.lastIndexOf(TOOL_CLOSE_TAG);
        let out = '';
        let keep = 0;   // start of the text not yet copied to `out`
        let scanAt = 0; // candidate tag position
        while (scanAt < text.length) {
            const at = text.indexOf('<', scanAt);
            if (at === -1) break;
            if (text.startsWith(TOOL_OPEN_TAG, at)) {
                if (at + TOOL_OPEN_TAG.length <= lastClose) {
                    const end = text.indexOf(TOOL_CLOSE_TAG, at + TOOL_OPEN_TAG.length);
                    out += text.slice(keep, at);
                    keep = scanAt = end + TOOL_CLOSE_TAG.length;
                } else {
                    out += text.slice(keep, at);
                    keep = scanAt = at + TOOL_OPEN_TAG.length;
                }
                continue;
            }
            if (text.startsWith(TOOL_CLOSE_TAG, at)) {
                out += text.slice(keep, at);
                keep = scanAt = at + TOOL_CLOSE_TAG.length;
                continue;
            }
            scanAt = at + 1; // an unrelated '<' stays in the answer
        }
        return out + text.slice(keep);
    };

    /**
     * The text a part's snapshot added since the snapshot already seen.
     * A `session.text.ended` / `session.reasoning.ended` event carries the part's **whole** text, so the increment is
     * that text minus the previous snapshot of the same part. In 2.x the deltas already delivered the text, which is
     * why the delta path feeds its running total here: the closing event then diffs to nothing instead of appending
     * the answer a second time. Two further details matter. The snapshot is tracked **per part**: it used
     * to be diffed against the accumulated answer of the whole message, so a message with more than one text part (a
     * model that writes, calls a tool, then keeps writing) never matched and every event re-sent its part in full.
     * And the append is checked by length plus a bounded head/tail comparison instead of comparing the whole prefix,
     * which made each event cost O(answer): the fallback below still serves the whole snapshot when a backend rewrote
     * earlier text rather than appending.
     */
    const SNAPSHOT_EDGE_CHARS = 32;
    const snapshotDelta = (previous, text) => {
        if (!previous) return text;
        if (text.length <= previous.length) return text === previous ? '' : text;
        const edge = Math.min(previous.length, SNAPSHOT_EDGE_CHARS);
        const tailAt = previous.length - edge;
        if (text.startsWith(previous.slice(0, edge)) && text.startsWith(previous.slice(tailAt), tailAt)) {
            return text.slice(previous.length);
        }
        return text;
    };

    const stripFunctionCalls = (text, trim = true) => {
        if (!DISABLE_TOOLS || !text) return text;
        const cleaned = removeToolMarkup(text);
        return trim ? cleaned.trim() : cleaned;
    };

    // Streaming version of stripFunctionCalls. A delta can end in the middle of `<function_calls>` (or of its
    // closing tag), so a trailing fragment that is still a prefix of either tag is held back until the next delta
    // either completes it or rules it out - otherwise the raw markup leaks into the answer the client sees.
    const createToolCallFilter = () => {
        if (!DISABLE_TOOLS) {
            const passThrough = (chunk) => chunk;
            passThrough.flush = () => '';
            return passThrough;
        }
        const OPEN_TAG = '<function_calls>';
        const CLOSE_TAG = '</function_calls>';
        // The longest partial tag that must be held back is one character shorter than the longest tag, and the
        // closing tag is longer than the opening one: sizing the window from OPEN_TAG alone missed a delta boundary
        // that fell one character into the closing tag (`</function_calls` without the `>`), which dropped that
        // character, never matched the tag again, and silently discarded the rest of the answer.
        const MAX_HELD = Math.max(OPEN_TAG.length, CLOSE_TAG.length) - 1;
        let inBlock = false;
        let held = '';
        // The text seen since the opening tag that is still open. A closed block is dropped whole, so this is only
        // read by `flush()`: `removeToolMarkup()` drops an *unclosed* opening tag and keeps the text after it, and the
        // streaming filter used to return `''` there, losing the rest of the answer.
        let pending = '';
        // Splits text into the part that can be written out and the suffix that could still become a tag.
        // Both tags start with '<', so at most one suffix can be a tag prefix: the text after the **last** '<' inside
        // the hold-back window. That one backward search replaces a loop that sliced up to MAX_HELD suffixes per delta
        // (112 ns against 26 ns, and 16 fewer allocations for every delta of every stream).
        const splitAtPossibleTag = (text) => {
            const windowStart = text.length > MAX_HELD ? text.length - MAX_HELD : 0;
            const at = text.lastIndexOf('<');
            if (at === -1 || at < windowStart) return [text, ''];
            const tail = text.slice(at);
            if (!OPEN_TAG.startsWith(tail) && !CLOSE_TAG.startsWith(tail)) return [text, ''];
            return [text.slice(0, at), tail];
        };
        const filter = (chunk) => {
            if (!chunk && !held) return chunk;
            let buffer = held + (chunk || '');
            held = '';
            let output = '';
            while (buffer.length) {
                if (inBlock) {
                    const endIdx = buffer.indexOf(CLOSE_TAG);
                    if (endIdx === -1) {
                        // Still inside a block: the text is not written out, but it is kept for `flush()` (the block
                        // may turn out never to close). Only a fragment that could still become a tag is held back, so
                        // a closing tag split across two deltas is still recognised by the next call.
                        const [emit, tail] = splitAtPossibleTag(buffer);
                        pending += emit;
                        held = tail;
                        return output;
                    }
                    // The block closed: everything inside it was markup, and `removeToolMarkup()` drops it
                    pending = '';
                    buffer = buffer.slice(endIdx + CLOSE_TAG.length);
                    inBlock = false;
                    continue;
                }
                // A stray closing tag is markup too. Looking only for the opening one wrote `</function_calls>` to the
                // client verbatim, while the non-streaming scan removes both kinds.
                const startIdx = buffer.indexOf(OPEN_TAG);
                const strayCloseIdx = buffer.indexOf(CLOSE_TAG);
                if (strayCloseIdx !== -1 && (startIdx === -1 || strayCloseIdx < startIdx)) {
                    output += buffer.slice(0, strayCloseIdx);
                    buffer = buffer.slice(strayCloseIdx + CLOSE_TAG.length);
                    continue;
                }
                if (startIdx === -1) {
                    const [emit, tail] = splitAtPossibleTag(buffer);
                    held = tail;
                    return output + emit;
                }
                output += buffer.slice(0, startIdx);
                buffer = buffer.slice(startIdx + OPEN_TAG.length);
                inBlock = true;
                pending = '';
            }
            return output;
        };
        // End of stream: a held fragment turned out not to be a tag, and a block that never closed released the text
        // after its opening tag - the same two shapes `removeToolMarkup()` answers.
        filter.flush = () => {
            const rest = held;
            held = '';
            if (inBlock) {
                inBlock = false;
                const text = (pending + rest).split(OPEN_TAG).join('');
                pending = '';
                return text;
            }
            return rest;
        };
        return filter;
    };

    // `DISABLE_TOOLS` on a 2.x server.
    //
    // The 1.x mechanism was a per-tool override map: the gateway enumerated the backend's tool ids
    // (`GET /experimental/tool/ids`), set each one to `false` and posted the map as `tools` on the prompt. None of that
    // exists in 2.x: every `/api/tool/*` route answers 404, and the prompt body has no `tools` field.
    //
    // What 2.x does have is a per-session permission ruleset (`Permission.Rule[]`, each `{action, resource, effect}`),
    // accepted by `session.create({permissions})` and enforced by the server: a denied action is refused before the
    // tool runs, rather than being a suggestion in the prompt. Every action the default agent can use is denied here,
    // so no tool can run and the answer is produced from the model alone.
    //
    // Two read-only tools stay allowed, for the reason the 1.x map also kept them: with a free zen model, denying
    // `read` or `glob` made the prompt request hang forever instead of answering.
    const TOOLS_ALLOWED_WHEN_DISABLED = ['read', 'glob'];
    // Every action a 2.x agent's ruleset names. `edit`, `shell`, `webfetch`, `websearch` and `skill` are the ones that
    // can change something or reach the network; the rest are their neighbours in the built-in agents' rulesets. A
    // server that adds an action is still covered by the trailing `*` rule below.
    const TOOL_DENY_ACTIONS = [
        'edit', 'shell', 'write', 'grep', 'webfetch', 'websearch', 'subagent',
        'external_directory', 'question', 'skill', 'task', 'todowrite', 'todoread',
        'lsp', 'browser', 'patch', 'multiedit', 'invalid'
    ];

    /**
     * The permission ruleset that disables tools on a 2.x session, or `undefined` when tools are enabled.
     *
     * Built fresh per session rather than cached: a ruleset is a handful of small objects, the completion that needs it
     * already creates a session, and the 1.x cache existed only because the tool list cost a backend round trip - which
     * is exactly what this no longer does.
     * @returns {Array<{action: string, resource: string, effect: string}>|undefined}
     */
    const toolPermissionRules = () => {
        if (!DISABLE_TOOLS) return undefined;
        const deny = (action) => ({ action, resource: '*', effect: 'deny' });
        // The named actions come first so the ruleset reads as what it denies, then `*` catches an action this list
        // does not know about (a server that grows one), and the read-only pair is re-stated last as the single
        // exception. A 2.x server evaluates the rules in order and the last match for an action is not necessarily the
        // winner, so the allow pair is the only rule that mentions those two actions at all.
        return [
            ...TOOL_DENY_ACTIONS.map(deny),
            deny('*'),
            ...TOOLS_ALLOWED_WHEN_DISABLED.map((action) => ({ action, resource: '*', effect: 'allow' }))
        ];
    };

    // Kept for the debug line and for callers that ask "is anything disabled?" without building the ruleset.
    const toolsDisabled = () => DISABLE_TOOLS;

    async function promptWithTimeout(promptParams, timeoutMs) {
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(timeoutMessage(timeoutMs))), timeoutMs);
        });
        // The promise that loses a race keeps running. A rejection that arrives after the timeout - a backend that
        // dies, or the aborted fetch from the deadline below - used to reach nothing and become an unhandled
        // rejection, which ends the process by default: one slow completion could take the whole gateway down.
        // The 2.x client takes the flat input object (`{sessionID, text, …}`) and the request options as a *second*
        // argument, where 1.x merged the deadline into the same object. Merging it here would have sent `signal` as
        // part of the prompt payload and left the call with no deadline at all.
        const promptPromise = client.session.prompt(promptParams, backendDeadline(timeoutMs));
        promptPromise.catch(() => { });
        try {
            return await Promise.race([promptPromise, timeoutPromise]);
        } finally {
            // Without this the pending timer keeps the event loop (and the process) alive for up to 5 minutes
            // after the answer has already been sent
            if (timer) clearTimeout(timer);
        }
    }

    class NoEventDataError extends Error {
        constructor(message) {
            super(message);
            this.name = 'NoEventDataError';
        }
    }

    // A provider failure reported by the backend for a completion that produced no text. A streaming request has to
    // raise it so the stream can be terminated with an in-band error frame, exactly like any other post-header
    // failure: the alternative is a successful-looking stream whose only "answer" is an error message.
    class ProviderError extends Error {
        /**
         * @param {string} message the sentence the client and the log line show
         * @param {number} [status] the upstream status, when one could be read
         * @param {unknown} [cause] the failure this one was built from. A 2.x `ClientError` carries the backend's answer
         *   on `.error`, and a wrapper that dropped it left the error log with `bodySummary: null` - the summary bound
         *   existed and was never applied. `extractUpstreamError()` walks the `cause` chain for exactly this.
         */
        constructor(message, status, cause) {
            super(message, cause === undefined ? undefined : { cause });
            this.name = 'ProviderError';
            if (status !== undefined) this.status = status;
        }
    }

    /**
     * The one line a model listing that did not answer gets, whichever shape the failure arrived in.
     *
     * The 2.x client throws, the 1.x one resolved `{error, response}`, and a translating proxy may do either, so both
     * call sites would otherwise word the same event differently - and the wording is what an operator greps for when a
     * client shows only `big-pickle`. The reason goes through `upstreamFailureReason()`, so a credential-bearing
     * sentence is masked and an unreachable backend says so instead of quoting `fetch failed` on its own.
     * @param {unknown} failure a thrown error or a resolved `{error}` wrapper
     */
    const modelListingRejected = (failure) => {
        const { status, reason } = upstreamFailureReason(failure);
        logger.warn(
            `[Proxy] The backend rejected the model listing${status ? ` (status ${status})` : ''}${reason}, using the static fallback`
        );
    };

    // What actually arrived, for a debug line: the top-level type and a few keys tell an envelope change (a "data" or
    // "messages" wrapper) from an error body, which is the whole question when a poll answers with a payload nobody
    // can read.
    const describePayload = (value) => {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (Array.isArray(value)) return `array(${value.length})`;
        if (typeof value !== 'object') return typeof value;
        const keys = Object.keys(value);
        return `object(${keys.slice(0, 6).join(',')}${keys.length > 6 ? ',...' : ''})`;
    };

    function extractFromParts(parts) {
        if (!Array.isArray(parts)) return { content: '', reasoning: '' };
        // Single pass, no intermediate arrays: this runs for every polled message of every request
        let content = '';
        let reasoning = '';
        for (let i = 0; i < parts.length; i += 1) {
            const part = parts[i];
            if (!part) continue;
            // Only a string is text. `content += part.text || ''` stringified whatever arrived, so a part carrying a
            // number or an object (a changed backend shape, a proxy rewriting payloads) was served as assistant text:
            // `parts: [{text: 42}, {text: ' ok'}]` answered `"42 ok"`, and an object part answered `[object Object]`.
            // The streaming collector (`typeof part.text === 'string'`) and the request parser (`… .text must be a
            // string`) already refuse that shape; this was the one reader that did not.
            if (typeof part.text !== 'string' || part.text === '') continue;
            if (part.type === 'text') content += part.text;
            else if (part.type === 'reasoning') reasoning += part.text;
        }
        return { content, reasoning };
    }

    /**
     * A provider failure as one client-facing sentence: the provider's name and its own text, masked and bounded.
     *
     * Both answer modes end with this sentence - the 502 body, the in-band error frame, the log line - because it is
     * provider-controlled text that routinely quotes the credential it rejected. One helper keeps the two modes from
     * disagreeing about the same payload (they did: the streaming path masked it, the non-streaming one did not).
     */
    const describeProviderFailure = (error) => {
        const detail = clientFacingText(error?.data?.message || error?.message) || 'Unknown error';
        return `${error?.name || 'OpenCodeError'}: ${detail}`;
    };

    /**
     * The assistant message `client.session.prompt` already returned, when the provider is done writing it.
     *
     * **A 2.x prompt does not return one.** `POST /api/session/{id}/prompt` answers with the *user inbox item* it just
     * enqueued (`{data:{id,type:'user',…}}`); the assistant's answer is written afterwards and is read through the event
     * stream or by polling `GET /api/session/{id}/message`. So the fast path 1.x allowed - serving the finished message
     * the prompt response already carried instead of spending a poll - has nothing to read here and returns `null` for
     * every 2.x answer, which is the correct outcome rather than a missing optimisation.
     *
     * The 1.x shape is still recognised on purpose. A deployment that fronts the gateway with something translating the
     * two APIs, or a 2.x release that starts answering with the finished message again, then keeps the round trip it
     * saves instead of silently losing it. A message that is still being written carries no `finish`, and that case
     * keeps using the poll loop either way.
     */
    const completedPromptMessage = (result) => {
        // The 2.x client unwraps the response envelope once, so the payload arrives as the message itself, while the 1.x
        // one handed back the enveloped form. Both are accepted rather than betting the fast path on one SDK's
        // unwrapping: reading only `result.data` recognised nothing the 2.x client returns.
        const candidates = [];
        if (result && typeof result === 'object') {
            candidates.push(result);
            if (result.data && typeof result.data === 'object') candidates.push(result.data);
        }
        let message = null;
        let info = null;
        for (const candidate of candidates) {
            // 1.x: `{info:{…},parts:[…]}`. A 2.x prompt answers with the user inbox item, which is neither.
            const found = candidate.info || (candidate.type === 'assistant' ? candidate : null);
            if (found) {
                message = candidate;
                info = found;
                break;
            }
        }
        if (!info) return null;
        // opencode reports the end of a message either with a finish reason or with a completion stamp only
        if (!info.finish && !info.time?.completed) return null;
        // A step that asked for a tool is *finished* (`finish: "tool-calls"`) while the step that answers it is still
        // being written - the reason the poll loop reads the newest assistant message instead of the first finished one.
        // Serving this step here reintroduced that truncation on the fast path: the client got the model's preamble for
        // a request that went on to run a tool and answer. It is an intermediate step, so the poll loop handles it.
        if (String(info.finish || '').toLowerCase() === 'tool-calls') return null;
        // 2.x carries the answer as `content:[{type:'text'|'reasoning',text}]`; 1.x as `parts:[…]`.
        const fragments = Array.isArray(message.parts) ? message.parts : message.content;
        const { content, reasoning } = extractFromParts(fragments);
        const error = info.error || null;
        // Nothing to serve and no failure to report: the staged message is not the answer, poll for it
        if (!content && !reasoning && !error) return null;
        return { content, reasoning, error };
    };

    /**
     * Turns a rejected `client.session.prompt` into the same upstream failure the other backend calls report.
     *
     * The 2.x client **throws** on a non-2xx answer (`InvalidRequestError`, `UnauthorizedError`, a `ClientError`
     * wrapping `fetch` for an unreachable backend) instead of resolving with the `{ error, response }` tuple 1.x used,
     * so the rejection now reaches the handler's own catch; this guard covers the tuple form as well, because a proxy
     * that translates the API - or a future client that resolves it - would otherwise make a prompt the backend
     * rejected (expired credentials, a rate limit, an unknown model) look like a slow answer: no assistant message was
     * ever created, so polling could only run out the whole request budget and answer 504 while holding the slot.
     */
    const throwIfPromptRejected = (result, hasAnswer) => {
        if (!result || !result.error || hasAnswer) return;
        throw promptRejected(result);
    };

    /**
     * The upstream failure a rejected `client.session.prompt` becomes, whichever way the rejection arrived.
     *
     * The 2.x client throws, and a status it has no typed error for arrives as `ClientError("UnexpectedStatus: 500")`
     * with the number only on `cause.status` and the response body dropped. That is still the backend refusing the
     * prompt, so it is named the same way as a resolved `{error}` tuple: without this, the refusal reached the
     * handler's own catch and was answered `500 server_error` - the gateway blaming itself for the backend's answer.
     * @param {unknown} failure the thrown error or the resolved `{error}` wrapper
     * @returns {ProviderError}
     */
    const promptRejected = (failure) => {
        const { status, reason } = upstreamFailureReason(failure);
        const thrown = failure instanceof Error ? failure : (failure?.error instanceof Error ? failure.error : undefined);
        return new ProviderError(
            `OpenCode backend rejected the prompt${status ? ` (status ${status})` : ''}${reason}`,
            status,
            thrown
        );
    };

    /**
     * `client.session.prompt`, with a thrown rejection turned into the upstream failure it is.
     *
     * The 2.x client throws on every non-2xx answer, so the prompt's own catch never sees a rejected prompt - and the
     * handler's catch answered it as `500 server_error`, which tells a client the gateway has a bug. A status the
     * generated client has no typed error for arrives as `ClientError("UnexpectedStatus: 500")` (the number only on
     * `cause.status`, the body dropped), so the presence of a status is what marks a refusal; a transport failure (the
     * backend died, the deadline expired) keeps its own wording, which names a cause the client can act on.
     * @param {object} promptParams the flat 2.x prompt input
     * @param {number} timeoutMs the budget for this call
     */
    async function promptCall(promptParams, timeoutMs) {
        try {
            return await promptWithTimeout(promptParams, timeoutMs);
        } catch (error) {
            if (!isTimeoutError(error) && typeof upstreamErrorStatus(error) === 'number') {
                throw promptRejected(error);
            }
            throw error;
        }
    }

    async function pollForAssistantResponse(sessionId, timeoutMs, intervalMs = DEFAULT_POLL_INTERVAL_MS, shouldAbort = null, options = {}) {
        const pollStart = Date.now();
        const startedAt = Date.now();
        // `requireDone` waits for the finished message instead of answering with whatever the first poll saw. Without
        // it a non-streaming request returned the text written so far: the poll loop can start while the answer is
        // still being generated, which truncated it. A provider that never marks its message finished is still
        // answered once the text has not grown for `stablePollsRequired` intervals (~1.5 s, measured as time - see
        // `stableWindowMs` below, not as a count of polls).
        const requireDone = Boolean(options.requireDone);
        // How long an unchanged message means "this message will never be marked finished". Three intervals (~1.5 s)
        // is right after a normal prompt, but not after an idle timeout: the backend has been silent for the whole
        // idle window already, and giving up 1.5 s into the same silence truncated an answer a slow model was still
        // writing (the client got `finish_reason: "stop"` for text that stopped mid-sentence). That path asks for a
        // full idle window instead.
        const stablePollsRequired = Number.isFinite(options.stablePollsRequired) && options.stablePollsRequired >= 1
            ? Math.floor(options.stablePollsRequired)
            : 3;
        // Measured as time, not as polls. The first polls are far shorter than an interval (POLL_BACKOFF_MS), so
        // counting "three identical polls" would have meant 75 ms of silence instead of 1.5 s and started accepting
        // half-written answers; a window keeps the documented behaviour whatever the poll cadence is.
        const stableWindowMs = stablePollsRequired * intervalMs;
        // What counts as "the answer is no longer growing": both halves of the visible answer, because a message can
        // carry reasoning and no text at all. Watching `content` alone left `stableFor` at 0 for a reasoning-only
        // message, so a provider that never sets `finish` could not be accepted and the completion ended in `504` on
        // its whole budget (measured 4.4 s of a 4 s budget) for an answer the first poll already held.
        let lastAnswerContent = '';
        let lastAnswerReasoning = '';
        let lastAnswerAt = 0;
        let pollIndex = 0;
        // One failed poll used to end the whole completion: a single 5xx or a reset connection while the backend was
        // busy threw out of the loop, so the client got an error although the answer was one poll away. Polls are
        // retried instead, and only a run of consecutive failures (the backend really is gone) is reported.
        let consecutiveFailures = 0;
        while (Date.now() - startedAt < timeoutMs) {
            // A disconnected client must not keep the completion queue busy while polling for an answer nobody reads
            if (shouldAbort && shouldAbort()) {
                logDebug('Polling abandoned', { sessionId, ms: Date.now() - pollStart });
                return { content: '', reasoning: '', aborted: true };
            }
            let messagesRes = null;
            try {
                // Each poll gets the budget that is left, not a fresh copy of it: a poll started just before the
                // deadline used to run for another full budget, so a wedged backend kept a completion alive for
                // about twice the advertised timeout (beyond the queue timer, which then answered a generic 500).
                //
                // The 2.x list is `client.message.list()` - a *top-level* namespace, not `session.message` (which only
                // carries `get`) - and is **newest first** unless `order: 'asc'` is asked for. The caller scans for the
                // newest assistant message and treats the tail as the answer, so the order is pinned here rather than
                // left to the server's default.
                messagesRes = await client.message.list({
                    sessionID: sessionId,
                    order: 'asc',
                    limit: DEFAULT_POLLED_MESSAGE_LIMIT
                }, backendDeadline(Math.max(1, timeoutMs - (Date.now() - startedAt))));
            } catch (error) {
                // The deadline is the caller's budget, not a failed poll: it still surfaces as a timeout
                if (isTimeoutError(error)) throw error;
                // The error itself, not a flattened `{error: message}`: an undeclared status arrives as a bare `Error`
                // whose message is empty and whose `.error` holds the response body, so flattening it to the message
                // lost both the reason and anything `upstreamErrorStatus()` could read.
                messagesRes = error;
            }
            const messages = Array.isArray(messagesRes?.data)
                ? messagesRes.data
                : (Array.isArray(messagesRes) ? messagesRes : null);
            if (!messages) {
                consecutiveFailures += 1;
                const { status, reason } = upstreamFailureReason(messagesRes);
                // A 2xx answer whose body is not a message list is not the backend saying "200: failed" - it is a
                // payload the gateway cannot read (an envelope change, a body from something that is not an OpenCode
                // backend). The shape is named instead, because `failed ... (status 200)` reads like a gateway bug and
                // sends the reader looking in the wrong place.
                const statusPhrase = status !== undefined && status >= 400 ? ` (status ${status})` : '';
                const unreadable = !reason && !statusPhrase
                    ? `: the backend answered with a payload that is not a message list (status ${status === undefined ? 'unknown' : status})`
                    : '';
                const detail = `${statusPhrase}${reason || unreadable}`;
                logger.warn('[Proxy] Polling failed', {
                    sessionId,
                    attempt: consecutiveFailures,
                    status: status === undefined ? null : status,
                    payload: logger.isEnabled('debug') ? describePayload(messagesRes) : undefined
                });
                if (consecutiveFailures >= MAX_POLL_FAILURES) {
                    throw new ProviderError(
                        `OpenCode backend failed while polling the answer${detail}`,
                        status
                    );
                }
            } else if (messages.length) {
                // A poll that answers is a healthy backend, whatever came before it: the limit is on *consecutive*
                // failures. Counting total ones ended a completion that was busy writing its answer - five hiccups
                // spread over a minute reported the upstream as gone while the answer was one poll away.
                consecutiveFailures = 0;
                // Only the newest assistant message can be the answer. The backend writes one per step, so a
                // tool-using completion holds several - the step that asked for the tool ends with
                // `finish: "tool-calls"`, and the real answer is written after it. Walking further back to find a
                // message that was already finished returned that earlier step as the answer (and the streaming
                // recovery appended it to what the client had), under `finish_reason: "stop"`.
                //
                // A 2.x message is flat - `{id, type:'assistant', content:[…], finish, time, error}` - where 1.x nested
                // the same fields under `info` with the fragments in `parts`. Both are read here: the poll must not
                // silently see "no assistant message" (and poll to its budget) because the envelope moved.
                let newest = null;
                let newestIsV2 = false;
                for (let i = messages.length - 1; i >= 0; i -= 1) {
                    const message = messages[i];
                    if (message?.info?.role === 'assistant') {
                        newest = message;
                        break;
                    }
                    if (message?.type === 'assistant') {
                        newest = message;
                        newestIsV2 = true;
                        break;
                    }
                }
                if (newest) {
                    const info = newestIsV2 ? newest : newest.info;
                    const { content, reasoning } = extractFromParts(
                        Array.isArray(newest.parts) ? newest.parts : newest.content
                    );
                    // A 2.x message carries its own error object; a 1.x one nests it under `info`.
                    const error = (newestIsV2 ? newest.error : info?.error) || null;
                    const done = Boolean(info?.finish || info?.time?.completed || error);
                    let stableFor = 0;
                    // `content || reasoning` keeps the guard the single-field version had: an empty poll is a normal
                    // "not written yet" answer, never a finished one, so it may only restart the window.
                    if ((content || reasoning) && content === lastAnswerContent && reasoning === lastAnswerReasoning) {
                        stableFor = Date.now() - lastAnswerAt;
                    } else {
                        lastAnswerContent = content;
                        lastAnswerReasoning = reasoning;
                        lastAnswerAt = Date.now();
                    }
                    if (done || stableFor >= stableWindowMs || (!requireDone && (content || reasoning))) {
                        if (error) {
                            // The provider's own text: masked and bounded like every other upstream reason, because a
                            // provider error can quote the credential it rejected and its message has no size (100 KB
                            // of padding became a 32 KB log line, and hid the request-log assertion behind it)
                            logger.error('[Proxy] OpenCode assistant error:', {
                                sessionId,
                                error: { name: error.name || null, message: clientFacingText(error.data?.message || error.message) }
                            });
                        }
                        if (logger.isEnabled('debug')) {
                            logger.debug('Polling completed', {
                                sessionId,
                                ms: Date.now() - pollStart,
                                done,
                                contentLen: content.length,
                                reasoningLen: reasoning.length,
                                error: error ? error.name : null
                            });
                        }
                        return { content, reasoning, error };
                    }
                }
            } else {
                // An empty list is a normal "not written yet" poll, not a failure
                consecutiveFailures = 0;
            }
            // The first polls are short (see POLL_BACKOFF_MS), then the caller's interval applies
            const waitMs = pollIndex < POLL_BACKOFF_MS.length
                ? Math.min(intervalMs, POLL_BACKOFF_MS[pollIndex])
                : intervalMs;
            pollIndex += 1;
            await sleep(waitMs);
        }
        logDebug('Polling timeout', { sessionId, ms: Date.now() - pollStart });
        throw new Error(timeoutMessage(timeoutMs));
    }

    /**
     * Subscribes to the OpenCode event stream and forwards streamed deltas.
     * Returns the completion promise plus controls, so the caller can cut the first-delta wait short once the
     * prompt call itself has returned: at that point the full answer is available through polling anyway.
     */
    async function collectFromEvents(sessionId, timeoutMs, onDelta, firstDeltaTimeoutMs, idleTimeoutMs) {
        const controller = new AbortController();
        // The 2.x client returns the event iterator directly (`client.event.subscribe(input?, {signal})`), where 1.x
        // resolved with `{stream}` and never threw. A subscription the server refuses therefore arrives as a rejected
        // promise; the failure is reported with its status, exactly as the missing 1.x stream was.
        let eventStream;
        let eventStreamError = null;
        try {
            eventStream = await client.event.subscribe(undefined, { signal: controller.signal });
        } catch (error) {
            eventStreamError = error;
        }
        if (!eventStream || typeof eventStream[Symbol.asyncIterator] !== 'function') {
            const { status, reason } = upstreamFailureReason({ error: eventStreamError });
            throw new ProviderError(
                `OpenCode backend rejected the event subscription${status ? ` (status ${status})` : ''}${reason}`,
                status
            );
        }
        let finished = false;
        let content = '';
        let reasoning = '';
        let receivedDelta = false;
        let deltaChars = 0;
        // Snapshots seen per part key, so an incremental event is diffed against its own part (see snapshotDelta). The
        // key is the backend's part id when it sends one; an id-less part is keyed by its type, and one answer can
        // carry several id-less parts of the same type, so a key holds the snapshots of every part it stands for and the
        // increment is taken against the one the new text continues.
        //
        // A snapshot is a one-field object rather than a bare string so the delta path can keep a **reference** to the
        // entry it extended (`partTotals`) and update it in place: a delta already *is* the increment, so re-diffing
        // the whole answer to rediscover which entry to update cost O(answer) per delta (measured 217 ms for 2 000
        // deltas of a 1 MB answer, on the thread that streams it). The object is per part, never per delta.
        const partTexts = new Map();
        // The running total each part's deltas add up to, so a delta can seed the snapshot base the closing
        // `session.*.ended` event is diffed against. Without it that event carried the part's whole text with nothing
        // to compare it to, and the answer was appended a second time (measured: sent three times in total).
        // `{ total, slot }`: `slot` is the snapshot entry `total` came from, or null when the entry is gone (rewritten
        // by a closing event, or dropped by the bound), in which case the next delta goes back through
        // `recordPartSnapshot()`.
        const partTotals = new Map();
        // A bounded list: a part whose text is rewritten (SHRINK) starts a new entry, and a backend that rewrites on
        // every event must not grow this per completion.
        const MAX_PART_SNAPSHOTS = 4;
        // The same bound for the *number of parts*: `partKey()` builds its key out of backend-controlled text, so a
        // backend that varies it on every event grew `partTexts` for as long as the answer streamed, and the map is
        // only read for keys it already holds. Dropping the oldest key is safe because a part that has not been seen
        // again is over: the answer is append-only and the totals below are keyed by the same string, so a part
        // dropped here simply loses its snapshot bookkeeping and is re-based if it reappears.
        const MAX_PART_KEYS = 64;
        const partKeyOrder = [];
        const notePartKey = (key) => {
            // Both maps are keyed by this string, so both are bounded here: `partTotals` used to grow one permanent
            // entry per delta for a backend that varies the part id (`assistantMessageID` is backend-controlled text),
            // 200 000 deltas measured 200 000 entries and +44.6 MB of heap against a `partTexts` stuck at 64.
            if (partTexts.size > MAX_PART_KEYS) {
                const oldest = partKeyOrder.shift();
                if (oldest !== undefined && oldest !== key) {
                    partTexts.delete(oldest);
                    partTotals.delete(oldest);
                } else {
                    // The order list is empty or already points at this key: drop the first key the map itself reports,
                    // which is insertion order, so the bound is honoured either way.
                    const first = partTexts.keys().next();
                    if (!first.done && first.value !== key) {
                        partTexts.delete(first.value);
                        partTotals.delete(first.value);
                    }
                }
            }
            partKeyOrder.push(key);
            if (partKeyOrder.length > MAX_PART_KEYS) partKeyOrder.shift();
        };
        // The increment for a part snapshot, and the bookkeeping that keeps its base current. `snapshotDelta()` returns
        // the whole text when the new snapshot is not an extension of the base - the rewrite case, and also the first
        // update of a *different* id-less part of the same type - so that answer is what selects the base: an existing
        // snapshot it continues is updated in place, anything else becomes its own base.
        const recordPartSnapshot = (key, text) => {
            const snapshots = partTexts.get(key);
            if (!snapshots) {
                // The first text for this part: no earlier snapshot, so the whole text is the increment. Without a
                // key on the map, every part of this completion accumulated one permanent entry here - the map is
                // per completion and the key is built from backend-controlled text, so a backend that varies it grew
                // the map without bound for as long as the answer streamed.
                if (text) {
                    partTexts.set(key, [{ text }]);
                    notePartKey(key);
                }
                return text;
            }
            for (let i = snapshots.length - 1; i >= 0; i -= 1) {
                const increment = snapshotDelta(snapshots[i].text, text);
                if (increment !== text) {
                    // The part continues this snapshot: same base, new snapshot (an empty text drops a base that can
                    // no longer be continued, so `''` stays a fresh start rather than a prefix of everything)
                    if (text) snapshots[i].text = text;
                    else snapshots.splice(i, 1);
                    return increment;
                }
            }
            if (text) {
                snapshots.push({ text });
                if (snapshots.length > MAX_PART_SNAPSHOTS) snapshots.shift();
            }
            return text;
        };
        // Whether `slot` is still the entry some key's snapshot list holds. A rewritten part (`SHRINK`) or the
        // snapshot bound can drop the entry a running total came from; writing to a detached object would leave the
        // list stale and the closing event would append the part a second time. Four identity comparisons, no string
        // work, so this stays cheaper than the diff it replaces.
        const isLiveSnapshot = (key, slot) => {
            const snapshots = partTexts.get(key);
            if (!snapshots || !slot) return false;
            for (let i = 0; i < snapshots.length; i += 1) {
                if (snapshots[i] === slot) return true;
            }
            return false;
        };
        let firstDeltaAt = null;
        let firstDeltaTimer = null;
        let idleTimer = null;
        let timeoutId = null;
        let resolvePromise = null;
        const startedAt = Date.now();

        const settle = (value) => {
            if (finished) return;
            finished = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
            if (idleTimer) clearTimeout(idleTimer);
            controller.abort();
            resolvePromise(value);
        };

        const scheduleFirstDeltaTimer = (ms) => {
            if (!ms) return;
            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
            firstDeltaTimer = setTimeout(() => {
                if (finished || receivedDelta) return;
                logDebug('No event data received', { sessionId, ms: Date.now() - startedAt });
                settle({ content: '', reasoning: '', noData: true });
            }, ms);
        };

        // The idle timer is re-armed **in place**: `refresh()` restarts the same `Timeout` instead of building a new one,
        // and the callback reads `content` / `reasoning` / `deltaChars` from this closure, so a refreshed timer settles on
        // exactly what a rebuilt one would. Clear-and-create per delta allocated a `Timeout` for every delta of every
        // stream (4000 deltas measured 2.10 ms, against 0.28 ms with a refresh) - GC time a CPU profile of the gateway
        // attributed to streaming. `finished` returns early because `settle()` clears the timer: a collector that has
        // already settled must not re-arm anything.
        const scheduleIdleTimer = () => {
            if (!idleTimeoutMs || finished) return;
            if (idleTimer) {
                idleTimer.refresh();
                return;
            }
            idleTimer = setTimeout(() => {
                idleTimer = null;
                if (finished) return;
                if (logger.isEnabled('debug')) {
                    logger.debug('Event idle timeout', {
                        sessionId,
                        ms: Date.now() - startedAt,
                        deltaChars
                    });
                }
                settle({
                    content,
                    reasoning,
                    idleTimeout: true,
                    receivedDelta
                });
            }, idleTimeoutMs);
        };

        const promise = new Promise((resolve, reject) => {
            resolvePromise = resolve;
            timeoutId = setTimeout(() => {
                if (finished) return;
                finished = true;
                // The rejection path has to release the same timers `settle()` does: this is the one exit that does not
                // go through it (it rejects rather than resolving a result), and leaving the first-delta/idle timers
                // armed kept this collector's closure - the accumulated text and the stream buffers - alive for
                // another 4 s or 8 s after the request had already been answered with its budget error.
                if (firstDeltaTimer) {
                    clearTimeout(firstDeltaTimer);
                    firstDeltaTimer = null;
                }
                if (idleTimer) {
                    clearTimeout(idleTimer);
                    idleTimer = null;
                }
                controller.abort();
                reject(new Error(timeoutMessage(timeoutMs)));
            }, timeoutMs);

            scheduleFirstDeltaTimer(firstDeltaTimeoutMs);

            (async () => {
                try {
                    for await (const event of eventStream) {
                        // A collector that already settled must not touch the response again. The timers can settle it
                        // while the iterator still has buffered events, and `settle()` only resolves the promise: the
                        // loop kept running and handed those events to `onDelta`, so a stream that had fallen back to
                        // polling wrote the same answer twice (measured: every delta frame duplicated, on a stream that
                        // was already ended). Aborting the controller is the real stop; this is the guard that makes it
                        // immediate.
                        if (finished) break;
                        // The 2.x stream names the payload `data` and the kind `type` (a dot-separated name such as
                        // `session.text.delta`), where 1.x sent `message.part.updated` / `message.updated` with the
                        // payload under `properties`. Not every event carries one, so the read is guarded.
                        const data = event?.data;
                        if (!data) continue;
                        // Every event the collector cares about names its session. A global event (another session, a
                        // provider refresh) must not move this completion.
                        if (data.sessionID !== sessionId) continue;
                        // A part ordinal identifies one text or reasoning part of the assistant message, so the
                        // cumulative snapshots of two kinds never collide even though both count from zero.
                        const partKey = `${data.assistantMessageID || ''}:${data.ordinal || 0}`;
                        if (event.type === 'session.text.delta' || event.type === 'session.reasoning.delta') {
                            // 2.x sends real increments here, so the delta itself is what the client gets. The running
                            // total is still fed to `recordPartSnapshot()` on every delta, because `session.text.ended`
                            // closes the part with its **whole** text: without a base to diff against, that closing event
                            // looked like a part the gateway had never seen and appended the entire answer a second time
                            // (measured: a three-word answer arrived three times, once from the deltas and twice more
                            // from the closing events of the text and reasoning parts).
                            const isReasoning = event.type === 'session.reasoning.delta';
                            const delta = typeof data.delta === 'string' ? data.delta : '';
                            if (!delta) continue;
                            receivedDelta = true;
                            const snapshotKey = `${isReasoning ? 'r' : 't'}${partKey}`;
                            const held = partTotals.get(snapshotKey);
                            const running = (held ? held.total : '') + delta;
                            if (held && held.slot && held.slot.text === held.total && isLiveSnapshot(snapshotKey, held.slot)) {
                                // The entry this key's deltas have been extending is still live and still holds the base
                                // `running` was built from: the delta *is* the increment, so it is written straight in.
                                // `recordPartSnapshot()` re-diffed the whole answer to rediscover that entry, and
                                // `snapshotDelta()` flattens `base + delta` to slice it - O(answer) per delta, measured
                                // 217 ms for 2 000 deltas of a 1 MB answer on the thread that streams it.
                                held.slot.text = running;
                                held.total = running;
                            } else {
                                // First delta for this part, or its base was rewritten by a closing event or dropped by
                                // the snapshot bound: take the diff once, then remember the entry it landed on.
                                recordPartSnapshot(snapshotKey, running);
                                const snapshots = partTexts.get(snapshotKey);
                                let slot = null;
                                if (snapshots) {
                                    for (let i = 0; i < snapshots.length; i += 1) {
                                        if (snapshots[i].text === running) { slot = snapshots[i]; break; }
                                    }
                                }
                                partTotals.set(snapshotKey, { total: running, slot });
                            }
                            // The returned increment is deliberately ignored: the delta is already the increment, and it
                            // is what the timers and `deltaChars` below count. Recording it keeps the base current so the
                            // closing event diffs to nothing.
                            recordPartSnapshot(snapshotKey, running);
                            // Nulled here as well as on the budget path: the timer has fired by the time a delta
                            // arrives (it is cleared here), so every later delta cleared an already-dead handle
                            if (firstDeltaTimer) {
                                clearTimeout(firstDeltaTimer);
                                firstDeltaTimer = null;
                            }
                            scheduleIdleTimer();
                            if (!firstDeltaAt) {
                                firstDeltaAt = Date.now();
                                if (logger.isEnabled('debug')) {
                                    logger.debug('SSE first delta', {
                                        sessionId,
                                        ms: firstDeltaAt - startedAt,
                                        type: isReasoning ? 'reasoning' : 'text'
                                    });
                                }
                            }
                            if (isReasoning) {
                                reasoning += delta;
                                if (onDelta) await onDelta(delta, true);
                            } else {
                                content += delta;
                                if (onDelta) await onDelta(delta, false);
                            }
                            deltaChars += delta.length;
                            continue;
                        }
                        if (event.type === 'session.text.ended' || event.type === 'session.reasoning.ended') {
                            // The closing text of one part. It is a *snapshot*, not an increment, so it goes through the
                            // same diffing the 1.x cumulative `part.text` did: a server that streamed its deltas gets
                            // an empty increment here, and one that streamed nothing gets the whole part.
                            if (typeof data.text !== 'string' || data.text === '') continue;
                            const isReasoning = event.type === 'session.reasoning.ended';
                            const delta = recordPartSnapshot(`${isReasoning ? 'r' : 't'}${partKey}`, data.text);
                            // An empty increment means the deltas already delivered this text: the closing event is
                            // bookkeeping, and treating it as output is what duplicated the answer.
                            if (!delta) continue;
                            receivedDelta = true;
                            if (firstDeltaTimer) {
                                clearTimeout(firstDeltaTimer);
                                firstDeltaTimer = null;
                            }
                            scheduleIdleTimer();
                            if (!firstDeltaAt) firstDeltaAt = Date.now();
                            if (isReasoning) {
                                reasoning += delta;
                                if (onDelta) await onDelta(delta, true);
                            } else {
                                content += delta;
                                if (onDelta) await onDelta(delta, false);
                            }
                            deltaChars += delta.length;
                            continue;
                        }
                        // A provider failure: the execution failed outright, or one step did. It arrives on the event
                        // that ends the answer, so it is carried out with the text already collected rather than
                        // dropped - a truncated answer reported as `finish_reason: "stop"` is what dropping it produced.
                        if (event.type === 'session.execution.failed' || event.type === 'session.step.failed') {
                            if (logger.isEnabled('debug')) {
                                logger.debug('SSE provider failure', {
                                    sessionId,
                                    ms: Date.now() - startedAt,
                                    deltaChars,
                                    error: data.error?.name || data.error?.message || null
                                });
                            }
                            settle({ content, reasoning, error: data.error || null });
                            break;
                        }
                        // Any finished step ends the stream: `finish` is not always "stop" (a tool-call answer reports
                        // "tool-calls", others report "length" or only an unknown finish), and requiring the exact word
                        // "stop" left such an answer waiting for the idle timeout. A `tool-calls` step is the one
                        // exception: another step follows it, so ending there served the step that *asked* for the tool
                        // as the answer.
                        if (event.type === 'session.step.ended' && data.finish !== 'tool-calls') {
                            if (logger.isEnabled('debug')) {
                                logger.debug('SSE completed', {
                                    sessionId,
                                    ms: Date.now() - startedAt,
                                    deltaChars,
                                    finish: data.finish || null
                                });
                            }
                            settle({ content, reasoning, error: null });
                            break;
                        }
                        // The session has nothing left to do, and the turn is over. This is the 2.x replacement for the
                        // 1.x `message.updated` carrying `time.completed`: a server that reports no step finish (or a
                        // finish this gateway does not recognise) still ends the answer here instead of running into the
                        // idle timeout. `session.idle` and `session.execution.succeeded` both mean it.
                        if (event.type === 'session.idle' || event.type === 'session.execution.succeeded') {
                            if (logger.isEnabled('debug')) {
                                logger.debug('SSE completed', {
                                    sessionId,
                                    ms: Date.now() - startedAt,
                                    deltaChars,
                                    reason: event.type
                                });
                            }
                            settle({ content, reasoning, error: null });
                            break;
                        }
                    }
                    // The stream ended without ever reporting a finish event: the backend restarted, a proxy in front
                    // of it closed an idle connection, or the CLI tore the subscription down while it was still
                    // writing. The answer is usually complete and pollable by then, so the caller takes over with the
                    // recovery poll - waiting out the rest of the budget instead answered the client an in-band error
                    // while the finished message was sitting in the backend (measured: a 6 s budget spent on a stream
                    // closed after two deltas, then `data: {"error":…}` despite a complete stored answer).
                    if (!finished) {
                        if (logger.isEnabled('debug')) {
                            logger.debug('SSE stream ended without a finish event', {
                                sessionId,
                                ms: Date.now() - startedAt,
                                deltaChars
                            });
                        }
                        settle({ content, reasoning, streamEnded: true, receivedDelta });
                    }
                } catch (e) {
                    if (!finished) {
                        finished = true;
                        if (timeoutId) clearTimeout(timeoutId);
                        if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                        if (idleTimer) clearTimeout(idleTimer);
                        reject(e);
                    }
                }
            })();
        });

        return {
            promise: promise.finally(() => controller.abort()),
            /**
             * Called as soon as the prompt request returns.
             *
             * In 1.x this *shortened* the first-delta wait to a small grace period: the prompt response came back with
             * the finished message, so a stream with no delta by then was not delivering at all and polling could
             * answer immediately.
             *
             * In 2.x the prompt resolves with the **user** inbox item - the turn has been accepted, nothing has been
             * generated yet - and the first token follows seconds later (measured: 1.7-3.2 s). Collapsing the wait
             * here therefore discarded a working event stream on every single request: the collector settled with
             * `noData` before the backend's first lifecycle event existed, and the answer arrived as one polled chunk
             * at the end. That is a correct body with streaming defeated.
             *
             * So the window is re-armed from here instead: the prompt is accepted, and the first token gets a full
             * `firstDeltaTimeoutMs` from this point. A subscription that is genuinely dead still falls back to
             * polling, only one window later than it used to.
             */
            promptAccepted: () => {
                if (finished || receivedDelta) return;
                scheduleFirstDeltaTimer(firstDeltaTimeoutMs);
            },
            /**
             * Stop collecting immediately (client disconnected, or the caller no longer needs the answer). The
             * promise resolves with `aborted: true` so callers skip the polling fallbacks and the final frames.
             */
            abort: () => settle({ content, reasoning, aborted: true })
        };
    }

    // Chat completions endpoint
    app.post('/v1/chat/completions', { schema: { response: { 200: CHAT_COMPLETION_SCHEMA } } }, async (request, reply) => {
        let hijacked = false;
        // Every phase of a completion (prompt, event subscription, poll fallback) shares one budget: the phases used to
        // each start a fresh REQUEST_TIMEOUT_MS, so a streaming request whose event stream timed out spent a second
        // full budget polling and the queue timer (REQUEST_TIMEOUT_MS + 20 s) answered with a message naming a budget
        // that had already been exceeded. A phase now receives what is left, so the queue timer is the backstop the
        // documentation describes instead of the normal path.
        const requestStartedAt = Date.now();
        const remainingBudget = () => Math.max(1, REQUEST_TIMEOUT_MS - (Date.now() - requestStartedAt));
        // Declared here (not inside the try) so the error paths can log the request id even when the body
        // handling itself throws
        let reqId = null;
        try {
            // A client can disappear while its request waits for a slot. The response object reports that as 'close'
            // (the request stream is destroyed as soon as its body has been read, so it cannot be used as a signal).
            let clientDisconnected = false;
            reply.raw.once('close', () => {
                clientDisconnected = true;
            });

            await lock(async (release) => {
                // Nothing to answer and no reason to run the completion: it would spend backend time (and tokens) for
                // nobody while delaying the requests still waiting behind this one.
                if (clientDisconnected) {
                    if (logger.isEnabled('debug')) {
                        logDebug('Abandoned while queued, skipping completion', { url: loggableUrl(request.url) });
                    }
                    if (!reply.raw.writableEnded) reply.raw.end();
                    return reply;
                }

                let sessionId = null;
                // Assigned once the session exists; the error path uses it to clean up
                let cleanupSession = null;
                // Assigned by the streaming path; the error path uses it to drop the backend event subscription
                // instead of leaving it open until its own deadline (up to the whole request budget)
                let abortStream = null;
                // Disarms the SSE keep-alive timer. Declared out here because the catch below has to call it: the normal
                // end of the streaming block clears the timer, but every throw above jumps straight to that catch, so the
                // timer survived for up to one 5 s tick after the stream was already answered. A no-op until the
                // streaming branch arms it.
                let stopKeepAlive = () => {};

                try {
                    reqId = request.gatewayLog?.reqId || null;
                    // Header masking allocates a fresh object; only build it when debug logging is actually on
                    if (logger.isEnabled('debug')) {
                        // `debugBounded`: every value below is masked and bounded already (`maskHeaders()`, `maskDetail()`,
                        // `loggableUrl()`), so the logger must not walk the tree a second time - that walk cost 36 ms of a
                        // 91 ms line for a body with about a million nodes
                        logger.debugBounded('Incoming OpenAI request', {
                            reqId,
                            method: request.method,
                            path: loggableUrl(request.url),
                            headers: maskHeaders(request.headers),
                            // The body is as client-chosen as the headers: a wrapper that forwards
                            // `{"api_key": …}` or `{"metadata":{"authorization":…}}` wrote a credential into
                            // `docker logs`, and bounding the dump never addressed that
                            body: maskDetail(request.body)
                        });
                    }
                    // A body like `null` or `"text"` is valid JSON but not a completion request: answer 400 instead of
                    // letting a destructuring TypeError turn into a 500. Whether a string body is JSON the handler must
                    // still parse, or JSON that already decoded to a string, depends on the **content type** and not on
                    // the value: `"hi"` under `application/json` is valid JSON that decoded to a string, and reading it
                    // as unparsed text answered "request body is not valid JSON" about a body that parses perfectly.
                    const contentType = String(request.headers['content-type'] || '').toLowerCase();
                    const handedOverAsText = typeof request.body === 'string' && !contentType.startsWith('application/json');
                    // One answer for every value that is not a plain object, so the message names what arrived
                    // (`42` and `null` used to be answered "messages array is required" about a field never sent, and a
                    // parsed scalar on a text path was thrown away and replaced by `{}`)
                    const refuseNonObjectBody = (value) => reply.code(400).send({
                        error: {
                            message: `request body must be a JSON object, found ${jsonTypeName(value)}`,
                            type: 'invalid_request_error'
                        }
                    });
                    let body = {};
                    if (handedOverAsText) {
                        // A body handed over as text can start with a UTF-8 BOM: PowerShell 5.1, `Out-File` and most
                        // Windows editors write one, and `JSON.parse` refuses the first character, so a client whose
                        // body was perfectly good JSON was told "request body is not valid JSON" - the path that
                        // exists for hand-written clients (`curl -d`, `text/plain`) was the one that failed.
                        // `config.json` tolerates the same prefix for the same reason.
                        const text = request.body.charCodeAt(0) === 0xfeff ? request.body.slice(1) : request.body;
                        // A body handed over as text can be empty too, and `JSON.parse('')` answered it with a syntax
                        // error about nothing at all.
                        if (text.trim() === '') {
                            return reply.code(400).send({
                                error: { message: EMPTY_BODY_MESSAGE, type: 'invalid_request_error' }
                            });
                        }
                        try {
                            // Fastify refuses a body carrying `__proto__` or `constructor` before any handler runs
                            // (`onProtoPoisoning: 'error'` is its default), and AGENTS.md documents that refusal as
                            // unconditional. A body handed over as text is parsed *here*, with plain `JSON.parse`, which
                            // has no such guard: the same bytes were served under `text/plain` and refused with `400
                            // FST_ERR_CTP_INVALID_JSON_BODY` under `application/json` (measured), so a client could pick
                            // the content type to skip the check. Nothing in this gateway spreads a parsed body today,
                            // which is exactly why the guard must not depend on that: one future copy would turn it into
                            // prototype pollution. The reviver sees every key at every level, including one escaped as
                            // `"\u005f_proto__"` that a scan of the raw text would miss, so both content types answer
                            // the same refusal.
                            let forbiddenKey = null;
                            const parsed = JSON.parse(text, (key, value) => {
                                if (forbiddenKey === null && FORBIDDEN_BODY_KEYS.has(key)) forbiddenKey = key;
                                return value;
                            });
                            if (forbiddenKey !== null) {
                                return reply.code(400).send({
                                    error: {
                                        message: FORBIDDEN_BODY_MESSAGE,
                                        type: 'invalid_request_error',
                                        code: 'FST_ERR_CTP_INVALID_JSON_BODY'
                                    }
                                });
                            }
                            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                                return refuseNonObjectBody(parsed);
                            }
                            body = parsed;
                        } catch (e) {
                            return reply.code(400).send({
                                error: {
                                    message: 'request body is not valid JSON; send Content-Type: application/json',
                                    type: 'invalid_request_error'
                                }
                            });
                        }
                    } else if (request.body === undefined || request.body === null) {
                        // A body of literal `null` decodes to a value indistinguishable from "no body", and this is the
                        // one non-object the branches around it cannot see: the client was answered "messages array is
                        // required" about a field it never omitted, the mistake `42`, `true` and `[]` were fixed for.
                        // The header decides, because only it knows whether anything was sent; a chunked body cannot
                        // tell an empty stream from `null`, so that shape keeps the missing-field answer.
                        const announced = Number(request.headers['content-length']);
                        if (Number.isFinite(announced) && announced > 0) return refuseNonObjectBody(null);
                    } else {
                        // An array is an object to `typeof`, and it used to reach the `messages` checks: a client that
                        // sent the wrong shape was told about a field it never mentioned
                        if (typeof request.body !== 'object' || Array.isArray(request.body)) {
                            return refuseNonObjectBody(request.body);
                        }
                        body = request.body;
                    }
                    const { messages, model, stream } = body;
                    // Three different client mistakes used to share one message: a body with no `messages`, a body
                    // whose `messages` is not an array, and an empty array all answered "messages array is required",
                    // which sends the reader looking for a field they did send.
                    if (messages === undefined || messages === null) {
                        return reply.code(400).send({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
                    }
                    if (!Array.isArray(messages)) {
                        return reply.code(400).send({
                            error: {
                                message: `messages must be an array of message objects, found ${jsonTypeName(messages)}`,
                                type: 'invalid_request_error'
                            }
                        });
                    }
                    if (messages.length === 0) {
                        return reply.code(400).send({ error: { message: 'messages must contain at least one message', type: 'invalid_request_error' } });
                    }
                    if (typeof model !== 'undefined' && typeof model !== 'string') {
                        return reply.code(400).send({ error: { message: 'model must be a string', type: 'invalid_request_error' } });
                    }

                    // `stream` arrives as a boolean from real SDKs, but hand-written clients (and template engines that
                    // stringify booleans) also send "true"/"1"/"yes". A value that is *present* and unreadable used to
                    // keep the historical non-streaming default: a typo answered `200 application/json` to a client
                    // parsing SSE, which is the failure the string spellings exist to prevent, and the same class the
                    // other body fields are refused for. It is refused by name now; absent, blank or `null` still means
                    // "not streaming" - a **blank string** included, which is what `parseBoolean()` reports as
                    // unreadable: `stream: ""` is the shape a form field or an unset template variable produces, and it
                    // answered `400` here while the sentence above promised blank was accepted.
                    const readableFlag = (value) =>
                        value === undefined || value === null || value === '' || parseBoolean(value, undefined) !== undefined;
                    if (!readableFlag(stream)) {
                        return reply.code(400).send({
                            error: {
                                message: `stream must be a boolean (or one of true/false, yes/no, on/off, 1/0), found ${jsonTypeName(stream)}`,
                                type: 'invalid_request_error'
                            }
                        });
                    }
                    // `stream_options: {include_usage: true}` asks for a final chunk that carries the token usage;
                    // without this the request is honoured only in the sense that nothing rejects it, and a client that
                    // waits for its usage chunk (the OpenAI SDK does) gets no numbers at all. A typo in the switch
                    // dropped that chunk in silence, so it follows the rule above.
                    const streamOptions = body.stream_options;
                    if (streamOptions !== undefined && streamOptions !== null &&
                        (typeof streamOptions !== 'object' || Array.isArray(streamOptions))) {
                        return reply.code(400).send({
                            error: {
                                message: `stream_options must be an object, found ${jsonTypeName(streamOptions)}`,
                                type: 'invalid_request_error'
                            }
                        });
                    }
                    if (!readableFlag(streamOptions?.include_usage)) {
                        return reply.code(400).send({
                            error: {
                                message: `stream_options.include_usage must be a boolean ` +
                                    `(or one of true/false, yes/no, on/off, 1/0), found ${jsonTypeName(streamOptions?.include_usage)}`,
                                type: 'invalid_request_error'
                            }
                        });
                    }
                    const wantsStream = parseBoolean(stream, false) === true;
                    const includeUsage = wantsStream && parseBoolean(streamOptions?.include_usage, false) === true;

                    // Split on the first slash only: a model id may itself contain slashes
                    // (`vendor/family/version`), and `split('/')` used to drop everything after the second one
                    const modelId = (model || '').trim() || DEFAULT_MODEL_ID;
                    const modelSlash = modelId.indexOf('/');
                    const pID = modelSlash === -1 ? 'opencode' : modelId.slice(0, modelSlash);
                    const mID = modelSlash === -1 ? modelId : modelId.slice(modelSlash + 1);
                    // Same rule the model routes apply: an id whose provider or model half is empty (`opencode/`,
                    // `/big-pickle`) is not a model id. Sending it to the backend only produced an opaque upstream
                    // error a client could not act on - and it names the value it refused.
                    if (!pID || !mID) {
                        return reply.code(400).send({
                            error: {
                                message: `model "${echoedValue(modelId)}" must be a "provider/model" id`,
                                type: 'invalid_request_error'
                            }
                        });
                    }
                    if (request.gatewayLog) {
                        // Logged copy only (see loggableModelId): the request log line is one record per request
                        request.gatewayLog.model = loggableModelId(`${pID}/${mID}`);
                        request.gatewayLog.stream = wantsStream;
                    }

                    // A content part the gateway cannot forward (an image, an audio clip, a file) is named and refused
                    // instead of dropped: keeping only the text turned a multimodal request into a confident answer to
                    // half of it, and the client had no way to know the model never saw the image. `text` parts of the
                    // Responses API (`{type:"input_text", text}`) carry the same field, so they keep working.
                    const normalizeMessageContent = (content) => {
                        if (typeof content === 'string') return { text: content };
                        if (Array.isArray(content)) {
                            let text = '';
                            for (let i = 0; i < content.length; i += 1) {
                                const part = content[i];
                                if (typeof part === 'string') {
                                    text += part;
                                    continue;
                                }
                                if (part && typeof part.text === 'string') {
                                    text += part.text;
                                    continue;
                                }
                                // A part that carries neither a string nor a text field is data the gateway would have
                                // to drop: name it, with the position the client sent it at. A part that *is* text
                                // (`type: "text"`, or any object with the field) but whose `text` is not a string is
                                // named by that field instead: reporting `uses an unsupported content part type "text"`
                                // blames the one part type the gateway does forward.
                                if (part && typeof part === 'object') {
                                    if ('text' in part && typeof part.text !== 'string') {
                                        return { text, unsupported: { index: i, field: 'text', found: jsonTypeName(part.text) } };
                                    }
                                    // A text part whose `text` field is *missing* (`{"type":"text"}`) is the same
                                    // mistake one step earlier, and it used to be answered with that same "unsupported
                                    // type text" sentence: name the missing field.
                                    if (part.type === 'text' || part.type === 'input_text') {
                                        return { text, unsupported: { index: i, field: 'text', required: true } };
                                    }
                                    // A part with no usable `type` at all (`{}`, `{"foo":1}`, `{"type":5}`,
                                    // `{"type":""}`) was answered `uses an unsupported content part type "unknown"`,
                                    // quoting a value the client never sent in the slot that means "the type you sent".
                                    // It is an object with no text to forward, which is what the scalar-part sentence
                                    // already describes.
                                    const partType = typeof part.type === 'string' ? part.type : '';
                                    if (!partType) {
                                        return { text, unsupported: { index: i, found: 'an object without a text field' } };
                                    }
                                    return { text, unsupported: { index: i, type: partType } };
                                }
                                // null/number/boolean parts carry no content either, and dropping them in silence ended
                                // the request at "messages must include at least one non-system text message" - about
                                // text nobody wrote, for a part the client did send
                                return { text, unsupported: { index: i, found: jsonTypeName(part) } };
                            }
                            return { text };
                        }
                        if (content && typeof content.text === 'string') return { text: content.text };
                        // A single part sent as an object instead of a one-element array (`{"content":{"type":
                        // "image_url",…}}`, or `{"type":"text","text":5}`): the same three refusals as a part inside an
                        // array, reported without a part index because the client sent no array to index into. Dropping
                        // it answered a question the backend never received - and for a `system` message it dropped the
                        // instructions instead, which is the same silent wrongness with a worse consequence.
                        if (content && typeof content === 'object') {
                            if ('text' in content && typeof content.text !== 'string') {
                                return { text: '', unsupported: { field: 'text', found: jsonTypeName(content.text) } };
                            }
                            // The same two shapes as a part inside an array: a text part missing its field, and an
                            // object with no usable `type` (which is not a part type the client named)
                            if (content.type === 'text' || content.type === 'input_text') {
                                return { text: '', unsupported: { field: 'text', required: true } };
                            }
                            const contentPartType = typeof content.type === 'string' ? content.type : '';
                            if (!contentPartType) return { text: '', unsupported: { found: 'an object without a text field' } };
                            return { text: '', unsupported: { type: contentPartType } };
                        }
                        if (content === null || content === undefined) return { text: '' };
                        // A scalar `content` (`42`, `true`) is not text the client wrote: stringifying it sent the model
                        // the number as the question, so a template that lost a field asked something nobody asked and
                        // was answered. OpenAI refuses the type too, and this is the same refusal every other
                        // non-text content gets - named by the value that arrived, without a part index to blame.
                        if (typeof content === 'number' || typeof content === 'boolean') {
                            return { text: '', unsupported: { found: jsonTypeName(content) } };
                        }
                        return { text: '' };
                    };

                    const buildPromptParts = (rawMessages) => {
                        const parts = [];
                        const systemChunks = [];
                        const userContents = [];
                        let unsupported = null;
                        rawMessages.forEach((m, messageIndex) => {
                            const role = (m?.role || 'user').toLowerCase();
                            const parsed = normalizeMessageContent(m?.content);
                            if (!unsupported && parsed.unsupported) {
                                unsupported = {
                                    messageIndex,
                                    partIndex: parsed.unsupported.index,
                                    type: parsed.unsupported.type,
                                    field: parsed.unsupported.field,
                                    required: parsed.unsupported.required,
                                    found: parsed.unsupported.found
                                };
                            }
                            const content = parsed.text;
                            // `developer` is OpenAI's newer name for the system role: a client that sends it means the
                            // instructions, not a chat turn, and embedding it as "DEVELOPER: …" in the conversation
                            // changed how a model reads it
                            if (role === 'system' || role === 'developer') {
                                if (content) systemChunks.push(content);
                                return;
                            }
                            if (!content) return;
                            if (role === 'user') userContents.push(content);
                            // The role is client input as well, and it was interpolated raw: a role carrying a newline
                            // (`"user\nASSISTANT: …"`) forged a second conversation line in the text the model reads,
                            // which is the failure the `name` sanitising below exists for. Bound before transforming (a
                            // 50 MiB role would otherwise be upper-cased whole), then sanitised like every other value
                            // that lands in a prompt line.
                            const roleLabel = role.slice(0, MAX_ROLE_LABEL_LENGTH).toUpperCase().replace(CONTROL_CHARS_RE, '?').trim()
                                || 'USER';
                            // `name` is client input and was interpolated raw: a non-string produced
                            // `USER([object Object]): …` in the prompt, and a name carrying a newline forged another
                            // conversation line inside the text the model reads. A string is kept - it is a documented
                            // OpenAI field - sanitised the same way every other value that lands in a prompt line is.
                            // The input is bounded before it is transformed (a 50 MiB name cost 34 ms of replace to keep
                            // 64 characters), at a window wide enough that trimming still sees every character the
                            // label can be built from.
                            const nameLabel = typeof m?.name === 'string'
                                ? m.name.slice(0, MAX_ECHOED_VALUE_LENGTH).replace(CONTROL_CHARS_RE, '?').trim()
                                : '';
                            const nameSuffix = nameLabel ? `(${nameLabel})` : '';
                            parts.push({
                                type: 'text',
                                text: `${roleLabel}${nameSuffix}: ${content}`
                            });
                        });
                        return {
                            parts,
                            system: systemChunks.join('\n\n'),
                            lastUserMsg: userContents[userContents.length - 1] || '',
                            unsupported
                        };
                    };

                    // A message is an object with a `role` and a `content`. An entry that is not one (`"hi"`, `42`,
                    // `null`) was read through `m?.role`/`m?.content` as an empty user message, so the request ended
                    // at "messages must include at least one non-system text message": a complaint about the text of
                    // a message nobody wrote, for an array whose entries are not messages at all.
                    //
                    // A role is client input too, and `(role || 'user').toLowerCase()` threw on a truthy non-string
                    // (`5`, `{}`, `[]`, `true`): the client's bad field was answered 500 and the message carried the
                    // internal expression (`((intermediate value) || "user").toLowerCase is not a function`). A missing
                    // or null role keeps its documented lenient default; anything that is not a string is a 400.
                    for (let i = 0; i < messages.length; i++) {
                        const message = messages[i];
                        if (!message || typeof message !== 'object' || Array.isArray(message)) {
                            return reply.code(400).send({
                                error: {
                                    message: `messages[${i}] must be a message object, found ${jsonTypeName(message)}`,
                                    type: 'invalid_request_error'
                                }
                            });
                        }
                        const role = message.role;
                        if (role !== undefined && role !== null && typeof role !== 'string') {
                            return reply.code(400).send({
                                error: {
                                    message: `messages[${i}].role must be a string`,
                                    type: 'invalid_request_error'
                                }
                            });
                        }
                    }

                    const { parts, system: systemMsg, lastUserMsg, unsupported } = buildPromptParts(messages);
                    // Named before the "no text at all" check: a request whose only part is an image must say that the
                    // gateway cannot carry images, not that the client forgot to write any text
                    if (unsupported) {
                        // No index when the content itself was the part (a single object instead of an array)
                        const at = unsupported.partIndex === undefined || unsupported.partIndex === null
                            ? `messages[${unsupported.messageIndex}].content`
                            : `messages[${unsupported.messageIndex}].content[${unsupported.partIndex}]`;
                        // Three causes, three messages: a part of a type the gateway cannot forward (an image), a text
                        // part whose `text` is not a string, and a part that is not a part at all (`42`, `null`). One
                        // message for all three used to call a `text` part unsupported - naming the only part type the
                        // gateway does forward - and dropped a scalar part in silence, so the request ended at
                        // "messages must include at least one non-system text message" instead.
                        const message = unsupported.field
                            ? unsupported.required
                                ? `${at}.${unsupported.field} is required for a text part`
                                : `${at}.${unsupported.field} must be a string, found ${unsupported.found}`
                            : unsupported.found
                                ? `${at} must be a string or an object with a text field, found ${unsupported.found}`
                                : `${at} uses an unsupported content part type "${echoedValue(unsupported.type)}"; this gateway forwards text only`;
                        return reply.code(400).send({
                            error: { message, type: 'invalid_request_error' }
                        });
                    }
                    const systemWithGuard = applyToolGuard(systemMsg);
                    // The 2.x permission ruleset that enforces DISABLE_TOOLS, or undefined when tools are enabled. It is
                    // handed to `session.create()`: the server refuses a denied action itself, rather than the answer
                    // depending on a sentence in the prompt being obeyed.
                    const permissionRules = toolPermissionRules();
                    if (!parts.length) {
                        return reply.code(400).send({ error: { message: 'messages must include at least one non-system text message', type: 'invalid_request_error' } });
                    }
                    // Guarded: the literal is the only allocation on this path that cannot be avoided otherwise, and
                    // this runs for every completion
                    if (logger.isEnabled('debug')) {
                        logger.debug('Request start', {
                            model: `${pID}/${mID}`,
                            stream: wantsStream,
                            userMessages: messages.length,
                            system: Boolean(systemMsg),
                            lastUserLength: lastUserMsg.length,
                            parts: parts.length,
                            disableTools: DISABLE_TOOLS
                        });
                    }

                    // Ensure backend is running
                    await ensureBackend(config);
                    // The backend was trusted before shutdown began, so `ensureBackend()` returned without reaching its
                    // own check: a session created now would land in `liveSessions` after the drain read it, and nobody
                    // would delete it (an external backend keeps it for good). The request is answered `503
                    // gateway_shutting_down`, the same answer the shutdown refusal gives everywhere else.
                    if (backendState.get(OPENCODE_SERVER_URL)?.shuttingDown) {
                        throw Object.assign(new Error('The gateway is shutting down'), { gatewayShuttingDown: true });
                    }

                    // Create session
                    let sessionRes;
                    /**
                     * The upstream failure a refused `client.session.create` becomes.
                     *
                     * A 2.x call throws, so this is reached from the catch below as often as from the resolved branch: a
                     * backend that rejects the POST (a 1.x server, which has no `/api/*` route at all, a proxy in front of
                     * it, an error body) must be reported as the upstream failure it is - `502` with the status and
                     * reason - instead of the `500 server_error` that says "this gateway has a bug".
                     * @param {unknown} failure the thrown error or the resolved value
                     */
                    const sessionCreationRejected = (failure) => {
                        const { status: upstreamStatus, reason } = upstreamFailureReason(failure);
                        if (upstreamStatus === 404 || upstreamStatus === 405) {
                            // The one cause worth naming: a 1.x `opencode serve` has no `/api/*` routes at all, so its
                            // answers here are 404/405 while the gateway's readiness probe (which asks an /api route
                            // and requires JSON) never passed for one in the first place. A proxy that strips the
                            // prefix lands here too. A 502 alone does not say that.
                            logger.warn(
                                `[Proxy] The backend does not expose the OpenCode 2.x session API (status ${upstreamStatus}). ` +
                                'The installed `opencode` CLI is probably a 1.x release: install a 2.x version, which is what ' +
                                '@opencode/client drives.'
                            );
                        }
                        return new ProviderError(
                            `OpenCode backend rejected session creation${upstreamStatus ? ` (status ${upstreamStatus})` : ''}${reason}`,
                            upstreamStatus,
                            failure instanceof Error ? failure : undefined
                        );
                    };
                    // The 2.x server takes the model on the session, not on the prompt: `session.create({model})`.
                    // `{providerID, id}` is the 2.x `Model.Ref` shape (a 1.x `modelID` field is not read).
                    // Built **once** because it is sent twice: the retry below is the same call, and a duplicated
                    // literal is what dropped the ruleset from it. Both call sites read the same object, so
                    // `DISABLE_TOOLS` cannot be enforced on the first attempt and skipped by the second.
                    const sessionCreateArgs = {
                        title: `chat ${new Date().toISOString()}`,
                        model: { providerID: pID, id: mID },
                        ...(permissionRules ? { permissions: permissionRules } : {})
                    };
                    try {
                        // What is left of the request budget, not a fresh one: with a full budget here a
                        // completion that had waited in the queue was granted a second create deadline and could
                        // answer past the timeout it had already advertised (measured: 3.66 s for a 2 s budget,
                        // 1.67 s of it spent queued).
                        sessionRes = await client.session.create(sessionCreateArgs, backendDeadline(remainingBudget()));
                    } catch (createError) {
                        // A backend that died between the cached "healthy" answer and this call fails here with a
                        // connection error. ensureBackend() trusted a probe from up to OPENCODE_PROXY_HEALTH_CACHE_MS
                        // ago, so this request answered "fetch failed" while a restart was a single probe away - the
                        // client had to retry to get the recovery the gateway could do itself. Drop the cached trust,
                        // start the backend again and retry the call once; a deadline or a backend that is really gone
                        // is not retried (a timeout keeps its own 504, and the retry would spend the budget twice).
                        //
                        // Only a *refused* connection is retried: that one proves the request never reached the
                        // backend. `fetch failed` and `socket hang up` are what a backend that accepted the POST and
                        // then died looks like, and retrying those created a second session while the first one kept
                        // existing with no id in this process - nothing could delete it (an external backend keeps it,
                        // and its message history, for good). Those requests answer `502 backend_unreachable`, which is
                        // the documented answer for "the backend disappeared mid-request"; the next request recovers.
                        if (!isConnectionRefused(createError)) {
                            // A status on the rejection means the backend *answered* with a failure (a 400/401/404 the
                            // client typed, or a `ClientError("UnexpectedStatus: 405")` for one it did not). A transport
                            // failure - the backend died, the deadline expired - keeps its own wording.
                            if (!isTimeoutError(createError) && typeof upstreamErrorStatus(createError) === 'number') {
                                throw sessionCreationRejected(createError);
                            }
                            throw createError;
                        }
                        logDebug('Session creation failed on a refused connection, restarting the backend', {
                            error: clientFacingText(createError.message)
                        });
                        const backend = backendState.get(OPENCODE_SERVER_URL);
                        if (backend) backend.healthyAt = 0;
                        try {
                            await ensureBackend(config);
                        } catch (startError) {
                            // No restart happened (cooldown, missing binary): report the upstream failure this
                            // request actually hit, not the start error an internal retry produced
                            throw createError;
                        }
                        // The same call as above, `sessionCreateArgs` included: this retry is what a *refused* connection
                        // takes, which is the ordinary "the backend just restarted" case. It used to repeat the object
                        // literal without `permissions`, so that completion ran on a session with the server's default
                        // permissions - `shell`, `edit`, `write` and `patch` allowed again - while the prompt still carried
                        // TOOL_GUARD_MESSAGE, and DISABLE_TOOLS was enforced only by a sentence asking the model not to
                        // use tools. The client could not tell: the answer looked normal either way.
                        sessionRes = await client.session.create(sessionCreateArgs, backendDeadline(remainingBudget()));
                    }
                    // A 2.x server answers 200 with `{"data":{…}}`; the id is read from the envelope. A 1.x server
                    // answered it at the top level, so reading only one shape is what makes this fail loudly instead of
                    // creating a session whose id nobody can see.
                    sessionId = sessionRes?.data?.id ?? sessionRes?.id;
                    if (!sessionId) {
                        // A backend that answers the readiness probe but rejects POST /api/session (a 1.x server, which
                        // has no /api prefix at all, a proxy in front of it, an error body) used to surface as a bare
                        // 500 "Failed to create OpenCode session": no status, no reason, and it blamed the gateway for
                        // an upstream failure. `sessionCreationRejected()` builds that sentence for the resolved form
                        // too, so a translating proxy cannot reintroduce the 500.
                        throw sessionCreationRejected(sessionRes);
                    }
                    trackLiveSession(sessionId);
                    logDebug('Session created', { sessionId });

                    // A session is created per completion, so it must also be deleted per completion: otherwise the
                    // backend accumulates one session (with its full message history) for every request served.
                    let sessionCleaned = false;
                    cleanupSession = async () => {
                        if (!sessionId || sessionCleaned) return;
                        sessionCleaned = true;
                        // A failure that may pass - a busy or restarting backend, a delete that ran into its deadline -
                        // leaves the id in `liveSessions` so the bounded shutdown drain tries once more. Counting it as
                        // done dropped the id here, and the session outlived the gateway with nothing left to retry it.
                        let transient = false;
                        try {
                            // The 2.x delete answers `204` with no body, and a delete for a session that is already gone
                            // *throws* `SessionNotFoundError` rather than resolving with a tuple - so the status is read
                            // from the rejection below, not only from a resolved value.
                            const deleteResult = await client.session.remove({ sessionID: sessionId }, backendDeadline(SESSION_CLEANUP_TIMEOUT_MS));
                            // A resolved value that still carries an error is a failure too: a rejected delete used to be
                            // logged as "Session deleted" while the session stayed on the backend.
                            if (deleteResult && deleteResult.error) {
                                const { status, reason } = upstreamFailureReason(deleteResult);
                                if (status === 404 || status === 410) {
                                    // Already gone: the cleanup's purpose is met, and a retry can only answer the same
                                    logDebug('Session was already gone', { sessionId, status });
                                } else {
                                    transient = true;
                                    noteCleanupFailure(sessionId, `delete rejected${reason}`);
                                }
                            } else {
                                logDebug('Session deleted', { sessionId });
                            }
                        } catch (e) {
                            // The 2.x server answers a second delete with 404 and the client raises
                            // `SessionNotFoundError` for it: the session is gone, which is what this cleanup was for.
                            const { status } = upstreamFailureReason(e);
                            if (status === 404 || status === 410) {
                                logDebug('Session was already gone', { sessionId, status });
                            } else {
                                // Thrown or timed out (`SESSION_CLEANUP_TIMEOUT_MS`): the session is still on the
                                // backend, and this is the only signal that a backend is accumulating them
                                transient = true;
                                noteCleanupFailure(sessionId, clientFacingText(e.message));
                            }
                        } finally {
                            // Bookkeeping for the shutdown drain, not the cleanup itself: an already-gone session and a
                            // session that was deleted both leave the set; a transient failure stays for the drain.
                            if (!transient) liveSessions.delete(sessionId);
                        }
                    };

                    // The 2.x prompt takes one `text` string: the conversation parts are already flat text (`USER: …`),
                    // so joining them is the whole payload. A 1.x `parts` array and its `model`/`system` fields do not
                    // exist on this route; the model is chosen when the session is created (`session.create({model})`)
                    // and the system prompt travels inside the text, which is where the tool guard goes.
                    const promptParams = {
                        sessionID: sessionId,
                        text: systemWithGuard
                            ? `${systemWithGuard}\n\n${parts.map((part) => part.text).join('\n\n')}`
                            : parts.map((part) => part.text).join('\n\n')
                    };
                    if (logger.isEnabled('debug')) {
                        // Masked like the earlier dump of the same body: the prompt text is client text, and a prompt
                        // that quotes a credential-bearing URL (a wrapper forwarding its own config) was written
                        // to `docker logs` verbatim here while the `Incoming OpenAI request` record masked it.
                        // `debugBounded()` because `maskDetail()`'s copy is bounded and acyclic by construction.
                        logger.debugBounded('Upstream payload (final request body to opencode serve)', {
                            reqId,
                            sessionId,
                            model: `${pID}/${mID}`,
                            payload: maskDetail(promptParams)
                        });
                    }

                    if (wantsStream) {
                        // Take over the raw socket: Fastify must not send its own reply for SSE
                        reply.hijack();
                        hijacked = true;
                        const raw = reply.raw;
                        raw.setHeader('Content-Type', 'text/event-stream');
                        raw.setHeader('Cache-Control', 'no-cache');
                        raw.setHeader('X-Accel-Buffering', 'no');
                        const id = newCompletionId();
                        const filterContentDelta = createToolCallFilter();
                        const filterReasoningDelta = createToolCallFilter();
                        let streamedContent = '';
                        let streamedReasoning = '';
                        let sseChunkCount = 0;

                        // The envelope fields are identical for every chunk of this stream, so they are serialized
                        // once up front; per delta only the escaped text is stringified and appended.
                        const createdAt = Math.floor(Date.now() / 1000);
                        const chunkHead = `data: {"id":"${id}","object":"chat.completion.chunk","created":${createdAt},"model":${JSON.stringify(`${pID}/${mID}`)},"choices":[{"index":0,"delta":{"`;
                        // OpenAI opens every stream with the assistant role in the delta, and clients that drive a chat
                        // state machine (they create the message on `delta.role`) had to infer it themselves; the role
                        // rides along with the first real frame instead of adding an empty one.
                        // `chunkHead` ends with the opening quote of the field name, so the role goes before it and the
                        // trailing quote opens the field that follows
                        const chunkHeadWithRole = `${chunkHead.slice(0, -1)}"role":"assistant","`;
                        let roleSent = false;
                        const frameHead = () => {
                            if (roleSent) return chunkHead;
                            roleSent = true;
                            return chunkHeadWithRole;
                        };
                        // Closes the delta object and the chunk envelope: `"<field>":<value>},"finish_reason":null}]}`
                        const chunkTail = '},"finish_reason":null}]}\n\n';
                        // The terminal frame carries the same envelope as every delta: clients that validate each chunk
                        // (`object`, `created`, `model`) treated a bare {id, choices} frame as a different object type.
                        const stopFrame = `data: {"id":"${id}","object":"chat.completion.chunk","created":${createdAt},"model":${JSON.stringify(`${pID}/${mID}`)},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;
                        // OpenAI sends the usage of a stream in a chunk of its own: empty `choices`, after the
                        // finish chunk and before [DONE]. The counts are zero because the backend does not report
                        // token counts, which is the same answer the non-streaming path gives.
                        const usageFrame = `data: {"id":"${id}","object":"chat.completion.chunk","created":${createdAt},"model":${JSON.stringify(`${pID}/${mID}`)},"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n`;

                        // A client that disappears mid-stream must not hold the completion queue until the backend
                        // timeout: note the disconnect and abort the collector so the slot is released immediately.
                        let clientGone = false;
                        let collectorHandle = null;
                        let keepAliveTimer = null;
                        const stopStreamKeepAlive = () => {
                            if (keepAliveTimer) {
                                clearInterval(keepAliveTimer);
                                keepAliveTimer = null;
                            }
                        };
                        stopKeepAlive = stopStreamKeepAlive;
                        const noteClientGone = () => {
                            stopStreamKeepAlive();
                            // No `writableEnded` short-circuit: when someone else already ended the response (the
                            // request timeout answered in-band) the socket is still open, and leaving the flag false
                            // let the task write into an ended stream, where the drain never comes and the slot was
                            // lost for the rest of the process lifetime.
                            clientGone = true;
                            if (collectorHandle) collectorHandle.abort();
                        };
                        raw.on('close', noteClientGone);
                        raw.on('error', noteClientGone);

                        // A free model can think for a long time between deltas (the polling fallback waits on the
                        // backend too), and proxies/browsers drop a connection that stays silent. SSE comment lines
                        // are ignored by every OpenAI client, so they keep the socket warm without touching the payload.
                        let lastWriteAt = Date.now();
                        keepAliveTimer = setInterval(() => {
                            if (clientGone || raw.writableEnded) {
                                stopKeepAlive();
                                return;
                            }
                            if (Date.now() - lastWriteAt < SSE_KEEPALIVE_INTERVAL_MS) return;
                            lastWriteAt = Date.now();
                            raw.write(': keep-alive\n\n');
                        }, SSE_KEEPALIVE_TICK_MS);
                        keepAliveTimer.unref();

                        // Respect write backpressure so a slow reader cannot force the whole answer into memory.
                        // The wait is bounded: a client that stops reading without closing the connection (a tab
                        // that stops consuming, a buffering proxy, a stalled phone link) never drains, and an
                        // unbounded await left the task - and with it the only completion slot - parked forever
                        // while /health still answered 200. A reader that makes no progress for the whole window is
                        // treated as gone and its socket destroyed.
                        const writeFrame = async (frame) => {
                            if (clientGone || raw.writableEnded || raw.destroyed) return;
                            lastWriteAt = Date.now();
                            if (raw.write(frame)) return;
                            await new Promise((resolve) => {
                                let timer = null;
                                const settleDrain = () => {
                                    if (timer) clearTimeout(timer);
                                    raw.off('drain', settleDrain);
                                    raw.off('close', settleDrain);
                                    raw.off('error', settleDrain);
                                    resolve();
                                };
                                timer = setTimeout(() => {
                                    logger.warn('[Proxy] Streaming client stopped reading, dropping the response', {
                                        sessionId,
                                        ms: SSE_CLIENT_WRITE_TIMEOUT_MS
                                    });
                                    noteClientGone();
                                    settleDrain();
                                    if (!raw.destroyed) raw.destroy();
                                }, SSE_CLIENT_WRITE_TIMEOUT_MS);
                                timer.unref();
                                raw.once('drain', settleDrain);
                                raw.once('close', settleDrain);
                                raw.once('error', settleDrain);
                            });
                        };

                        const sendDelta = async (delta, isReasoning = false) => {
                            if (!delta || clientGone) return;
                            const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                            if (!filtered) return;
                            if (isReasoning) {
                                streamedReasoning += filtered;
                            } else {
                                streamedContent += filtered;
                            }
                            await writeFrame(`${frameHead()}${isReasoning ? 'reasoning_content' : 'content'}":${JSON.stringify(filtered)}${chunkTail}`);
                            sseChunkCount++;
                        };

                        // Writes a delta the tool-call filter has already released (the held tail at end of stream).
                        // Sending it through sendDelta() would hold the same tag prefix back again - and this time
                        // nothing follows, so the fragment would be lost and the answer truncated.
                        const sendReleasedDelta = async (delta, isReasoning = false) => {
                            if (!delta || clientGone) return;
                            if (isReasoning) {
                                streamedReasoning += delta;
                            } else {
                                streamedContent += delta;
                            }
                            await writeFrame(`${frameHead()}${isReasoning ? 'reasoning_content' : 'content'}":${JSON.stringify(delta)}${chunkTail}`);
                            sseChunkCount++;
                        };

                        const collectDeferred = collectFromEvents(
                            sessionId,
                            // The collector shares the request budget too: when it runs out, the fallback below has
                            // nothing left to spend and the client is told the completion timed out - instead of the
                            // two phases each buying a full budget
                            remainingBudget(),
                            sendDelta,
                            DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                            DEFAULT_EVENT_IDLE_TIMEOUT_MS
                        );
                        // An error before the subscription is ready still has to end it (once it is): otherwise the
                        // backend keeps a live event stream per failed completion until the collector's own deadline
                        let streamAborted = false;
                        abortStream = () => {
                            streamAborted = true;
                            if (collectorHandle) collectorHandle.abort();
                        };
                        const safeCollect = collectDeferred
                            .then((collector) => {
                                collectorHandle = collector;
                                // The client left, or the request failed before the subscription was ready: stop it
                                // right away instead of leaving it open until its own deadline
                                if (clientGone || streamAborted) collector.abort();
                                return collector.promise;
                            })
                            .catch((err) => ({ __error: err }));
                        const promptStart = Date.now();
                        const promptResult = await promptCall(promptParams, remainingBudget());
                        logDebug('Prompt sent', { sessionId, ms: Date.now() - promptStart });
                        // A prompt the backend rejected is an upstream failure, not a slow answer: waiting for an
                        // assistant message that will never exist held the slot until the whole budget expired.
                        throwIfPromptRejected(promptResult, Boolean(streamedContent || streamedReasoning));
                        // The prompt has returned: the turn is accepted in 2.x, so the first-token window is measured
                        // from here (see `promptAccepted()`) rather than from the subscription.
                        const collector = await collectDeferred.catch(() => null);
                        if (collector) collector.promptAccepted();
                        const collected = await safeCollect;
                        // The provider failed on the event that ended the message: this must end the stream in-band,
                        // with the frames already written or as the 502 envelope when none were. Serving the text it
                        // managed to write under `finish_reason: "stop"` is a successful answer to every client.
                        if (collected && collected.error) {
                            throw new ProviderError(describeProviderFailure(collected.error));
                        }

                        // One place that turns a polled assistant message into deltas. `appendOnly` trims the part that
                        // was already streamed over SSE, so an idle-timeout fallback never repeats itself.
                        // The streamed text exists in two forms: `collected.content`/`collected.reasoning` is the raw
                        // text the collector handed to the streaming tool-call filter, and `streamedContent`/
                        // `streamedReasoning` is what that filter released. A polled answer that extends the raw text is
                        // appended as the *raw* remainder through the filter: the filter's state belongs to this stream
                        // (it was built from exactly that raw text), so it finishes the tag it was holding, or the tag a
                        // boundary fell inside. Handing it the already-stripped reminder of the answer instead re-filtered
                        // tag-free text with the state of the interrupted stream, so a cut inside a `<function_calls>`
                        // block either leaked the raw markup (`held` was a real tag prefix) or swallowed the rest of the
                        // answer (`inBlock` dropped every buffer that did not contain the closing tag) - both reported to
                        // the client with `finish_reason: "stop"`. A rewritten answer (the polled text does not extend
                        // what the collector saw) has no raw stream left to continue, so it is stripped and written
                        // around the filter, whose stale state is discarded first.
                        const emitPolled = async (appendOnly, stallPolls = 3) => {
                            const { content, reasoning, error } = await pollForAssistantResponse(
                                sessionId,
                                remainingBudget(),
                                DEFAULT_POLL_INTERVAL_MS,
                                () => clientGone,
                                { requireDone: true, stablePollsRequired: stallPolls }
                            );
                            if (clientGone) return;
                            if (error && !content && !reasoning) {
                                // The prompt succeeded but the provider reported an error and no text: terminate the
                                // stream with an error frame instead of streaming the message back as model output
                                throw new ProviderError(describeProviderFailure(error));
                            }
                            const emitPolledKind = async (text, kind, isReasoning) => {
                                if (!text) return;
                                const rawSeen = kind === 'reasoning' ? collected?.reasoning : collected?.content;
                                if (appendOnly && rawSeen && text.startsWith(rawSeen)) {
                                    await sendDelta(text.slice(rawSeen.length), isReasoning);
                                    return;
                                }
                                let safe = stripFunctionCalls(text, false) || '';
                                const filteredSeen = isReasoning ? streamedReasoning : streamedContent;
                                if (appendOnly && filteredSeen) {
                                    if (safe.startsWith(filteredSeen)) {
                                        safe = safe.slice(filteredSeen.length);
                                    } else if (filteredSeen.startsWith(safe)) {
                                        // The backend's copy is *behind* what the SSE frames already delivered: a message
                                        // store written behind the broadcast, a part the backend rewrote shorter, a stale
                                        // snapshot read after the restart that ended the stream. Nothing here is new, and
                                        // writing it re-sent the head of the answer the client already has ("abcdef…" 500
                                        // characters, then the first 50 again, with `finish_reason: "stop"`). The opposite
                                        // direction - a polled answer that *extends* what was sent - is the normal case
                                        // above; a genuinely divergent answer (neither is a prefix) keeps the rewrite path
                                        // below.
                                        return;
                                    }
                                }
                                if (!safe) return;
                                // Written around the filter, not through it: this text is already tag-free, and a held
                                // fragment is a partial tag from a stream that is not being continued - discarding it
                                // loses nothing, because the trimmed remainder below already carries whatever that
                                // fragment turned out to be.
                                (isReasoning ? filterReasoningDelta : filterContentDelta).flush();
                                await sendReleasedDelta(safe, isReasoning);
                            };
                            await emitPolledKind(reasoning, 'reasoning', true);
                            await emitPolledKind(content, 'content', false);
                            // A polled message that carries a provider error is a failure even when it also carries
                            // text: the text was emitted above, so the client gets what there was and then the error
                            // frame, instead of a "stop" that reads as a complete answer.
                            if (error) throw new ProviderError(describeProviderFailure(error));
                        };

                        let polled = false;
                        if (collected && collected.__error) {
                            logDebug('SSE collect error, falling back to polling', {
                                sessionId,
                                error: collected.__error?.message
                            });
                            polled = true;
                            // Text may already be on the wire: the poll then only contributes the part the client does
                            // not have, because re-sending the whole answer duplicated it (the idle-timeout fallback
                            // below has always been append-only for that reason).
                            await emitPolled(Boolean(streamedContent || streamedReasoning));
                        } else if (collected && collected.noData) {
                            logDebug('Fallback to polling (stream)', { sessionId });
                            polled = true;
                            await emitPolled(false);
                        } else if (collected && (collected.idleTimeout || collected.streamEnded)) {
                            // Both cases mean the same thing: nothing more is coming from the event stream, and the
                            // answer has to be read from the backend. A stream that ended early is polled with the same
                            // tolerance as one that went silent - the collected text is a prefix of the real answer.
                            logDebug(collected.streamEnded ? 'SSE stream ended early, polling for the answer' : 'SSE idle timeout, polling for completion', { sessionId });
                            polled = true;
                            // The backend just went silent (or away) on us: give it another full idle window before
                            // deciding the message will never be marked finished
                            await emitPolled(true, IDLE_RECOVERY_STALL_POLLS);
                        }

                        /* When opencode>=1.19 SSE deltas are missing, a fast assistant finish resolves early with empty
                           content; fall back to polling once for the full reply before emitting, and emit no delta if
                           polling is also empty. Polling twice is pointless, so an earlier poll disables this. */
                        if (!polled && !clientGone && collected && !streamedContent && !streamedReasoning) {
                            await emitPolled(false);
                        }

                        // A fragment held back at the very end of the stream turned out not to be a tag
                        if (!clientGone && DISABLE_TOOLS) {
                            const tailContent = filterContentDelta.flush();
                            if (tailContent) await sendReleasedDelta(tailContent, false);
                            const tailReasoning = filterReasoningDelta.flush();
                            if (tailReasoning) await sendReleasedDelta(tailReasoning, true);
                        }

                        stopKeepAlive();
                        if (!clientGone) {
                            await writeFrame(stopFrame);
                            sseChunkCount++;
                            if (includeUsage) {
                                await writeFrame(usageFrame);
                                sseChunkCount++;
                            }
                            await writeFrame('data: [DONE]\n\n');
                            raw.end();
                        }
                        // The answer has been sent (or the client left): the slot is free as of now
                        release();
                        // The answer has been sent (or the client left): the session is no longer needed
                        await cleanupSession();
                        if (logger.isEnabled('debug')) {
                            logger.debug('SSE stream summary', {
                                reqId,
                                sessionId,
                                model: `${pID}/${mID}`,
                                chunks: sseChunkCount,
                                contentChars: streamedContent.length,
                                reasoningChars: streamedReasoning.length,
                                finishReason: 'stop',
                                clientGone
                            });
                        }
                    } else {
                        // A client that gives up while a non-streaming completion is still running used to keep its
                        // queue slot for the whole answer: at the default concurrency of 1, a client that closed the
                        // tab (or hit its own SDK timeout) blocked every other request for an answer nobody would read.
                        // The closed response socket is the disconnect signal; the request stream is destroyed as soon
                        // as its body has been read, which is the normal case and not a disconnect.
                        let clientGone = false;
                        reply.raw.on('close', () => {
                            clientGone = true;
                        });
                        const promptStart = Date.now();
                        const promptResult = await promptCall(promptParams, remainingBudget());
                        logDebug('Prompt sent', { sessionId, ms: Date.now() - promptStart });
                        // A prompt the backend rejected is an upstream failure, not a slow answer: polling would never
                        // find a message and the client got a 504 after the whole request budget.
                        throwIfPromptRejected(promptResult, false);
                        // A finished message in the prompt response is the answer itself: the follow-up poll was one
                        // backend round trip spent on data already in hand. A message still being written has no
                        // `finish`, and that case polls as before (a partial answer must never be served).
                        const fromPrompt = completedPromptMessage(promptResult);
                        if (fromPrompt) logDebug('Polling skipped (prompt carried the finished message)', { sessionId });
                        const { content, reasoning, error } = fromPrompt || await pollForAssistantResponse(
                            sessionId,
                            remainingBudget(),
                            DEFAULT_POLL_INTERVAL_MS,
                            () => clientGone,
                            { requireDone: true }
                        );
                        if (clientGone) {
                            // Nobody is waiting for this answer: free the slot and the session instead of building a
                            // body for a closed socket (the backend keeps finishing on its own)
                            logDebug('Client left before the answer was ready', { sessionId, reqId });
                            release();
                            await cleanupSession();
                            return reply;
                        }
                        if (error) {
                            // A provider failure is an upstream error in this mode too, whether or not the provider
                            // had written some text: answering `200` with the truncated text told the client a
                            // failed completion succeeded.
                            // The session exists by now and must be deleted even though the answer failed
                            reply.code(502).send({
                                error: {
                                    // The provider's own text, masked and bounded like every other upstream reason: a
                                    // provider error routinely quotes the credential it rejected, and the streaming
                                    // path already ran this through clientFacingText(), so the two modes disagreed
                                    // about the same payload in size and in masking.
                                    message: clientFacingText(error.data?.message || error.message) || 'OpenCode provider error',
                                    type: 'server_error',
                                    // The same three stable values the outer handler maps to (see below), not
                                    // `error.name`: this catch runs for a provider that answered before the first frame,
                                    // so it is the same "the provider failed" case the outer path reports as
                                    // `ProviderError`. Leaking `error.name` put an internal exception class in a public
                                    // body - and a plain `Error` put the literal string `Error` in a field documented as
                                    // taking one of three values.
                                    code: 'ProviderError'
                                }
                            });
                            release();
                            await cleanupSession();
                            return reply;
                        }
                        const safeContent = stripFunctionCalls(content);
                        const safeReasoning = stripFunctionCalls(reasoning);

                        const responsePayload = {
                            id: newCompletionId(),
                            object: 'chat.completion',
                            created: Math.floor(Date.now() / 1000),
                            model: `${pID}/${mID}`,
                            choices: [{
                                index: 0,
                                message: { role: 'assistant', content: safeContent, reasoning_content: safeReasoning || null },
                                finish_reason: 'stop'
                            }],
                            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                        };
                        if (logger.isEnabled('debug')) {
                            logger.debug('Upstream response (non-stream full JSON)', {
                                reqId,
                                sessionId,
                                response: responsePayload
                            });
                        }
                        // Send before deleting the session: the client must not wait for a backend round trip that has
                        // nothing to do with its answer (the session is deleted either way)
                        reply.send(responsePayload);
                        release();
                        await cleanupSession();
                        return reply;
                    }
                } catch (error) {
                    // Upstream (opencode serve) call chain failed: always emitted at error level with status code and
                    // error-body summary; the full error object goes to debug level
                    // The keep-alive timer is disarmed here too: the normal end of the streaming block clears it, but
                    // every throw above jumped straight to this catch, so the timer survived for up to one 5 s tick
                    // after the stream was already answered (it self-cleared on the next tick via `writableEnded`,
                    // which is why this showed up as a pending timer rather than a leak). Idempotent.
                    if (abortStream) abortStream();
                    stopKeepAlive();
                    const upstream = extractUpstreamError(error);
                    logger.error('[Proxy] API Error (upstream call failed)', {
                        reqId,
                        sessionId,
                        // The same helper the response body below uses: whatever threw may not be an `Error` at all, and
                        // reading `.message` off it logged an empty cause for a failure that had one
                        message: handlerFailureMessage(error),
                        status: upstream.status,
                        // The body is backend-controlled text: it can quote a URL and a log line is collected as often as not
                        bodySummary: clientFacingText(upstream.bodySummary) || null
                    });
                    // A rejection that is not an `Error` is not masked by `safeClone()` on its way to the line, so the
                    // value goes through the masking helper here: this is the same handler that needs
                    // `handlerFailureMessage()` to read a sentence out of whatever threw. Guarded, because both
                    // `loggableError()` and `maskDetail()` build a bounded copy of the error - the `cause` chain and
                    // the own properties - and at the default `info` level that copy was thrown away: this is the
                    // first statement of every failed completion, before the queue slot is released.
                    if (logger.isEnabled('debug')) {
                        logger.debug('[Proxy] Error details', {
                            reqId,
                            sessionId,
                            error: error instanceof Error ? loggableError(error) : maskDetail(error)
                        });
                    }

                    // A dead/unreachable backend must not stay cached as healthy: drop the timestamp so the next
                    // request performs a real probe (and restarts the backend if needed)
                    if (isConnectionError(error)) {
                        const backend = backendState.get(OPENCODE_SERVER_URL);
                        if (backend) backend.healthyAt = 0;
                    }

                    // The reason can quote a URL (a proxy in front of the backend does), so it is masked before it
                    // reaches the response body and, below, the log line
                    let errorMessage = handlerFailureMessage(error);
                    let statusCode = 500;
                    if (error.message && error.message.includes('Request timeout')) {
                        statusCode = 504;
                    }
                    // A backend call that ran into its deadline is a gateway timeout, named as one instead of leaking
                    // an AbortError/timeout message through as a 500
                    if (isTimeoutError(error)) {
                        statusCode = 504;
                        errorMessage = `OpenCode backend did not answer within ${REQUEST_TIMEOUT_MS}ms`;
                    }
                    // A provider failure is an upstream error, whether the client asked for a stream or not: the
                    // non-streaming path answers 502 for the same condition. So is a backend that went away mid
                    // request: a raw `fetch failed` used to be reported as 500, which tells a client "the gateway has
                    // a bug" instead of "the upstream is gone". A backend that could not be started at all is the same
                    // class (`backendUnavailable`, tagged at the throw): the whole "CLI missing, wrong OPENCODE_PATH,
                    // 2.x CLI, port taken, start cooldown" set was answered `500 server_error` with no `code`, i.e. as
                    // a defect in this gateway, for a cause the client can only retry elsewhere.
                    if (error.name === 'ProviderError' || error.backendUnavailable || isConnectionError(error)) {
                        statusCode = 502;
                    }
                    // A gateway that is going away refuses with 503 and the retry hint the queue already uses: it is
                    // temporary and the client should come back, not conclude that its request was wrong.
                    const retryAfter = error.gatewayShuttingDown === true;
                    if (retryAfter) statusCode = 503;
                    // The connection branch says what happened instead of forwarding Node's own wording: `fetch failed`
                    // is what a dead or refused backend produces, and a client reading it cannot tell whether the
                    // gateway, the backend or its own request is at fault.
                    if (error.name !== 'ProviderError' && isConnectionError(error)) {
                        errorMessage = `OpenCode backend is not reachable (${clientFacingText(error.message)})`;
                    }
                    if (error.message && error.message.includes('ENOENT')) {
                        // Appended to the cause, never instead of it: this branch used to replace every `ENOENT` on
                        // every platform with one sentence about Windows and a restart - advice that cannot fix a
                        // missing file, and it hid the start failure ("Failed to start OpenCode backend: …") that the
                        // contract says a backend the gateway cannot start must name. A POSIX host reaches this with a
                        // configured executable whose interpreter is missing, which has nothing to do with Windows.
                        errorMessage = process.platform === 'win32'
                            ? `${errorMessage} (the path could not be opened; on Windows this is usually a quoting or path problem)`
                            : `${errorMessage} (a file the backend needs is missing)`;
                    }
                    // OpenAI clients branch on the type: a gateway/upstream failure is a server_error, and the
                    // constructor name of an internal exception is not part of any contract
                    const payload = { error: { message: errorMessage, type: 'server_error' } };
                    // A 502 is an upstream failure, and which one is what every other error in this API carries in
                    // `code`: a client could only tell "the backend refused the session" from "the connection died"
                    // by parsing the prose. Three stable values, not `error.name` - a connection failure is a
                    // TypeError, and an internal class name is not part of any contract.
                    if (statusCode === 502) {
                        // The connection case is tested first: a backend that dies mid-request surfaces as a
                        // ProviderError whose message carries `fetch failed`, and `backend_unreachable` is the answer
                        // a client can act on. A start failure is unreachable with no ambiguity at all - nothing was
                        // connected to - and it is named the same way, so a client does not have to parse prose to
                        // learn that its model request never reached the backend.
                        payload.error.code = (isConnectionError(error) || error.backendUnavailable)
                            ? 'backend_unreachable'
                            : (error.name === 'ProviderError' ? 'ProviderError' : 'upstream_error');
                    } else if (retryAfter) {
                        payload.error.code = 'gateway_shutting_down';
                    }
                    if (!reply.raw.headersSent) {
                        if (hijacked) {
                            reply.raw.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
                            reply.raw.end(JSON.stringify(payload));
                        } else if (retryAfter) {
                            reply.code(statusCode).header('Retry-After', '1').send(payload);
                        } else {
                            reply.code(statusCode).send(payload);
                        }
                    } else if (hijacked) {
                        // Frames are already on the wire: answer in-band and terminate the stream
                        failHijackedStream(reply.raw, payload);
                    }
                    release();
                    // Deletes the session if it was created (and is not already gone); before session creation there
                    // is simply nothing to clean up
                    if (cleanupSession) await cleanupSession();
                }
            // Clamped to the largest timer Node accepts, like every other delay built from the budget: the budget itself
            // is clamped to MAX_TIMER_MS, and adding the grace to it overflowed `setTimeout` - which fires after 1 ms
            // with a TimeoutOverflowWarning, so a budget at the documented maximum turned every completion into an
            // instant 504 that named a deadline the client never had.
            }, Math.min(REQUEST_TIMEOUT_MS + 20000, MAX_TIMER_MS));
        } catch (error) {
            // Rejected before any backend work happened: this is a capacity signal, not a gateway failure
            if (error && error.name === 'QueueFullError') {
                logger.warn('[Proxy] Request rejected:', { message: error.message, waiting: queue.length });
                if (!reply.raw.headersSent) {
                    // A full queue is temporary, and OpenAI SDKs retry a 503 only when the answer tells them to wait:
                    // without the header the request fails instead of backing off and being served a moment later
                    reply.code(503)
                        .header('Retry-After', '1')
                        .send({ error: { message: error.message, type: 'queue_full' } });
                }
                return reply;
            }
            // Built before the log lines below read it: a `const` read ahead of its declaration is a ReferenceError,
            // and that one would replace the cause of the 500 with a bug in this catch (the operator sees
            // "Cannot access 'handlerMessage' before initialization" and no reason at all).
            // This catch writes the body itself, so the top-level handler's masking never sees it: a 500 here is the
            // same kind of sentence - written by whatever threw - and gets the same treatment, in the body and in the
            // log line.
            const handlerMessage = handlerFailureMessage(error);
            // The last line of defence is the queue timer (waiting for a slot, or running longer than the whole
            // budget). That is a gateway timeout, not a gateway bug: answering 500 for it hid the timeout and leaked
            // the internal budget number to the client.
            const timedOut = typeof error?.message === 'string' && error.message.includes('Request timeout');
            if (timedOut) {
                logger.warn('[Proxy] Completion timed out:', { message: error.message });
            } else {
                logger.error('[Proxy] Request Handler Error:', { message: handlerMessage, stack: maskFreeText(error?.stack, MAX_LOGGED_STACK_CHARS) });
            }
            // The deadline that actually expired, when the timer knew it: the queue backstop waits the request budget
            // plus a grace, and naming the smaller number told a client its 300 s timeout ended after it had waited 320 s.
            const expiredDeadlineMs = Number.isFinite(error?.deadlineMs) ? error.deadlineMs : REQUEST_TIMEOUT_MS;
            const payload = {
                error: {
                    message: timedOut
                        ? `OpenCode gateway did not finish the completion within ${expiredDeadlineMs}ms`
                        : handlerMessage,
                    type: 'server_error'
                }
            };
            // The same lifecycle refusal as the inner catch: a backend that cannot be started is an upstream failure
            // (502), a gateway that is going away is a temporary 503. This catch covers the paths that never reached
            // the backend work (validation, the queue timer), so the mapping is repeated here rather than assumed.
            const lifecycleStatus = error?.gatewayShuttingDown ? 503 : (error?.backendUnavailable ? 502 : 0);
            const statusCode = timedOut ? 504 : (lifecycleStatus || 500);
            if (lifecycleStatus === 502) payload.error.code = 'backend_unreachable';
            if (lifecycleStatus === 503) payload.error.code = 'gateway_shutting_down';
            if (!reply.raw.headersSent) {
                if (hijacked) {
                    reply.raw.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
                    reply.raw.end(JSON.stringify(payload));
                } else if (lifecycleStatus === 503) {
                    reply.code(statusCode).header('Retry-After', '1').send(payload);
                } else {
                    reply.code(statusCode).send(payload);
                }
            } else if (hijacked) {
                failHijackedStream(reply.raw, payload);
            }
        }
        return reply;
    });

    // The root is open (see the auth hook) and answers a small service index instead of a bare 404, so a browser or
    // a container probe that hits the base URL learns what this process is without a key.
    const indexBody = JSON.stringify({
        service: 'free-opencode-api',
        status: 'ok',
        endpoints: {
            health: '/health',
            models: '/v1/models',
            chat_completions: '/v1/chat/completions'
        }
    });
    app.get('/', (request, reply) => reply.type('application/json; charset=utf-8').send(indexBody));

    // Health check. The body never changes for the lifetime of the process, so it is serialized once and sent as a
    // ready-made string instead of going through a serializer on every probe.
    const healthBody = JSON.stringify({ status: 'ok', backend: maskBackendUrl(OPENCODE_SERVER_URL) });
    // Not async: a sync handler skips the promise Fastify would otherwise await on every probe, and the body is
    // already serialized - a liveness probe is the one request that never needs to suspend.
    app.get('/health', { schema: { response: { 200: HEALTH_SCHEMA } } }, (request, reply) =>
        reply.type('application/json; charset=utf-8').send(healthBody));

    // Uniform OpenAI-style error envelope for anything Fastify itself rejects (invalid JSON, body too large,
    // unknown route, ...) instead of the framework's default { statusCode, code, error, message } shape
    /**
     * An oversized body is refused while the client is still uploading it. Node ends the socket as soon as a response
     * finishes with the request body unread (so the leftover bytes cannot be parsed as another request), and that
     * close carries the kernel's RST for whatever the client is still writing - the client could lose the 413
     * completely and report a bare connection error (Node 24's fetch said "fetch failed") for a request it would then
     * retry forever. So the refusal is written only once the body has been read to its end, bounded: a client that
     * keeps writing is cut off after BODY_DRAIN_TIMEOUT_MS instead of holding the socket.
     */
    function refuseOversizedBody(request, send) {
        const raw = request.raw;
        if (raw.destroyed || raw.readableEnded) return send();
        let settled = false;
        // `closeConnection` is set by the drain budget expiring, i.e. the client is still uploading: answer now and
        // close the connection behind the response. `destroy()` did that here and discarded a buffered body under
        // backpressure - the failure `closeSocketAfterFlush()` exists for ("under backpressure the client saw a reset
        // instead of the envelope this handler exists to deliver") - so the timeout path uses the helper the
        // parser-error handler already uses.
        const finish = (closeConnection) => {
            if (settled) return;
            settled = true;
            clearTimeout(cut);
            raw.off('end', finishBody);
            raw.off('close', finishBody);
            send();
            if (closeConnection && !raw.destroyed) closeSocketAfterFlush(raw.socket || raw);
        };
        const finishBody = () => finish(false);
        const cut = setTimeout(() => finish(true), BODY_DRAIN_TIMEOUT_MS);
        cut.unref();
        raw.once('error', finishBody);
        raw.once('end', finishBody);
        raw.once('close', finishBody);
        raw.resume();
    }

    app.setErrorHandler((error, request, reply) => {
        const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
        // Three refusals the content-type layer makes arrive with text that names nothing the client can act on, so the
        // envelope says what was actually wrong and what to send instead:
        //
        // - FST_ERR_CTP_INVALID_JSON_BODY covers both a body that does not parse **and** one that carries a property
        //   name Fastify's prototype-poisoning guard refuses (`__proto__`, `constructor`), so a body that parsed
        //   perfectly was told its JSON was invalid and had nothing to fix in the syntax.
        // - FST_ERR_CTP_INVALID_MEDIA_TYPE arrives as "Unsupported Media Type" for any type the gateway does not
        //   parse, including a request that sends a body with **no** Content-Type header at all - the likeliest
        //   hand-written mistake there is, answered with a message that names neither the type nor the fix.
        // - FST_ERR_CTP_BODY_TOO_LARGE says only that something was too large. The limit is a knob
        //   (`OPENCODE_PROXY_MAX_BODY_MB`) and the client's fix depends on the number: send less, or raise it. It is
        //   read from the value this app was built with, so the sentence cannot disagree with `bodyLimit`.
        const errorMessageFor = (err) => {
            if (!err) return 'Internal Server Error';
            if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
                return `request body is too large (limit ${bodyLimitMb} MiB); send a smaller body or raise `
                    + 'OPENCODE_PROXY_MAX_BODY_MB';
            }
            if (err.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
                return FORBIDDEN_BODY_MESSAGE;
            }
            // An empty body is what a retry whose payload went missing sends, and Fastify answered it with a sentence
            // about the content type the client had just set correctly. The same request without that header reaches
            // the handler and is answered "messages array is required", so the emptiness is named instead - and with
            // it the fix.
            if (err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
                return EMPTY_BODY_MESSAGE;
            }
            if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
                const rawType = request.headers['content-type'];
                if (typeof rawType !== 'string' || rawType.trim() === '') {
                    return 'the request has a body but no Content-Type header; send Content-Type: application/json';
                }
                // Client input reaching a response body: control characters replaced and the value cut, like every
                // other client-controlled string the gateway echoes back
                return `unsupported content type "${echoedValue(rawType.split(';')[0].trim())}"; send Content-Type: application/json`;
            }
            return err.message;
        };
        // A 5xx sentence is the one message in this handler nobody here wrote: it comes from whatever threw - the SDK,
        // Node's `fetch`, a library - and an error raised while talking to a backend behind a credential-bearing URL
        // can quote that URL. Every other upstream sentence already goes through `clientFacingText()`; this is the
        // path that did not, so the credential `OPENCODE_SERVER_URL` may carry (`?token=…`) could reach a client in a
        // 500 body. A 4xx message is the gateway's own words about the client's request (`echoedValue()` already
        // bounds the echoed parts) and is left as it is.
        const rawMessage = errorMessageFor(error);
        const errorMessage = statusCode >= 500 ? clientFacingText(rawMessage) || rawMessage : rawMessage;
        const detail = {
            method: request.method,
            // Client input: a credential in the query string is masked and a pathological URL is cut, the same way
            // the request summary treats it
            path: loggableUrl(request.url),
            message: errorMessage,
            code: error.code || error.name
        };
        if (statusCode >= 500) logger.error('[Proxy] Unhandled request error:', detail);
        else logger.warn('[Proxy] Rejected request:', detail);
        if (reply.raw.headersSent) {
            if (!reply.raw.writableEnded) reply.raw.end();
            return;
        }
        const sendRefusal = () => reply.code(statusCode).send({
            error: {
                message: errorMessage,
                type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
                // Fastify's own identifier (FST_ERR_CTP_INVALID_JSON_BODY, ...) is kept for support tickets
                code: error.code || error.name || 'Error'
            }
        });
        if (statusCode === 413) {
            refuseOversizedBody(request, sendRefusal);
            return;
        }
        sendRefusal();
    });

    // Unknown routes use the same OpenAI-style envelope. The answer names the paths a confused client most likely
    // meant: an OpenAI client pointed at `/v1/completions`, `/v1/embeddings` or `/v1/responses` gets a 404 with no way
    // to learn that this gateway serves chat completions only, and the fix is a different URL, not a different body.
    // The list is one constant so the sentence and the smoke assertion cannot drift apart.
    app.setNotFoundHandler((request, reply) => {
        reply.code(404).send({
            error: {
                // The path is echoed back, so it is the client's own input: no query string, no control characters
                message: `Route ${request.method} ${loggableUrl(urlPath(request.url))} not found; this gateway serves ${SERVED_ROUTES}`,
                type: 'not_found'
            }
        });
    });

    return { app, client };
}

// Backend management state (per-instance)
const backendState = new Map();

// Waits (bounded) for a start attempt that was still in flight when the gateway began shutting down, so a child it
// spawned a moment later is tracked instead of orphaned. The attempt aborts at its next checkpoint - the readiness
// loop checks `state.shuttingDown` every iteration - and the wait only has to cover what it is already inside: a health
// probe (2 s timeout) or the SIGTERM/SIGKILL escalation of the previous child (3 s). It fits inside the teardown budget
// below, which is what `index.js` bounds its own hard exit against.
const PENDING_START_WAIT_MS = 3500;
async function waitForPendingStart(state) {
    const deadline = Date.now() + PENDING_START_WAIT_MS;
    while (state.isStarting && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
    }
}

// At most one background health probe per backend at a time: a burst of completions that all arrive after the trust
// window must not each spend a probe.
const healthRefreshInFlight = new Set();
function refreshBackendHealthInBackground(state, serverUrl) {
    if (healthRefreshInFlight.has(state)) return;
    healthRefreshInFlight.add(state);
    checkHealth(serverUrl)
        .then(() => {
            state.healthyAt = Date.now();
            state.lastStartFailureAt = 0;
        })
        .catch(() => {
            // A connection failure clears the trust exactly like the request path does, so the next completion takes
            // the blocking path (probe, retry cooldown, start) instead of believing a backend that is gone.
            state.healthyAt = 0;
        })
        .finally(() => {
            healthRefreshInFlight.delete(state);
        });
}

/**
 * Backend Lifecycle Management
 */
async function ensureBackend(config, options = {}) {
    const { OPENCODE_SERVER_URL, OPENCODE_PATH, OPENCODE_BIND_HOST, USE_ISOLATED_HOME } = config;
    const stateKey = OPENCODE_SERVER_URL;

    if (!backendState.has(stateKey)) {
        backendState.set(stateKey, {
            isStarting: false,
            // Set by killBackend(): a start attempt that is still in flight must not spawn a backend after the
            // gateway has gone, otherwise that child outlives the process that owns it and holds the backend port.
            shuttingDown: false,
            process: null,
            jailRoot: null,
            healthyAt: 0,
            lastStartError: null,
            lastStartFailureAt: 0
        });
    }

    const state = backendState.get(stateKey);

    // The gateway is going away: never start (or restart) a backend from here
    if (state.shuttingDown) throw Object.assign(new Error('The gateway is shutting down'), { gatewayShuttingDown: true });

    // A recent successful probe is trusted for BACKEND_HEALTH_CACHE_MS so a burst of chat requests shares one
    // health round trip instead of one per request; connection failures reset the timestamp (see chat error path)
    if (options.force !== true && BACKEND_HEALTH_CACHE_MS > 0 && state.healthyAt && Date.now() - state.healthyAt < BACKEND_HEALTH_CACHE_MS) {
        return;
    }

    // A known-good backend whose trust window has expired is refreshed in the background instead of being probed on
    // the request path. With the default 2 s window and MAX_CONCURRENCY=1, essentially every interactive completion
    // arrived after the window and paid a serial /health round trip before session.create: +3.2 ms on loopback
    // (+82 % of the local happy path, measured) and one full RTT against a networked backend. Nothing is lost: a
    // backend that died is still recovered by the request that hits it - session.create fails on the connection error,
    // clears healthyAt and calls ensureBackend() again - and a backend that has never answered still takes the
    // blocking path below. `OPENCODE_PROXY_HEALTH_CACHE_MS=0` keeps its documented meaning (a probe per request).
    if (options.force !== true && BACKEND_HEALTH_CACHE_MS > 0 && state.healthyAt) {
        refreshBackendHealthInBackground(state, OPENCODE_SERVER_URL);
        return;
    }

    if (state.isStarting) {
        // Another request (or the startup warmup) is starting the backend: wait for it instead of starting a second one.
        // The probe comes first and the sleep sits between attempts: sleeping before every probe made a request that
        // arrived during a start attempt wait a full second even though the backend was already answering.
        for (let i = 0; i < STARTING_WAIT_ITERATIONS; i++) {
            try {
                await checkHealth(OPENCODE_SERVER_URL);
                state.healthyAt = Date.now();
                return;
            } catch (e) { }
            // That attempt is over without a reachable backend: fall through and start one here rather than failing
            // this request - the first request after a backend crash used to answer an error even though a start was
            // now possible. The start path itself still honours the retry cooldown, so this cannot become a storm.
            if (!state.isStarting) break;
            await new Promise(r => setTimeout(r, STARTING_WAIT_INTERVAL_MS));
        }
        if (state.isStarting) throw backendUnavailable('Backend startup timeout');
    }

    // Claim the start attempt *before* the probe that may suspend: the claim used to happen only after that probe
    // failed, so two callers arriving within one probe round trip (the startup warmup racing the first request, or two
    // concurrent completions) both spawned a backend. The second spawn killed the first one's child and overwrote the
    // tracked process, so the first child was left behind and outlived the gateway.
    state.isStarting = true;
    try {
        try {
            await checkHealth(OPENCODE_SERVER_URL);
            state.healthyAt = Date.now();
            state.lastStartFailureAt = 0;
            return;
        } catch (err) {
            // Recent start attempt already failed: answer immediately instead of retrying the whole startup wait
            if (state.lastStartFailureAt && Date.now() - state.lastStartFailureAt < BACKEND_START_RETRY_COOLDOWN_MS) {
                throw backendUnavailable(`OpenCode backend unavailable (last start attempt failed: ${state.lastStartError || 'unknown error'})`);
            }
            // The probe above suspended for up to its timeout, which is exactly the window a shutdown can land in
            if (state.shuttingDown) throw Object.assign(new Error('The gateway is shutting down'), { gatewayShuttingDown: true });
            // Masked: the URL can carry a credential (see resolveBackendAuth), and this line is the one an operator
            // reads in `docker logs`
            logger.info(`[Proxy] OpenCode backend not found at ${maskBackendUrl(OPENCODE_SERVER_URL)}. Starting...`);

            // A backend on another machine is not this process's to start: a local child binds a local port, which can
            // never make `http://otherhost:4097` answer. Without this line the next 60 probes timed out with no cause
            // named, and the child stayed behind holding a port the operator wanted for something else.
            let configuredHost = null;
            try {
                configuredHost = new URL(OPENCODE_SERVER_URL).hostname;
            } catch (e) {
                // Unparseable: the spawn below reports that on its own
            }
            if (configuredHost && !isLoopbackHost(configuredHost)) {
                logger.warn(
                    `[Proxy] ${maskBackendUrl(OPENCODE_SERVER_URL)} is not on this machine, so a backend started here ` +
                    'cannot satisfy it. Start `opencode serve` on that host, or point OPENCODE_SERVER_URL at ' +
                    '127.0.0.1 to let this gateway manage one.'
                );
            }

            // Kill the existing process if any, and wait for it to be gone before spawning a replacement: SIGTERM
            // was sent and the new backend started on the next line, so the old child still held the port and the
            // replacement failed to bind ("exited during startup"), which then tripped the retry cooldown - one
            // wedged backend turned its own recovery into a 15 s outage. SIGKILL after 3 s for a child that ignores
            // SIGTERM, like killBackend() does.
            if (state.process) {
                const previous = state.process;
                if (previous.exitCode === null && previous.signalCode === null) {
                    const exited = new Promise((resolve) => {
                        let settled = false;
                        const done = () => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(escalate);
                            resolve();
                        };
                        const escalate = setTimeout(() => {
                            try {
                                previous.kill('SIGKILL');
                            } catch (e) { }
                            done();
                        }, 3000);
                        if (escalate.unref) escalate.unref();
                        previous.once('exit', done);
                    });
                    try {
                        previous.kill();
                    } catch (e) { }
                    await exited;
                }
            }

            // Cleanup old temp dir - after the child is gone, because it is that child's working directory. The path
            // leaves the tracked set too: it used to stay in it, so every respawn added an entry that cleanupTempDirs()
            // then tried to remove again at shutdown.
            if (state.jailRoot) {
                const previousJail = state.jailRoot;
                state.jailRoot = null;
                ownedJailRoots.delete(previousJail);
                if (fs.existsSync(previousJail)) {
                    try {
                        fs.rmSync(previousJail, { recursive: true, force: true });
                    } catch (e) { }
                }
            }

            // Last checkpoint before the spawn below, which has no suspension of its own: the wait for the previous
            // child (up to 3 s) can end with the process already shutting down.
            if (state.shuttingDown) throw Object.assign(new Error('The gateway is shutting down'), { gatewayShuttingDown: true });

            const isWindows = process.platform === 'win32';
            const useIsolatedHome = typeof USE_ISOLATED_HOME === 'boolean'
                ? USE_ISOLATED_HOME
                : parseBoolean(process.env.OPENCODE_USE_ISOLATED_HOME ?? process.env.USE_ISOLATED_HOME, false);

            // On Windows, don't use isolated fake-home to avoid path issues
            // On Unix-like systems, use jail for isolation
            // The salt is what keeps two gateway instances (or two respawns) out of each other's jail:
            // `Math.random().toString(36).substring(7)` could yield an empty string (deleting the shared parent) or a
            // one-character name (colliding with another instance, whose jail cleanup would then remove it).
            const salt = randomBytes(8).toString('hex');
            if (!salt) throw new Error('Could not generate a jail directory name');
            // 0700: this tree is the backend's working directory and, with USE_ISOLATED_HOME, its entire HOME. The
            // default mode (0755) let any other local user on a shared /tmp traverse and list it, which defeats the
            // isolation the option exists for. mkdir's mode is masked by the umask, so 0700 is the strictest that
            // survives.
            // Ownership-checked, with a private fallback: see `resolveJailParent()`
            const jailParent = resolveJailParent(isWindows);
            const jailRoot = path.join(jailParent, salt);
            state.jailRoot = jailRoot;
            ownedJailRoots.add(jailRoot);
            const workspace = path.join(jailRoot, 'empty-workspace');

            let envVars;
            let cwd;

            if (isWindows) {
                // Windows: use normal user home to avoid opencode storage path issues
                fs.mkdirSync(workspace, { recursive: true });
                cwd = workspace;
                envVars = {
                    ...process.env,
                    OPENCODE_PROJECT_DIR: workspace
                };
                logger.info('[Proxy] Running on Windows, using standard user home directory');
            } else {
                fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
                cwd = workspace;

                if (useIsolatedHome) {
                    // Unix-like: use isolated fake-home
                    const fakeHome = path.join(jailRoot, 'fake-home');

                    // Create necessary opencode directories
                    const opencodeDir = path.join(fakeHome, '.local', 'share', 'opencode');
                    const storageDir = path.join(opencodeDir, 'storage');
                    const messageDir = path.join(storageDir, 'message');
                    const sessionDir = path.join(storageDir, 'session');
                    // The store above is only the default location: the CLI resolves `XDG_DATA_HOME` first, and a
                    // desktop session, a systemd unit or an image that sets the XDG variables sent the isolated run
                    // straight back to the real user's store, config and cache - outside the 0700 jail this directory
                    // exists to provide. They point inside it here, and `TMPDIR` follows the same rule.
                    const xdgData = path.join(fakeHome, '.local', 'share');
                    const xdgConfig = path.join(fakeHome, '.config');
                    const xdgCache = path.join(fakeHome, '.cache');
                    const xdgState = path.join(fakeHome, '.local', 'state');
                    const jailTmp = path.join(jailRoot, 'tmp');

                    [fakeHome, opencodeDir, storageDir, messageDir, sessionDir, xdgConfig, xdgCache, xdgState, jailTmp].forEach(d => {
                        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
                    });

                    envVars = {
                        ...process.env,
                        HOME: fakeHome,
                        USERPROFILE: fakeHome,
                        XDG_DATA_HOME: xdgData,
                        XDG_CONFIG_HOME: xdgConfig,
                        XDG_CACHE_HOME: xdgCache,
                        XDG_STATE_HOME: xdgState,
                        TMPDIR: jailTmp,
                        TMP: jailTmp,
                        TEMP: jailTmp,
                        OPENCODE_PROJECT_DIR: workspace
                    };
                    logger.info('[Proxy] Using isolated home for OpenCode');
                } else {
                    envVars = {
                        ...process.env,
                        OPENCODE_PROJECT_DIR: workspace
                    };
                    logger.info('[Proxy] Using real HOME for OpenCode (isolation disabled)');
                }
            }

            // The gateway's own credential and its private plumbing are not the backend's business: the child is
            // an agent runtime that, with tools enabled, executes model-directed work, so it must not inherit the key
            // that guards this gateway (it only guards this gateway - `opencode serve` authenticates nothing with it).
            // Provider credentials the CLI needs live in its own auth store or under their own names and stay.
            delete envVars.API_KEY;
            delete envVars.OPENCODE_PROXY_DEBUG;
            // This one names a credential as well: `OPENCODE_SERVER_URL` can carry `user:pass@` for a proxy in front of
            // the backend, and the child had no use for it - it *is* the backend (`opencode serve`), it does not
            // connect to one. Passing it on published a credential to a process that runs model-directed tools.
            delete envVars.OPENCODE_SERVER_URL;
            // A 2.x server authenticates every `/api/*` route with its own password, and it reads that password from this
            // variable. Pinning it here is what lets the gateway never scrape the child's output: when the variable is
            // set the server does not print a `server password …` line at all, and the value it uses is the one this
            // process already sends in `Authorization`. An inherited value would otherwise let a child that was started
            // with a different password than the gateway holds answer 401 to every call.
            if (BACKEND_SERVER_PASSWORD_VALUE) {
                envVars.OPENCODE_SERVER_PASSWORD = BACKEND_SERVER_PASSWORD_VALUE;
            } else {
                delete envVars.OPENCODE_SERVER_PASSWORD;
            }

            let port = '4097';
            try {
                port = new URL(OPENCODE_SERVER_URL).port || '4097';
            } catch (e) {
                logger.warn(`[Proxy] Could not parse OPENCODE_SERVER_URL '${maskBackendUrl(OPENCODE_SERVER_URL)}', assuming port 4097`);
            }
            const resolved = resolveOpencodePath(OPENCODE_PATH);
            const opencodeBin = resolved.path || OPENCODE_PATH || OPENCODE_BASENAME;
            if (resolved.path) {
                logger.info(`[Proxy] Using OpenCode binary: ${loggableConfigValue(opencodeBin)} (source: ${resolved.source})`);
            } else {
                logger.warn(`[Proxy] Unable to resolve OpenCode binary for '${loggableConfigValue(OPENCODE_PATH)}'. Using as-is.`);
            }

            // Cross-platform spawn options
            const useShell = process.platform === 'win32' || !resolved.path ||
                opencodeBin.endsWith('.cmd') || opencodeBin.endsWith('.bat');
            // A shell parses the command line, so the binary has to survive it: quoting keeps spaces intact (an
            // unquoted "C:\Program Files\...opencode.cmd" does not start at all) and turns operators such as `;` or
            // `&` into literal text. Only what quoting cannot neutralise is refused - including a control character,
            // because quoting does not survive a line break: `"a\nb"` is still two commands, and a path carrying one
            // ran whatever followed it as a second shell line.
            let spawnTarget = opencodeBin;
            if (useShell) {
                if (isShellUnsafePath(opencodeBin)) {
                    throw new Error(`OPENCODE_PATH cannot be passed through a shell: ${loggableConfigValue(opencodeBin)}`);
                }
                spawnTarget = `"${opencodeBin}"`;
            }
            const spawnOptions = {
                stdio: 'inherit',
                cwd: cwd,
                env: envVars,
                shell: useShell  // Use shell only when needed (e.g., Windows .cmd or unresolved PATH)
            };

            // Backend listen address: OPENCODE_BIND_HOST (default 127.0.0.1; set to 0.0.0.0 inside Docker so port 4097
            // can be exposed)
            const bindHost = OPENCODE_BIND_HOST || '127.0.0.1';
            logger.info(`[Proxy] Starting OpenCode backend: --port ${loggableConfigValue(port)} --hostname ${loggableConfigValue(bindHost)}`);
            state.process = spawn(spawnTarget, ['serve', '--port', port, '--hostname', bindHost], spawnOptions);

            // Handle spawn errors
            let spawnError = null;
            state.process.on('error', (err) => {
                spawnError = err;
                // Masked and flattened: the message is quoted from the OS and repeats `OPENCODE_PATH`
                logger.error(`[Proxy] Failed to spawn OpenCode: ${loggableUpstreamText(err.message)}`);
                if (err.code === 'ENOENT') {
                    logger.error(`[Proxy] Command '${loggableConfigValue(OPENCODE_PATH)}' not found. Please ensure OpenCode is installed and in your PATH.`);
                    logger.error(`[Proxy] You can specify the full path in config.json using 'OPENCODE_PATH'`);
                }
            });

            // Wait for backend to be ready (a spawn failure aborts the wait right away instead of burning
            // the full startup budget)
            let started = false;
            for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
                if (spawnError) break;
                // Shutdown began while this attempt was waiting for the backend: stop here instead of holding
                // `state.isStarting` for the rest of the startup budget. That flag is what `killBackend()` waits for,
                // so a full budget left the escalation too little room (the child was spawned already, and the
                // teardown below reaps it).
                if (state.shuttingDown) {
                    spawnError = new Error('gateway is shutting down');
                    break;
                }
                // Spawned through a shell (missing/unresolved binary) the process exits with a code instead of
                // emitting 'error'; stop waiting as soon as that happens. A child killed by a signal reports
                // exitCode === null and only sets signalCode, so testing the exit code alone missed every backend that
                // was killed (OOM, SIGKILL, a supervisor) and kept every request waiting for the full 60-iteration
                // startup budget while the backend was already gone.
                if (state.process.exitCode !== null || state.process.signalCode !== null) {
                    const how = state.process.exitCode !== null
                        ? `code ${state.process.exitCode}`
                        : `signal ${state.process.signalCode}`;
                    spawnError = new Error(`OpenCode backend exited during startup (${how})`);
                    break;
                }
                // The probe comes first and the sleep sits between attempts - the rule the "another request is
                // starting" loop already follows. Sleeping before every probe made a backend that listens in ~100 ms
                // wait the whole interval anyway: measured 2.016 s between the "Starting OpenCode backend" line and
                // "backend ready", paid on every cold start, crash restart and request-triggered respawn.
                try {
                    await checkHealth(OPENCODE_SERVER_URL);
                    logger.info('[Proxy] OpenCode backend ready.');
                    started = true;
                    break;
                } catch (e) { }
                // A short first backoff, then the configured interval: the first probes of a starting child fail
                // because it has not bound yet, so they must not be spaced by the full interval.
                const backoff = STARTUP_BACKOFF_MS[Math.min(i, STARTUP_BACKOFF_MS.length - 1)];
                await new Promise(r => setTimeout(r, backoff));
            }

            if (spawnError) {
                state.lastStartError = spawnError.message;
                state.lastStartFailureAt = Date.now();
                throw backendUnavailable(`Failed to start OpenCode backend: ${spawnError.message}`);
            }

            if (!started) {
                logger.warn('[Proxy] Backend start timed out.');
                state.lastStartError = 'Backend start timeout';
                state.lastStartFailureAt = Date.now();
                throw backendUnavailable('Backend start timeout');
            }
        }
    } finally {
        // Released on every path (healthy probe, cooldown refusal, spawn failure, timeout): the flag is what makes the
        // other callers wait for this attempt instead of starting a second backend
        state.isStarting = false;
    }
}

/**
 * Starts the OpenCode-to-OpenAI Proxy server.
 */
export function startProxy(options) {
    // A value the caller resolved is taken as given (index.js already reported an unusable one, so warning here again
    // would print the same line twice). The environment is read only when the option is absent, and through
    // readFlag() so an embedder that calls startProxy() directly gets the same `[Config]` warning the entry point
    // emits instead of a silent fallback: `DISABLE_TOOLS=maybe` in the environment turned the tool guard off with no
    // report at all on that path.
    const flagEnvValue = (names) => {
        for (const name of names) {
            const value = process.env[name];
            if (value !== undefined && String(value).trim() !== '') return { name, value };
        }
        return null;
    };
    const flagOption = (given, names, fallback) => {
        if (given !== undefined && given !== null && String(given).trim() !== '') return readFlag(names[0], given, fallback);
        const source = flagEnvValue(names);
        return source ? readFlag(source.name, source.value, fallback) : fallback;
    };
    const disableTools = flagOption(options.DISABLE_TOOLS ?? options.disableTools, ['OPENCODE_DISABLE_TOOLS', 'DISABLE_TOOLS'], false);

    // Normalised once: a trailing slash in OPENCODE_SERVER_URL turns every SDK path into `//session` (404)
    const backendUrl = normalizeBackendUrl(options.OPENCODE_SERVER_URL || 'http://127.0.0.1:4097');

    const requestTimeout = resolveRequestTimeoutMs(options);
    // A blank option means "not configured" and keeps the default; anything else - `0` included - is the caller's
    // number. Port 0 is a legitimate request ("listen on a free port") and it is what an embedder and the smoke suite
    // pass to avoid colliding with a gateway already on the default one. Read with `||` it bound 8083 instead, silently,
    // because the embedder path has no entry-point validator in front of it.
    const portOption = options.PORT;
    const config = {
        PORT: (portOption === undefined || portOption === null || String(portOption).trim() === '') ? 8083 : portOption,
        // Empty/blank values fall back to DEFAULT_API_KEY: authentication is always on
        API_KEY: resolveApiKey(options.API_KEY),
        OPENCODE_SERVER_URL: backendUrl.url,
        // The bind addresses are trimmed here as well as in the entry point: an embedder that passes the value straight
        // from its own configuration gets the same treatment, and the second call is a no-op for a trimmed value.
        OPENCODE_BIND_HOST: normalizeBindHost(
            'OPENCODE_BIND_HOST',
            options.OPENCODE_BIND_HOST || options.openCodeBindHost || process.env.OPENCODE_BIND_HOST
        ) || '127.0.0.1',
        OPENCODE_PATH: options.OPENCODE_PATH || 'opencode',
        // The OpenCode 2.x server password. A blank value means "generate one per process", which a spawned child is
        // handed so the two always agree; an external server needs the operator to configure the same value.
        OPENCODE_SERVER_PASSWORD: (() => {
            const raw = options.OPENCODE_SERVER_PASSWORD ?? options.openCodeServerPassword
                ?? process.env.OPENCODE_SERVER_PASSWORD;
            return (raw === undefined || raw === null || String(raw).trim() === '') ? '' : String(raw).trim();
        })(),
        BIND_HOST: normalizeBindHost(
            'BIND_HOST',
            options.BIND_HOST || options.bindHost || process.env.OPENCODE_PROXY_BIND_HOST
        ) || '127.0.0.1',
        // Raw LOG_LEVEL value: index.js already merged it as "env > config.json" and passes it in; when startProxy is
        // called directly, fall back to reading the environment variable
        LOG_LEVEL: options.LOG_LEVEL ?? options.logLevel ?? process.env.LOG_LEVEL ?? null,
        USE_ISOLATED_HOME: flagOption(
            options.USE_ISOLATED_HOME ?? options.useIsolatedHome,
            ['OPENCODE_USE_ISOLATED_HOME', 'USE_ISOLATED_HOME'],
            false
        ),
        // A malformed value must fall back to the default: Number('abc') is NaN and setTimeout(NaN) fires immediately,
        // which would turn every completion into a 504. The fallback is named, like the queue and body knobs: a typo
        // used to be invisible, so the gateway ran with 300000 ms while the operator believed a shorter budget was in
        // force. Resolution lives in one exported helper so the precedence (a blank environment value is "not set")
        // is the same everywhere and can be tested without mutating `process.env`.
        REQUEST_TIMEOUT_MS: requestTimeout.value,
        DISABLE_TOOLS: disableTools,
        DEBUG: flagOption(options.DEBUG, ['OPENCODE_PROXY_DEBUG'], false)
    };

    // The queue limits follow the same precedence as every other key (environment, then config.json, then default).
    // They used to be resolved from the environment alone, so the same keys in config.json were silently ignored and
    // the gateway kept the documented default while the operator believed a different value was in force.
    if (requestTimeout.note) logger.warn(`[Config] ${requestTimeout.note}`);
    const resolvedLimits = getQueueLimits(options);
    MAX_CONCURRENCY = resolvedLimits.concurrency;
    MAX_QUEUE_LENGTH = resolvedLimits.queue;
    // The probe pool follows the concurrency: four keep-alive sockets were enough for the serialized default, but a
    // configured concurrency of 32 probes at once queued behind them - the burst path (a backend that just lost its
    // cached health) waited on sockets instead of on the backend.
    healthAgent.maxSockets = Math.max(4, MAX_CONCURRENCY);
    healthAgentSecure.maxSockets = healthAgent.maxSockets;
    resolvedLimits.notes.forEach((note) => logger.warn(`[Config] ${note}`));
    // Same treatment for the body limit: a value that cannot be used must not look like it took effect
    const resolvedBodyLimit = readLimit(
        'OPENCODE_PROXY_MAX_BODY_MB',
        { min: 1, max: 200, fallback: DEFAULT_MAX_BODY_MB },
        options.OPENCODE_PROXY_MAX_BODY_MB
    );
    MAX_BODY_MB = resolvedBodyLimit.value;
    if (resolvedBodyLimit.note) logger.warn(`[Config] ${resolvedBodyLimit.note}`);
    // The two backend timings follow the same precedence, and an unusable value is named for the same reason
    BACKEND_HEALTH_CACHE_MS = readMilliseconds(
        'OPENCODE_PROXY_HEALTH_CACHE_MS',
        2000,
        options.OPENCODE_PROXY_HEALTH_CACHE_MS
    );
    if (isUnusableMilliseconds(options.OPENCODE_PROXY_HEALTH_CACHE_MS ?? process.env.OPENCODE_PROXY_HEALTH_CACHE_MS)) {
        logger.warn(`[Config] OPENCODE_PROXY_HEALTH_CACHE_MS='${loggableConfigValue(String(options.OPENCODE_PROXY_HEALTH_CACHE_MS ?? process.env.OPENCODE_PROXY_HEALTH_CACHE_MS).trim())}' is not a number, using ${BACKEND_HEALTH_CACHE_MS}`);
    }
    BACKEND_START_RETRY_COOLDOWN_MS = readMilliseconds(
        'OPENCODE_PROXY_START_RETRY_MS',
        15000,
        options.OPENCODE_PROXY_START_RETRY_MS
    );
    if (isUnusableMilliseconds(options.OPENCODE_PROXY_START_RETRY_MS ?? process.env.OPENCODE_PROXY_START_RETRY_MS)) {
        logger.warn(`[Config] OPENCODE_PROXY_START_RETRY_MS='${loggableConfigValue(String(options.OPENCODE_PROXY_START_RETRY_MS ?? process.env.OPENCODE_PROXY_START_RETRY_MS).trim())}' is not a number, using ${BACKEND_START_RETRY_COOLDOWN_MS}`);
    }

    // Log level resolution (calibrated at startup; all later log output follows this level):
    // 1) LOG_LEVEL (options/env, case-insensitive) 2) when not explicitly set but the legacy DEBUG switch is on,
    // promote to debug (backward compatible) 3) default info; invalid values fall back to info with a warning
    let levelResolution = logger.setLevel(config.LOG_LEVEL);
    let levelSource = levelResolution.explicit ? 'LOG_LEVEL' : 'default';
    if (!levelResolution.valid) {
        logger.warn(`Invalid LOG_LEVEL '${loggableConfigValue(levelResolution.requested)}', fallback to 'info' (valid values: error/warn/info/debug)`);
    } else if (!levelResolution.explicit && config.DEBUG) {
        // setLevel() reports the promotion as explicit, so the source has to be recorded here: reading it back from
        // the resolved object claimed the operator had set LOG_LEVEL, which is not where `debug` came from.
        logger.setLevel('debug');
        levelSource = 'legacy DEBUG flag';
    } else if (config.DEBUG) {
        // The switch is set and loses to an explicit level, which used to happen in complete silence: an operator who
        // raised the detail with the documented switch got a `warn`-only log, and the summary line looked as if the
        // switch had never been needed. Same rule as every other knob that loses to a stronger source - and the
        // summary's source is annotated too, because a warning is itself invisible below the `warn` level.
        levelSource = `LOG_LEVEL (OPENCODE_PROXY_DEBUG is ignored)`;
        logger.warn(`[Config] OPENCODE_PROXY_DEBUG is set, but LOG_LEVEL='${logger.level}' selects the level explicitly - the switch is ignored (unset LOG_LEVEL to let it promote logging to debug)`);
    }
    backendUrl.notes.forEach((note) => logger.warn(`[Config] ${note}`));
    config.LOG_LEVEL = logger.level;

    const { app, client } = createApp(config);

    // Fastify resolves listen() once the server is bound; log and warm the backend from the continuation.
    // No await here so startProxy stays synchronous for callers that need the server handle immediately.
    // The bind and the warmup are exposed as `ready` instead of being a floating promise that called `process.exit(1)`
    // on failure: `startProxy()` is exported and documented as embeddable, and a library call that kills its host cannot
    // be caught, while the returned object gave no way to know when the server was listening. The entry point awaits it
    // and decides what a listen failure means (it exits with the same message and status as before).
    const ready = app.listen({ port: config.PORT, host: config.BIND_HOST })
        .then(async () => {
            logger.info(`Log level: ${logger.level} (source: ${levelSource})`);
            logger.info(`[Proxy] Active at http://${loggableConfigValue(config.BIND_HOST)}:${config.PORT}`);
            try {
                await ensureBackend(config, { force: true });
            } catch (error) {
                logger.error('[Proxy] Backend warmup failed:', loggableError(error));
            }
            // The 1.x warm-up read the backend's tool list here so the first completion did not pay for it. A 2.x server
            // has no tool-list route; `DISABLE_TOOLS` is a permission ruleset built per session, so there is nothing to
            // warm and no round trip to move off the first request.
        });
    // A caller that only holds `{ server, killBackend }` never awaits `ready`; an unobserved rejection would end the
    // process by default (unhandled rejection), which is the behaviour this change removes.
    ready.catch(() => { });

    // Deletes the sessions still in `liveSessions` (a completion interrupted by shutdown). Bounded by its own budget so
    // it fits inside the teardown budget below, and every call is best effort: a delete that fails or times out must not
    // delay the exit.
    const SHUTDOWN_SESSION_TIMEOUT_MS = 3000;
    // The whole teardown - a pending start attempt, this drain, and the SIGTERM/SIGKILL escalation of the child - gets
    // one budget. Every step used to spend its own, so the sum (3.5 s + 3 s + 3 s + 1 s) outlasted the hard exit in
    // `index.js`, which is a backstop meant to fire after the escalation had run: a backend that ignores SIGTERM
    // survived the gateway (measured: exit 0 at 5 008 ms, child still listening on the backend port).
    const SHUTDOWN_TEARDOWN_BUDGET_MS = 8000;
    // The escalation itself: SIGTERM, then SIGKILL once the grace has passed, then a bounded wait for the reaped child
    const SIGTERM_GRACE_MS = 3000;
    const SIGKILL_REAP_MS = 1000;
    const drainLiveSessions = async (budgetMs = SHUTDOWN_SESSION_TIMEOUT_MS) => {
        const deadline = Date.now() + budgetMs;
        let deleted = 0;
        let failed = 0;
        // One snapshot missed a session whose `session.create` answered after it was taken (a slow or busy backend, a
        // proxy in front of one): the completion added its id to a set nobody read again, and its own cleanup never
        // ran, so an external backend kept that session for good. The set is re-read while it is non-empty.
        while (liveSessions.size && Date.now() < deadline) {
            const ids = [...liveSessions];
            let deletedThisRound = 0;
            await Promise.all(ids.map(async (id) => {
                // A 2.x delete answers `204` with an empty body and rejects with a typed error on failure, so success is
                // "the call resolved" - testing `result.error` on the resolved value would have counted *every* delete
                // as a failure (there is no body to carry one), ended the loop on its first round and left every
                // interrupted session on an external backend for good.
                try {
                    await client.session.remove(
                        { sessionID: id },
                        backendDeadline(Math.max(1, Math.min(SHUTDOWN_SESSION_TIMEOUT_MS, deadline - Date.now())))
                    );
                    liveSessions.delete(id);
                    deletedThisRound += 1;
                } catch (error) {
                    // A session that is already gone needs no retry either: the 404 that says so is the answer.
                    const { status } = upstreamFailureReason(error);
                    if (status === 404 || status === 410) {
                        liveSessions.delete(id);
                        deletedThisRound += 1;
                    }
                }
            }));
            deleted += deletedThisRound;
            if (deletedThisRound === 0) {
                // Nothing was deleted: the backend refuses (or is gone). Retrying the same calls until the budget runs
                // out cannot turn a refusal into a success, so the remaining ids are reported once instead.
                failed = Math.max(0, ids.length - deletedThisRound);
                break;
            }
        }
        if (failed) {
            logger.warn('[Shutdown] Could not delete every session left by interrupted completions', {
                remaining: failed
            });
        }
        if (deleted && logger.isEnabled('debug')) {
            logger.debug('[Shutdown] Deleted the sessions left by interrupted completions', { count: deleted });
        }
    };

    // Expose the Fastify instance as `server`: it implements close(cb), which index.js uses for shutdown
    return {
        server: app,
        // Resolves once the server is listening (and the backend warmup has run); rejects when the bind failed, which
        // the caller reports. Never awaited by the gateway itself.
        ready,
        // Stops the backend and resolves once it is really gone. The entry point awaits this before exiting: it used
        // to send SIGTERM and call process.exit() on the next line, so the SIGKILL escalation below never ran and a
        // backend that ignores SIGTERM outlived the gateway that owns it.
        killBackend: () => {
            const state = backendState.get(config.OPENCODE_SERVER_URL);
            if (!state) return Promise.resolve();
            // The jail directory is the child's cwd, so it goes only after the child is gone
            const removeJail = () => {
                if (!state.jailRoot) return;
                const jail = state.jailRoot;
                try {
                    fs.rmSync(jail, { recursive: true, force: true });
                    ownedJailRoots.delete(jail);
                } catch (e) { }
            };
            // SIGTERM, then SIGKILL after the grace: a backend that ignores SIGTERM must not survive the gateway. Both
            // timers are unref'd so they cannot hold the process open, and the child keeps the loop alive while it still
            // runs. The grace shrinks when the steps before it used up the teardown budget, so the escalation always
            // runs before `index.js` gives up on it.
            const terminate = (child, graceMs = SIGTERM_GRACE_MS) => new Promise((resolve) => {
                let settled = false;
                let killTimer = null;
                let graceTimer = null;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    if (killTimer) clearTimeout(killTimer);
                    if (graceTimer) clearTimeout(graceTimer);
                    resolve();
                };
                child.once('exit', finish);
                try {
                    child.kill('SIGTERM');
                } catch (e) {
                    // already gone
                    finish();
                    return;
                }
                killTimer = setTimeout(() => {
                    if (child.exitCode !== null || child.signalCode !== null) {
                        finish();
                        return;
                    }
                    try {
                        child.kill('SIGKILL');
                    } catch (e) {
                        finish();
                        return;
                    }
                    // A killed child still has to be reaped; stop waiting if the exit event does not arrive
                    graceTimer = setTimeout(finish, SIGKILL_REAP_MS);
                    graceTimer.unref();
                }, Math.max(0, graceMs));
                killTimer.unref();
            });
            return (async () => {
                // Tell any start attempt in flight to stop: one that is still waiting on a health probe (or on the
                // previous child) would otherwise spawn a backend after this function resolved and after the gateway
                // exited, leaving an orphaned `opencode serve` that holds the backend port. The attempt notices the flag
                // at its next checkpoint and throws instead.
                state.shuttingDown = true;
                const deadline = Date.now() + SHUTDOWN_TEARDOWN_BUDGET_MS;
                const remaining = () => Math.max(0, deadline - Date.now());
                if (state.isStarting) await waitForPendingStart(state);
                // Before the child goes, and before this process exits: a completion interrupted by shutdown never
                // reached its `cleanupSession()`, so its session is still in the backend's store. Deleting it here is
                // the only chance there is (an external backend outlives the gateway), and it is best effort with the
                // shutdown budget below - a backend that is already unhealthy must not turn shutdown into a wait.
                await drainLiveSessions(Math.min(SHUTDOWN_SESSION_TIMEOUT_MS, remaining()));
                const child = state.process;
                if (child && child.exitCode === null && child.signalCode === null) {
                    // Whatever the steps above left, minus the bounded wait for the reaped child: SIGKILL is scheduled
                    // inside the budget even when a slow drain ate most of it.
                    await terminate(child, Math.min(SIGTERM_GRACE_MS, remaining() - SIGKILL_REAP_MS));
                }
                removeJail();
            })();
        }
    };
}
