import Fastify from 'fastify';
import { spawn } from 'child_process';
import { createOpencodeClient } from '@opencode-ai/sdk';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { timingSafeEqual, randomBytes } from 'crypto';
import { logger, maskBackendUrl, maskDetail, maskHeaders, maskQuotedCredentials, maskUrlCredentials, maskUrlQuery, setOwnProperty } from './logger.js';


// --- Mutex Logic with Timeout ---
const queue = [];

const STARTUP_WAIT_ITERATIONS = 60;
const STARTUP_WAIT_INTERVAL_MS = 2000;
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
/**
 * The message for a phase that ran into its deadline.
 * `remainingBudget()` floors what is left at 1 ms so a timer never gets 0 or a negative value, and interpolating that
 * floor into the message told a client and the log that a 1 500 ms request budget had timed out "after 1ms": an
 * operator reading `docker logs` could not tell a 1.5 s timeout from a 300 s one. A phase that is handed the floor was
 * given nothing to wait with, so the message says that instead of reporting the floor as if it were the budget.
 */
export const timeoutMessage = (timeoutMs) => (timeoutMs <= 1
    ? 'Request timeout: the request budget was used up'
    : `Request timeout after ${timeoutMs}ms`);
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
// How long a written response may take to leave before its socket is destroyed. `socket.destroy()` discards buffered
// writes, so a response that is written and then destroyed in the same tick can be lost entirely.
const SOCKET_CLOSE_TIMEOUT_MS = 250;
// After the idle timeout the gateway polls for the rest of the answer; this is how many identical polls (a full idle
// window worth) that recovery tolerates before it accepts a message the backend never marks finished.
const IDLE_RECOVERY_STALL_POLLS = Math.max(3, Math.ceil(DEFAULT_EVENT_IDLE_TIMEOUT_MS / DEFAULT_POLL_INTERVAL_MS));

// Two completions that reach this counter in the same millisecond used to receive the same
// `chatcmpl-<epoch>` id (a client that keys its messages by id merged two answers); the counter keeps ids distinct
// without a random source, and the millisecond stamp keeps them roughly sortable.
let completionIdSeq = 0;
const newCompletionId = () => `chatcmpl-${Date.now().toString(36)}${String(completionIdSeq++).padStart(3, '0')}`;

// `socket.destroy()` throws away whatever is still buffered in userland, so a response that is written and then
// destroyed in the same tick can be lost: the client sees a reset instead of the envelope. `end()` flushes and closes,
// and the fallback timer only destroys a socket whose close never completes (a peer that stopped reading).
const closeSocketAfterFlush = (socket) => {
    if (!socket || socket.destroyed) return;
    if (socket.writableEnded) {
        // Everything was already handed to the kernel by an earlier end(): there is nothing left to flush, and the
        // socket has to go now because the client is still sending a body that will never be read.
        socket.destroy();
        return;
    }
    const forceClose = () => {
        if (!socket.destroyed) socket.destroy();
    };
    const timer = setTimeout(forceClose, SOCKET_CLOSE_TIMEOUT_MS);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    try {
        socket.end();
    } catch (error) {
        forceClose();
    }
};

// One log line is one record. A client-controlled value carrying a newline would be read as a *second* record (a
// forged request summary, a fake `[Security]` or `[Shutdown]` line), an ANSI escape would reach the operator's
// terminal and the log shipper, and an unbounded value would turn one request body into an arbitrarily large log
// record - a 2 MB model id produced a 2 MB info line. The values are normalised for logging only; the backend still
// receives the id verbatim, because the contract does not restrict model ids.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const MAX_LOGGED_MODEL_LENGTH = 128;
const MAX_LOGGED_URL_LENGTH = 512;
const loggableModelId = (id) => {
    const clean = String(id).replace(CONTROL_CHARS_RE, '?');
    return clean.length > MAX_LOGGED_MODEL_LENGTH ? `${clean.slice(0, MAX_LOGGED_MODEL_LENGTH)}…` : clean;
};
// The same treatment for the request URL, which every log site used to copy raw: credential query values are masked
// (`?api_key=…` is an OpenAI-compatible convention some clients still send) and an unbounded URL is cut, because the
// URL is client input bounded only by the HTTP parser's header limit.
const loggableUrl = (url) => {
    const masked = maskUrlQuery(url);
    return masked.length > MAX_LOGGED_URL_LENGTH
        ? `${masked.slice(0, MAX_LOGGED_URL_LENGTH)}…[truncated ${masked.length - MAX_LOGGED_URL_LENGTH} chars]`
        : masked;
};

// The request target without its query string, which the access log and the 404 body want. `url.split('?')[0]`
// allocated an array plus a second string on every request - including the ones that carry no query at all - where an
// index scan answers the same value with no allocation in the common `no '?'` case.
const urlPath = (url) => {
    const query = url.indexOf('?');
    return query === -1 ? url : url.slice(0, query);
};


// Upstream text on its way to a client or a log line: masked and bounded. Module scope because the top-level error
// handler writes 5xx sentences too, and those are written by whatever threw.
//
// A backend (or a proxy in front of it) can quote a URL inside an error payload, and a configured backend URL may
// carry a credential - Node's `fetch` answered `Request cannot be constructed from a URL that includes
// credentials: http://user:secret@host:4097/session`, which reached the client-facing 502 body and this process's
// log verbatim. The query string is masked for the same reason it is masked on a request URL, and the length is
// bounded so a backend cannot answer a client with a reason the size of the request body limit.
const MAX_UPSTREAM_TEXT_CHARS = 512;
// Only the URL-shaped words of the text are masked. `maskUrlQuery()` is written for a URL: given a sentence it
// read everything after the first `?` as that parameter's value, so `…?x=1: connection refused` answered
// `…?x=***` and lost the half of the reason that explains the failure.
//
// The words are found by splitting on whitespace rather than with `/\S+:\/\/\S+/`, which backtracked over a
// million-character token with no `://` in it one character at a time: a provider error of 1 MB parked the request
// for longer than its whole budget. `includes('://')` decides per token, and a token is at most a word.
const maskUrlsInText = (text) => {
    const value = String(text);
    if (!value.includes('://')) return value;
    return value
        .split(/(\s+)/)
        .map((token) => (token.includes('://') ? maskUrlQuery(maskUrlCredentials(token)) : token))
        .join('');
};
export const clientFacingText = (value) => {
    if (typeof value !== 'string' || value === '') return '';
    // A URL is not the only credential an upstream can quote: a proxy in front of the backend can echo the
    // `Authorization: Basic …` header it refused, and that token is the credential the gateway lifted out of
    // `OPENCODE_SERVER_URL`.
    const masked = maskQuotedCredentials(maskUrlsInText(value));
    return masked.length > MAX_UPSTREAM_TEXT_CHARS
        ? `${masked.slice(0, MAX_UPSTREAM_TEXT_CHARS)}…[truncated ${masked.length - MAX_UPSTREAM_TEXT_CHARS} chars]`
        : masked;
};

/**
 * The sentence a failed completion shows a client and logs, read from whatever the route handler caught.
 *
 * `error.message` is the usual shape, but the handler can also be rejected with something else - a thrown string, an
 * object without a `message`, a library that throws `undefined` - and reading `.message` off that put `undefined` in
 * the body of a `500`. Masked by `clientFacingText()` when there is anything to mask, and otherwise kept exactly as it
 * arrived: an empty message stays empty instead of becoming the word `Error`, which would invent a cause.
 * @param {*} error whatever was thrown or rejected with
 * @returns {string} the sentence to send and log
 */
export const handlerFailureMessage = (error) => {
    const raw = typeof error?.message === 'string' ? error.message : String(error);
    return clientFacingText(raw) || raw;
};

// A client-supplied value on its way into a response body, under one rule.
//
// The `415` media-type message already replaced control characters and cut the echoed type; the other sites copied the
// value through verbatim, so a 4,000-character content-part type produced a 4,000-character error body, and a value
// carrying a newline put a second line into a body the client reads as one record. The marker matches
// `loggableUrl()`, so a truncated value reads the same wherever it appears.
// The endpoints a client that hit the wrong path is looking for, in one place: the 404 message names them and the
// smoke suite asserts the message carries this exact list. Each entry carries its method, because the same request
// reaches this handler when the path is right and the method is not (`PUT /v1/chat/completions`), and a list without
// methods answered that case with the path it had just declared missing.
const SERVED_ROUTES = 'POST /v1/chat/completions, GET /v1/models and GET /health';
const MAX_ECHOED_VALUE_LENGTH = 64;
const echoedValue = (value) => {
    const clean = String(value).replace(CONTROL_CHARS_RE, '?');
    return clean.length > MAX_ECHOED_VALUE_LENGTH
        ? `${clean.slice(0, MAX_ECHOED_VALUE_LENGTH)}…[truncated ${clean.length - MAX_ECHOED_VALUE_LENGTH} chars]`
        : clean;
};

// An operator-supplied value on its way into a log line, under the rule `loggableModelId()` applies to client input.
//
// `config.json` and the environment are text a script can write, so a value carrying a newline starts a second log
// record the gateway never wrote - the same forgery class as a model id, and these lines quote the value so the
// operator can see what was in force (a path typo, a misspelled level). The value is kept; it just stays on one line
// and bounded.
const MAX_LOGGED_CONFIG_LENGTH = 128;
export const loggableConfigValue = (value) => {
    const clean = String(value).replace(CONTROL_CHARS_RE, '?');
    return clean.length > MAX_LOGGED_CONFIG_LENGTH
        ? `${clean.slice(0, MAX_LOGGED_CONFIG_LENGTH)}…[truncated ${clean.length - MAX_LOGGED_CONFIG_LENGTH} chars]`
        : clean;
};

/**
 * The type of a value from a request body as a word, for an error message that names what arrived. `Array.isArray`
 * comes first because `typeof []` is 'object': the reader of "found an object" would be told the field they sent is
 * the wrong kind of object without ever learning what it actually was.
 */
function jsonTypeName(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    const type = typeof value;
    if (type === 'object') return 'an object';
    if (type === 'number') return 'a number';
    if (type === 'boolean') return 'a boolean';
    if (type === 'string') return 'a string';
    return type;
}

// Authentication is mandatory by design: when API_KEY is missing or blank the gateway falls back to this
// built-in key instead of running without authentication.
export const DEFAULT_API_KEY = 'sk-dummy-123';

export const resolveApiKey = (value) => {
    const key = value === undefined || value === null ? '' : String(value).trim();
    return key || DEFAULT_API_KEY;
};

/**
 * Boolean option parsing shared by the entry point and startProxy, so the two cannot disagree about what
 * `DISABLE_TOOLS=yes` means. Numbers follow JavaScript truthiness (`1` is on, `0` off); an unrecognised value
 * returns the fallback instead of being coerced.
 */
export function parseBoolean(value, fallback = undefined) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return fallback;
}

/**
 * A boolean option read from the environment or `config.json`, with the rule the numeric tuning keys follow: a value
 * that is present but cannot be read is named together with the value actually used, instead of falling back in
 * silence. `DISABLE_TOOLS: "maybe"` (or `OPENCODE_PROXY_DEBUG=ture`) used to leave the feature off while the operator
 * believed it was on - and for DISABLE_TOOLS that means the model's `<function_calls>` markup reaches the client,
 * which is exactly what the switch exists to hide. `parseBoolean()` stays the single parser; this only reports.
 */
export function readFlag(label, value, fallback) {
    const parsed = parseBoolean(value, undefined);
    if (parsed !== undefined) return parsed;
    if (value === undefined || value === null) return fallback;
    const shown = String(value).trim();
    if (shown === '') return fallback;
    // The value is operator input and the line is one log record: control characters out, length bounded
    logger.warn(
        `[Config] ${label}='${loggableConfigValue(shown)}' is not a boolean ` +
        `(use true/false, yes/no, on/off or 1/0), using ${fallback}`
    );
    return fallback;
}

const OPENCODE_BASENAME = 'opencode';

function splitPathEnv() {
    const raw = process.env.PATH || '';
    return raw.split(path.delimiter).filter(Boolean);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushDir(list, dir) {
    if (!dir) return;
    if (!list.includes(dir)) list.push(dir);
}

function pushExistingDir(list, dir) {
    if (!dir) return;
    if (!fs.existsSync(dir)) return;
    if (!list.includes(dir)) list.push(dir);
}

function addVersionedDirs(list, baseDir, subpath) {
    if (!baseDir || !fs.existsSync(baseDir)) return;
    let entries = [];
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (e) {
        return;
    }
    entries.forEach((entry) => {
        if (!entry.isDirectory()) return;
        const full = path.join(baseDir, entry.name, subpath || '');
        pushExistingDir(list, full);
    });
}

function prefixToBin(prefix) {
    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

function getOpencodeCandidateNames() {
    if (process.platform === 'win32') {
        return [`${OPENCODE_BASENAME}.cmd`, `${OPENCODE_BASENAME}.exe`, `${OPENCODE_BASENAME}.bat`, OPENCODE_BASENAME];
    }
    return [OPENCODE_BASENAME];
}

function findExecutableInDirs(dirs, names) {
    for (const dir of dirs) {
        for (const name of names) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) {
                return full;
            }
        }
    }
    return null;
}

function resolveOpencodePath(requestedPath) {
    const input = (requestedPath || '').trim();
    const names = getOpencodeCandidateNames();

    if (input) {
        const looksLikePath = path.isAbsolute(input) || input.includes('/') || input.includes('\\');
        if (looksLikePath) {
            if (fs.existsSync(input)) return { path: input, source: 'config' };
            const resolved = path.resolve(process.cwd(), input);
            if (fs.existsSync(resolved)) return { path: resolved, source: 'config' };
            // A configured path that does not exist is almost always a typo or a moved installation. Say so: the
            // PATH search below would otherwise hide it behind a binary the operator did not choose
            logger.warn(`[Proxy] OPENCODE_PATH '${loggableConfigValue(input)}' does not exist; using the OpenCode found on PATH instead`);
        }
    }

    const pathDirs = splitPathEnv();
    const fromPath = findExecutableInDirs(pathDirs, names);
    if (fromPath) return { path: fromPath, source: 'PATH' };

    const extraDirs = [];
    if (process.env.OPENCODE_HOME) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_HOME, 'bin'));
    }
    if (process.env.OPENCODE_DIR) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_DIR, 'bin'));
    }
    pushDir(extraDirs, prefixToBin(process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX));
    pushDir(extraDirs, process.env.PNPM_HOME);
    if (process.env.YARN_GLOBAL_FOLDER) {
        pushDir(extraDirs, path.join(process.env.YARN_GLOBAL_FOLDER, 'bin'));
    }
    if (process.env.VOLTA_HOME) {
        pushDir(extraDirs, path.join(process.env.VOLTA_HOME, 'bin'));
    }
    pushDir(extraDirs, process.env.NVM_BIN);
    pushDir(extraDirs, path.dirname(process.execPath));

    const home = os.homedir();
    if (home) {
        pushDir(extraDirs, path.join(home, '.opencode', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm', 'bin'));
        pushDir(extraDirs, path.join(home, '.pnpm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'share', 'pnpm'));
        pushDir(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1', 'installations'));
        pushDir(extraDirs, path.join(home, '.asdf', 'shims'));
    }

    if (process.platform === 'win32') {
        pushDir(extraDirs, process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null);
        pushDir(extraDirs, process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : null);
        pushDir(extraDirs, process.env.NVM_HOME);
        pushDir(extraDirs, process.env.NVM_SYMLINK);
        pushDir(extraDirs, process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : null);
        pushDir(extraDirs, process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs') : null);
    } else {
        pushDir(extraDirs, '/usr/local/bin');
        pushDir(extraDirs, '/usr/bin');
        pushDir(extraDirs, '/bin');
        pushDir(extraDirs, '/opt/homebrew/bin');
        pushDir(extraDirs, '/snap/bin');
    }

    // nvm (unix) versions
    const nvmDir = process.env.NVM_DIR || (home ? path.join(home, '.nvm') : null);
    if (nvmDir) {
        addVersionedDirs(extraDirs, path.join(nvmDir, 'versions', 'node'), 'bin');
    }

    // asdf nodejs installs
    const asdfDir = process.env.ASDF_DATA_DIR || (home ? path.join(home, '.asdf') : null);
    if (asdfDir) {
        addVersionedDirs(extraDirs, path.join(asdfDir, 'installs', 'nodejs'), 'bin');
    }

    // fnm installs
    if (home) {
        addVersionedDirs(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1'), 'installation' + path.sep + 'bin');
    }

    const fromExtras = findExecutableInDirs(extraDirs, names);
    if (fromExtras) return { path: fromExtras, source: 'known-locations' };

    return { path: null, source: 'not-found' };
}

// A backend URL that ends in a slash makes every SDK call a path with a double slash (`//session`), which an
// OpenCode server answers with 404: the gateway then looks like it cannot start its backend at all. Normalising the
// value once at startup is cheaper than wondering why nothing works. Exported so the entry point can normalise before
// it prints the startup summary: the summary is where an operator copies the value from, and it used to show the raw
// form - a trailing slash or a trailing space the gateway never used - right beside a note saying it was corrected.
export function normalizeBackendUrl(raw) {
    let url = String(raw || '').trim();
    const notes = [];
    if (url === '') return { url: 'http://127.0.0.1:4097', notes };
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
        notes.push(`OPENCODE_SERVER_URL='${maskBackendUrl(url)}' has no scheme, assuming http://`);
        url = `http://${url}`;
    }
    const stripped = url.replace(/\/+$/, '');
    if (stripped !== url) {
        notes.push(`OPENCODE_SERVER_URL had a trailing slash, using '${maskBackendUrl(stripped)}'`);
        url = stripped;
    }
    return { url, notes };
}

// Reads an integer limit through the documented precedence (environment, then config.json, then the default). A value
// that cannot be used must not look like it took effect: an operator who raises OPENCODE_PROXY_MAX_CONCURRENCY (a
// throughput knob) and sees no change has no way to tell a typo from a clamp, so every adjustment is kept as a note
// for the startup summary.
function readLimit(name, { min, max, fallback }, fileValue) {
    const fromEnv = process.env[name];
    const raw = (fromEnv === undefined || String(fromEnv).trim() === '') ? fileValue : fromEnv;
    if (raw === undefined || raw === null || String(raw).trim() === '') return { value: fallback, note: null };
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return { value: fallback, note: `${name}='${loggableConfigValue(raw)}' is not a number, using ${fallback}` };
    }
    const floored = Math.floor(parsed);
    if (floored < min) return { value: min, note: `${name}=${floored} is below the minimum ${min}, using ${min}` };
    if (floored > max) return { value: max, note: `${name}=${floored} is above the maximum ${max}, using ${max}` };
    return { value: floored, note: null };
}

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
        reject(new Error(timeoutMessage(timeoutMs)));
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
            reject(new Error(`Request timeout after ${timeout}ms waiting for a free completion slot`));
        }, timeout);
        queue.push(entry);
        processQueue();
    });
}

// Keep-alive socket for backend health probes: a fresh connection per chat request is measurable overhead.
// A remote (https) OPENCODE_SERVER_URL needs its own agent, otherwise the probe cannot even be sent.
const healthAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const healthAgentSecure = new https.Agent({ keepAlive: true, maxSockets: 4 });

// Credentials lifted out of OPENCODE_SERVER_URL by resolveBackendAuth(); the probe sends them the same way the SDK
// does, otherwise a backend behind a credential-requiring proxy answers the probe with 401 and the gateway concludes
// its backend is gone (and tries to start a local one).
let BACKEND_AUTHORIZATION = null;

/**
 * Split a configured backend URL into the URL the SDK is given and the header that carries its credentials.
 *
 * `http://user:secret@host:4097` - a proxy in front of the backend - was documented as supported but could not work:
 * every SDK call goes through Node's `fetch`, which refuses a URL with credentials ("Request cannot be constructed
 * from a URL that includes credentials: …"), so every completion answered `502` and the runtime's message carried the
 * secret into that response body and into the error log. The userinfo is therefore removed from the URL (which is
 * what the masking in `maskBackendUrl()` already assumed the gateway was doing) and sent as a Basic `Authorization`
 * header instead, which is what such a proxy reads.
 * @param {string} serverUrl normalised backend URL
 * @returns {{url: string, authorization: string|null}}
 */
export function resolveBackendAuth(serverUrl) {
    const raw = String(serverUrl);
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        // Not a URL the gateway can parse: leave it exactly as configured and let the caller report the failure
        return { url: raw, authorization: null };
    }
    if (!parsed.username && !parsed.password) return { url: raw, authorization: null };
    let user = parsed.username;
    let password = parsed.password;
    try {
        user = decodeURIComponent(user);
        password = decodeURIComponent(password);
    } catch {
        // Keep the percent-encoded form when it is not valid encoding (the credential is still well defined)
    }
    const scheme = `${parsed.protocol}//`;
    const authority = raw.slice(scheme.length).split(/[/?#]/)[0];
    const withoutUserInfo = `${scheme}${authority.slice(authority.lastIndexOf('@') + 1)}${raw.slice(scheme.length + authority.length)}`;
    return { url: withoutUserInfo, authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}` };
}

/**
 * Robust Health Check Helper
 */
function checkHealth(serverUrl, authorization = BACKEND_AUTHORIZATION) {
    const secure = String(serverUrl).startsWith('https://');
    const transport = secure ? https : http;
    return new Promise((resolve, reject) => {
        const options = { agent: secure ? healthAgentSecure : healthAgent };
        if (authorization) options.headers = { authorization };
        const req = transport.get(`${serverUrl}/health`, options, (res) => {
            // Drain the body so the socket goes back to the keep-alive pool
            res.resume();
            if (res.statusCode === 200) resolve(true);
            else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

// How long a successful health probe is trusted before the next one (0 disables the cache). Resolved again by
// startProxy() from the merged configuration, so a value in config.json is honoured and not silently ignored - the
// README documents every tuning key as env > config.json > default.
// A value that cannot be used is reported by the caller (startProxy logs it): silently running with the default is the
// failure mode readLimit() was written to end for the queue knobs - an operator who typo'd the request budget had
// nothing to notice while the gateway kept using 300000 ms.
const readMilliseconds = (name, fallback, fileValue) => {
    const fromEnv = process.env[name];
    const raw = (fromEnv === undefined || String(fromEnv).trim() === '') ? fileValue : fromEnv;
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
};

// True when a configured millisecond value is present but unusable (so startProxy can name it and the value it used)
const isUnusableMilliseconds = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') return false;
    const parsed = Number(value);
    return !Number.isFinite(parsed) || parsed < 0;
};

let BACKEND_HEALTH_CACHE_MS = readMilliseconds('OPENCODE_PROXY_HEALTH_CACHE_MS', 2000);

// After a failed start attempt (missing binary, backend never became healthy) requests fail fast for this long
// instead of repeating a multi-minute startup wait on every single request
let BACKEND_START_RETRY_COOLDOWN_MS = readMilliseconds('OPENCODE_PROXY_START_RETRY_MS', 15000);

// A wedged backend - one that still answers /health but never answers /session - used to hang the request handler
// forever: node's fetch has no default timeout, so the SDK promise never settled, the client waited with no answer and
// the queue slot was never released (at the default concurrency of 1 that stops the whole gateway). Every SDK call
// now carries a deadline, and an expired one is reported as a gateway timeout.
const backendDeadline = (timeoutMs) => ({ signal: AbortSignal.timeout(timeoutMs) });
// Metadata calls (the model list, the tool list) are cheap round trips, so their budget is capped well below the
// request budget: a client listing models should get the static fallback quickly instead of waiting for a whole
// completion to time out.
const METADATA_TIMEOUT_CAP_MS = 10000;
const isTimeoutError = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError' ||
    error?.code === 'ETIMEDOUT';

const isConnectionError = (error) => {
    const message = String(error?.message || '');
    return message.includes('fetch failed') ||
        message.includes('ECONNREFUSED') ||
        message.includes('socket hang up') ||
        error?.cause?.code === 'ECONNREFUSED';
};

// Jail directories this process created. Another gateway (a second instance, or one in a container sharing /tmp)
// may be using the same parent directory, so the exit hook must never delete a directory it does not own.
const ownedJailRoots = new Set();

/**
 * Removes the jail directories this process created. This runs on process exit, so it cannot rely on
 * killBackend() having been called.
 */
function cleanupTempDirs() {
    // On Windows no jail is used (path issues), so there is nothing to remove
    if (process.platform === 'win32') return;

    for (const jailRoot of ownedJailRoots) {
        try {
            fs.rmSync(jailRoot, { recursive: true, force: true });
        } catch (e) {
            logger.error('[Cleanup] Failed to remove temp dirs:', { error: e.message });
        }
    }
    ownedJailRoots.clear();
    // The parent only disappears once the last instance is gone; a leftover one is harmless
    try {
        fs.rmdirSync(path.join(os.tmpdir(), 'opencode-proxy-jail'));
    } catch (e) {
        // not empty or already gone: expected when another instance is still running
    }
}

// Register cleanup on exit
process.on('exit', cleanupTempDirs);

// Signal handling is owned by the entry point (index.js): it kills the backend and closes the HTTP server
// gracefully. Registering an exit-on-signal handler here would run first and cut that shutdown short.

/**
 * Best-effort extraction of the status code and error-body summary from an upstream (opencode serve) call error.
 * The SDK error shape may change between versions; common fields are supported:
 * response.{status,data} / status / statusCode / responseBody / data / body
 */
function extractUpstreamError(error) {
    const status = error?.response?.status ?? error?.status ?? error?.statusCode ?? null;
    const body = error?.response?.data ?? error?.responseBody ?? error?.data ?? error?.body ?? null;
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
    const { API_KEY, OPENCODE_SERVER_URL, REQUEST_TIMEOUT_MS, DISABLE_TOOLS } = config;

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
        const mapped = CLIENT_ERROR_STATUS[error?.code];
        const status = mapped ? mapped.status : 400;
        const reason = mapped ? mapped.reason : 'Malformed HTTP request';
        // The error code is the useful part for support; the message can carry raw bytes from the request, so it is
        // not logged (a log line is one record and must not be forgeable by a malformed client)
        const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : undefined;
        const reqId = `gw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        logger.warn(`[Proxy] Rejected malformed request: ${error?.code || 'parse error'}`);
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
        const reqId = `gw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // The path is the client's own bytes: truncated and stripped of anything that could forge a log line
        logger.warn(`[Proxy] Rejected a URL that cannot be decoded: ${loggableUrl(urlPath(String(path ?? '')))}`);
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
    BACKEND_AUTHORIZATION = backendAuth.authorization;
    const client = createOpencodeClient({
        baseUrl: backendAuth.url,
        ...(backendAuth.authorization ? { headers: { authorization: backendAuth.authorization } } : {})
    });

    // Precomputed once: comparing against a ready-made buffer avoids rebuilding the token on every request.
    // resolveApiKey() guarantees a non-empty key, so authentication can never be switched off.
    const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
    // The incoming X-Request-Id, if it is usable as-is (see the note where it is used)
    const requestId = (request) => {
        const raw = request.headers['x-request-id'];
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        return CLIENT_REQUEST_ID_RE.test(trimmed) ? trimmed : null;
    };

    const apiKeyToken = resolveApiKey(API_KEY);
    const apiKeyTokenBuffer = Buffer.from(apiKeyToken);
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
        const disarm = () => {
            clearTimeout(timer);
            raw.off('end', disarm);
            raw.off('close', disarm);
            raw.off('error', disarm);
        };
        const timer = setTimeout(() => {
            disarm();
            logger.warn('[Proxy] Request body did not arrive within its deadline, closing the connection', {
                reqId: meta.reqId,
                method: request.method,
                ms: bodyReceiveDeadlineMs
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
                            message: `request body was not received within ${bodyReceiveDeadlineMs}ms; send the declared body or close the connection`,
                            type: 'invalid_request_error'
                        }
                    });
                } catch (error) {
                    // The reply is already owned by someone else: closing the connection is what matters
                }
            }
            closeSocketAfterFlush(socket);
        }, bodyReceiveDeadlineMs);
        timer.unref();
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
        const matchesToken = (provided) => {
            if (typeof provided !== 'string' || provided.length !== apiKeyToken.length) return false;
            const providedBuffer = Buffer.from(provided);
            return providedBuffer.length === apiKeyTokenBuffer.length && timingSafeEqual(providedBuffer, apiKeyTokenBuffer);
        };

        // `Authorization: Bearer <key>` is the contract; the scheme is case-insensitive per RFC 7235, and a client
        // that sends `bearer <key>`, `BEARER <key>` or `Bearer   <key>` (extra whitespace) is not wrong. `X-Api-Key`
        // is accepted as an alias because the preflight above advertises it and clients configured with an api-key
        // header send it. Presence decides, not a parsed token: an `Authorization` header that is present always
        // wins, so a wrong one - or one a proxy injected with another scheme - is never overridden by the alias.
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
    const TOOL_IDS_TIMEOUT_MS = MODELS_TIMEOUT_MS;
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
    const loadModels = async () => {
        const now = Date.now();
        if (modelsCache && now - modelsCacheAt < MODELS_CACHE_TTL_MS) {
            return modelsCache.data;
        }
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
            const providersRes = await client.config.providers(backendDeadline(MODELS_TIMEOUT_MS));
            // The SDK resolves a rejected call with `{ error, response }` instead of throwing, so reading `.data` alone
            // made a refused provider call ("upstream answered 500", "the backend is gone") report itself as "the
            // backend reported no models" - the one SDK call in the gateway whose error tuple was never inspected.
            if (providersRes && providersRes.error) {
                const { status, reason } = upstreamFailureReason(providersRes);
                logger.warn(
                    `[Proxy] The backend rejected the provider listing${status ? ` (status ${status})` : ''}${reason}, using the static fallback`
                );
                return serveFallback();
            }
            const providersRaw = providersRes.data?.providers || [];
            const models = [];
            const list = Array.isArray(providersRaw)
                ? providersRaw
                : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));
            if (list.length === 0) {
                // A backend whose provider payload the gateway cannot read (a changed shape, a version that reports
                // nothing) answered 200 with no models. Serving `{"data":[]}` is as useless to a client as an error -
                // clients show no models at all - so an empty list takes the same fallback path and is not cached.
                logger.warn('[Proxy] The backend reported no models, using the static fallback');
                return serveFallback();
            }

            list.forEach((p) => {
                if (p.models) {
                    Object.entries(p.models).forEach(([mId, mData]) => {
                        models.push({
                            id: `${p.id}/${mId}`,
                            name: mData.name || mId,
                            object: 'model',
                            owned_by: p.id
                        });
                    });
                }
            });
            if (models.length === 0) {
                // Providers the gateway cannot read a model out of (no `models` map, an empty one, a changed shape)
                // answer 200 with nothing to choose from: that takes the same fallback path as an empty provider
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
        // A fresh cache answers with the body built when it was filled (Fastify sends a string payload as it is, the
        // way `/health` and `/` do); a cold cache takes the object path, which is also what the fallback uses
        if (modelsCache && Date.now() - modelsCacheAt < MODELS_CACHE_TTL_MS) {
            return reply.type('application/json; charset=utf-8').send(modelsCacheBody);
        }
        return { object: 'list', data: await loadModels() };
    });

    // OpenAI clients (and several SDKs) look a model up by id. The gateway does not restrict the model a chat
    // request may use, so an id that is not in the provider list is described here instead of being a 404.
    const describeModel = async (requestedId) => {
        // The map is only as fresh as the cache it was built with, so a by-id request that finds the cache expired
        // reloads the listing (one backend round trip, like the listing route) instead of answering from a stale map
        const known = modelsCache && modelsById && Date.now() - modelsCacheAt < MODELS_CACHE_TTL_MS
            ? modelsById.get(requestedId)
            : (await loadModels()).find((m) => m.id === requestedId);
        if (known) return known;
        // The default model answers with its own name even when a healthy backend lists other models: it is the id a
        // request that omits `model` is sent to, so it should not be described as the bare id-derived `big-pickle`.
        if (requestedId === DEFAULT_MODEL_ID) return DEFAULT_MODEL;
        const slash = requestedId.indexOf('/');
        const provider = slash > 0 ? requestedId.slice(0, slash) : 'opencode';
        const name = slash > 0 ? requestedId.slice(slash + 1) : requestedId;
        return { id: requestedId, name, object: 'model', owned_by: provider };
    };
    const modelByIdSchema = { schema: { response: { 200: MODEL_SCHEMA } } };
    // An id whose last segment is empty addresses no model: `/v1/models/%2F` and `/v1/models/opencode%2F` reached the
    // routes below with `/` and `opencode/` and were described as models with an empty (or separator) name - the same
    // class of non-model the blank id was.
    const isDescribableModelId = (id) => Boolean(id && id.split('/').pop());
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
    const logDebug = (...args) => logger.debug(...args);

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
     * opencode >= 1.19 sends no delta: `part.text` is the part's current full text, so the increment is that text
     * minus the previous snapshot of the same part. Two details matter. The snapshot is tracked **per part**: it used
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
        // Splits text into the part that can be written out and the suffix that could still become a tag
        const splitAtPossibleTag = (text) => {
            for (let length = Math.min(text.length, MAX_HELD); length > 0; length -= 1) {
                const tail = text.slice(text.length - length);
                if (OPEN_TAG.startsWith(tail) || CLOSE_TAG.startsWith(tail)) {
                    return [text.slice(0, text.length - length), tail];
                }
            }
            return [text, ''];
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
                        // Inside a block the text is dropped; only a partial closing tag is worth keeping
                        held = splitAtPossibleTag(buffer)[1];
                        return output;
                    }
                    buffer = buffer.slice(endIdx + CLOSE_TAG.length);
                    inBlock = false;
                    continue;
                }
                const startIdx = buffer.indexOf(OPEN_TAG);
                if (startIdx === -1) {
                    const [emit, tail] = splitAtPossibleTag(buffer);
                    held = tail;
                    return output + emit;
                }
                output += buffer.slice(0, startIdx);
                buffer = buffer.slice(startIdx + OPEN_TAG.length);
                inBlock = true;
            }
            return output;
        };
        // End of stream: a held fragment turned out not to be a tag
        filter.flush = () => {
            if (inBlock) return '';
            const rest = held;
            held = '';
            return rest;
        };
        return filter;
    };

    const TOOL_IDS_CACHE_MS = 5 * 60 * 1000;
    // A failed lookup must not be retried on every request: without this a broken /tool/ids endpoint adds one failed
    // round trip to every completion
    const TOOL_IDS_FAILURE_TTL_MS = 60 * 1000;
    let cachedToolOverrides = null;
    let cachedToolAt = 0;
    let cachedToolError = false;

    const getToolOverrides = async () => {
        if (!DISABLE_TOOLS) return null;
        const cachedTtl = cachedToolError ? TOOL_IDS_FAILURE_TTL_MS : TOOL_IDS_CACHE_MS;
        if (Date.now() - cachedToolAt < cachedTtl) {
            return cachedToolOverrides;
        }
        try {
            const idsRes = await client.tool.ids(backendDeadline(TOOL_IDS_TIMEOUT_MS));
            // The SDK resolves on a non-2xx answer instead of throwing: an error tuple carries no data, so it used to
            // be read as "the backend has no tools" and cached as a *success* - DISABLE_TOOLS then sent no tool
            // switches at all for the whole cache window, leaving every tool enabled.
            if (idsRes && idsRes.error) {
                const { status } = upstreamFailureReason(idsRes);
                throw new Error(`tool list rejected${status ? ` (status ${status})` : ''}`);
            }
            const ids = Array.isArray(idsRes?.data)
                ? idsRes.data
                : Array.isArray(idsRes)
                    ? idsRes
                    : [];
            const overrides = {};
            ids.forEach((id) => {
                /* With opencode>=1.19 + a free zen model, disabling either read or glob makes the prompt request hang forever, so these two read-only tools stay enabled while all other tools remain disabled */
                overrides[id] = ["read","glob"].includes(String(id).toLowerCase()) ? true : false;
            });
            cachedToolOverrides = overrides;
            cachedToolAt = Date.now();
            cachedToolError = false;
            logDebug('Tool overrides loaded', { count: ids.length });
            return overrides;
        } catch (e) {
            // Remember the failure for a short while (the cache stays empty, so no tools are sent) instead of asking
            // the backend again on the next request
            cachedToolOverrides = null;
            cachedToolAt = Date.now();
            cachedToolError = true;
            logDebug('Tool override fetch failed', { error: e.message });
            return null;
        }
    };

    async function promptWithTimeout(promptParams, timeoutMs) {
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(timeoutMessage(timeoutMs))), timeoutMs);
        });
        // The promise that loses a race keeps running. A rejection that arrives after the timeout - a backend that
        // dies, or the aborted fetch from the deadline below - used to reach nothing and become an unhandled
        // rejection, which ends the process by default: one slow completion could take the whole gateway down.
        const promptPromise = client.session.prompt({ ...promptParams, ...backendDeadline(timeoutMs) });
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
        constructor(message, status) {
            super(message);
            this.name = 'ProviderError';
            if (status !== undefined) this.status = status;
        }
    }

    // Describes a failed SDK call: the status and the reason the backend gave. The SDK hands back the parsed body
    // as-is (`{error:{message}}`, `{message}` or a plain string), so taking the first object would print
    // "[object Object]" in a client-facing message.
    const upstreamFailureReason = (res) => {
        const status = res?.response?.status;
        const raw = res?.error;
        const candidate = typeof raw === 'string'
            ? raw
            : (raw?.data?.message ?? raw?.message ?? (typeof raw?.error === 'string' ? raw.error : raw?.error?.message));
        // A thrown call carries the runtime's own wording (`fetch failed` for a dead or refused backend), which names
        // no cause at all; the same phrase a client would read from the top-level handler is used here.
        const text = clientFacingText(candidate);
        const reason = text && isConnectionError({ message: candidate })
            ? `the backend is not reachable (${text})`
            : text;
        return {
            status,
            reason: typeof reason === 'string' && reason ? `: ${reason}` : ''
        };
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
     * The assistant message `client.session.prompt` already returned, when the provider is done writing it.
     *
     * The backend answers `POST /session/:id/message` with the message it produced, so a finished message *is* the
     * answer: asking for it again with `GET /session/:id/message` was one backend round trip per completion (plus up
     * to a poll interval when the message was not yet marked finished) spent on data the gateway already held. A
     * message that is still being written carries no `finish`, and that case keeps using the poll loop.
     */
    const completedPromptMessage = (result) => {
        const message = result?.data;
        const info = message?.info;
        if (!info) return null;
        // opencode reports the end of a message either with a finish reason or with a completion stamp only
        if (!info.finish && !info.time?.completed) return null;
        const parts = Array.isArray(message.parts) ? message.parts : [];
        const { content, reasoning } = extractFromParts(parts);
        const error = info.error || null;
        // Nothing to serve and no failure to report: the staged message is not the answer, poll for it
        if (!content && !reasoning && !error) return null;
        return { content, reasoning, error };
    };

    /**
     * Turns a rejected `client.session.prompt` into the same upstream failure the other backend calls report.
     *
     * The SDK does not throw on a non-2xx answer: it resolves with `{ error, response }`. Ignoring that tuple made a
     * prompt the backend rejected (expired credentials, a rate limit, an unknown model, an incompatible version) look
     * like a slow answer - no assistant message was ever created, so polling could only run out the whole request
     * budget and answer 504 while holding the queue slot for minutes.
     */
    const throwIfPromptRejected = (result, hasAnswer) => {
        if (!result || !result.error || hasAnswer) return;
        const { status, reason } = upstreamFailureReason(result);
        throw new ProviderError(
            `OpenCode backend rejected the prompt${status ? ` (status ${status})` : ''}${reason}`,
            status
        );
    };

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
                messagesRes = await client.session.messages({
                    path: { id: sessionId },
                    ...backendDeadline(Math.max(1, timeoutMs - (Date.now() - startedAt)))
                });
            } catch (error) {
                // The deadline is the caller's budget, not a failed poll: it still surfaces as a timeout
                if (isTimeoutError(error)) throw error;
                messagesRes = { error: error?.message || String(error) };
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
                for (let i = messages.length - 1; i >= 0; i -= 1) {
                    const entry = messages[i];
                    const info = entry?.info;
                    if (info?.role !== 'assistant') continue;
                    const { content, reasoning } = extractFromParts(entry?.parts || []);
                    const error = info?.error || null;
                    const done = Boolean(info.finish || info.time?.completed || error);
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
        const eventStreamResult = await client.event.subscribe({ signal: controller.signal });
        const eventStream = eventStreamResult?.stream;
        // A rejected subscription resolves with an error tuple instead of throwing (the SDK never throws on a non-2xx
        // answer), so there is no stream to read: without this check the failure surfaced as "Cannot read properties
        // of undefined" and lost the upstream status that says what actually went wrong.
        if (!eventStream) {
            const { status, reason } = upstreamFailureReason(eventStreamResult);
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
        // Last snapshot seen per part, so an incremental event is diffed against its own part (see snapshotDelta)
        const partTexts = new Map();
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

        const scheduleIdleTimer = () => {
            if (!idleTimeoutMs) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
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
                controller.abort();
                reject(new Error(timeoutMessage(timeoutMs)));
            }, timeoutMs);

            scheduleFirstDeltaTimer(firstDeltaTimeoutMs);

            (async () => {
                try {
                    for await (const event of eventStream) {
                        // Not every event carries properties; reading one that does not would throw here and abort a
                        // subscription that is still perfectly usable
                        const props = event?.properties;
                        if (!props) continue;
                        if (event.type === 'message.part.updated' && ((props.part && props.part.sessionID) || props.sessionID) === sessionId) {
                            const { part } = props;
                            // An event that only names the session (no part payload) carries nothing to add: reading
                            // part.type here would throw and abort a subscription that is still usable
                            if (!part) continue;
                            /* opencode>=1.19 events carry no delta field: part.text is that part's current full text, so the increment is its previous snapshot diffed away (snapshotDelta) */
                            let delta = typeof props.delta === 'string' ? props.delta : '';
                            // The snapshot is recorded on every event that carries one, not only on the delta-less
                            // branch: the SDK's own event type allows `delta` and a cumulative `part.text` on the same
                            // event, and a backend (or a version transition) that sends a delta on the streaming
                            // updates and the finished part without one had its whole part re-sent - the delta-bearing
                            // events left this map unset, so the next delta-less event diffed against '' and duplicated
                            // the answer the client already had.
                            if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
                                const partKey = part.id || part.type;
                                if (!delta) delta = snapshotDelta(partTexts.get(partKey) || '', part.text);
                                partTexts.set(partKey, part.text);
                            }
                            if (delta) {
                                receivedDelta = true;
                                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                                scheduleIdleTimer();
                                if (!firstDeltaAt) {
                                    firstDeltaAt = Date.now();
                                    if (logger.isEnabled('debug')) {
                                        logger.debug('SSE first delta', {
                                            sessionId,
                                            ms: firstDeltaAt - startedAt,
                                            type: part.type
                                        });
                                    }
                                }
                                if (part.type === 'reasoning') {
                                    reasoning += delta;
                                    if (onDelta) await onDelta(delta, true);
                                } else {
                                    content += delta;
                                    if (onDelta) await onDelta(delta, false);
                                }
                                deltaChars += delta.length;
                            }
                        }
                        // Any completed assistant message ends the stream: `finish` is not always "stop" (a tool-call
                        // answer reports "tool-calls", other backends report "end" or only time.completed), and
                        // requiring the exact word "stop" left such an answer waiting for the 8 s idle timeout
                        if (event.type === 'message.updated' &&
                            props.info?.sessionID === sessionId &&
                            (props.info?.finish || props.info?.time?.completed)) {
                            if (logger.isEnabled('debug')) {
                                logger.debug('SSE completed', {
                                    sessionId,
                                    ms: Date.now() - startedAt,
                                    deltaChars
                                });
                            }
                            settle({ content, reasoning });
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
             * Called as soon as the prompt request returns. If this stream has not produced a single delta by
             * then, the event subscription is not delivering (seen intermittently with opencode >= 1.19), so the
             * wait is shortened to a small grace period instead of the full first-delta timeout (4 s by default).
             * Polling then supplies the answer immediately.
             */
            endFirstDeltaWait: (graceMs = 50) => {
                if (finished || receivedDelta) return;
                scheduleFirstDeltaTimer(graceMs);
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
                    logDebug('Abandoned while queued, skipping completion', { url: loggableUrl(request.url) });
                    if (!reply.raw.writableEnded) reply.raw.end();
                    return reply;
                }

                let sessionId = null;
                // Assigned once the session exists; the error path uses it to clean up
                let cleanupSession = null;
                // Assigned by the streaming path; the error path uses it to drop the backend event subscription
                // instead of leaving it open until its own deadline (up to the whole request budget)
                let abortStream = null;

                try {
                    reqId = request.gatewayLog?.reqId || null;
                    // Header masking allocates a fresh object; only build it when debug logging is actually on
                    if (logger.isEnabled('debug')) {
                        logger.debug('Incoming OpenAI request', {
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
                            const parsed = JSON.parse(text);
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
                    // "not streaming".
                    const readableFlag = (value) =>
                        value === undefined || value === null || parseBoolean(value, undefined) !== undefined;
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
                            const roleLabel = role.toUpperCase();
                            // `name` is client input and was interpolated raw: a non-string produced
                            // `USER([object Object]): …` in the prompt, and a name carrying a newline forged another
                            // conversation line inside the text the model reads. A string is kept - it is a documented
                            // OpenAI field - sanitised the same way every other value that lands in a prompt line is.
                            const nameLabel = typeof m?.name === 'string' ? m.name.replace(CONTROL_CHARS_RE, '?').trim() : '';
                            const nameSuffix = nameLabel ? `(${nameLabel.slice(0, MAX_ECHOED_VALUE_LENGTH)})` : '';
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

                    // Create session
                    let sessionRes;
                    try {
                        // What is left of the request budget, not a fresh one: with a full budget here a
                        // completion that had waited in the queue was granted a second create deadline and could
                        // answer past the timeout it had already advertised (measured: 3.66 s for a 2 s budget,
                        // 1.67 s of it spent queued).
                        sessionRes = await client.session.create(backendDeadline(remainingBudget()));
                    } catch (createError) {
                        // A backend that died between the cached "healthy" answer and this call fails here with a
                        // connection error. ensureBackend() trusted a probe from up to OPENCODE_PROXY_HEALTH_CACHE_MS
                        // ago, so this request answered "fetch failed" while a restart was a single probe away - the
                        // client had to retry to get the recovery the gateway could do itself. Drop the cached trust,
                        // start the backend again and retry the call once; a deadline or a backend that is really gone
                        // is not retried (a timeout keeps its own 504, and the retry would spend the budget twice).
                        if (!isConnectionError(createError)) throw createError;
                        logDebug('Session creation failed on a connection error, restarting the backend', {
                            error: createError.message
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
                        sessionRes = await client.session.create(backendDeadline(remainingBudget()));
                    }
                    sessionId = sessionRes.data?.id;
                    if (!sessionId) {
                        // A backend that answers /health but rejects POST /session (a version whose API moved, a proxy
                        // in front of it, an error body) used to surface as a bare 500 "Failed to create OpenCode
                        // session": no status, no reason, and it blamed the gateway for an upstream failure.
                        const { status: upstreamStatus, reason } = upstreamFailureReason(sessionRes);
                        if (upstreamStatus === 405) {
                            // The one cause worth naming: `opencode serve` from the 2.x CLI serves the web UI and
                            // answers /health with HTML, so the gateway's readiness probe passes and every
                            // completion then fails here. A 502 alone does not say that.
                            logger.warn(
                                '[Proxy] The backend does not expose the OpenCode session API (405). ' +
                                'The installed `opencode` CLI is probably a 2.x release: install a 1.x version, which is what ' +
                                '@opencode-ai/sdk drives, or upgrade the SDK.'
                            );
                        }
                        throw new ProviderError(
                            `OpenCode backend rejected session creation${upstreamStatus ? ` (status ${upstreamStatus})` : ''}${reason}`,
                            upstreamStatus
                        );
                    }
                    logDebug('Session created', { sessionId });

                    // A session is created per completion, so it must also be deleted per completion: otherwise the
                    // backend accumulates one session (with its full message history) for every request served.
                    let sessionCleaned = false;
                    cleanupSession = async () => {
                        if (!sessionId || sessionCleaned) return;
                        sessionCleaned = true;
                        try {
                            const deleteResult = await client.session.delete({ path: { id: sessionId }, ...backendDeadline(SESSION_CLEANUP_TIMEOUT_MS) });
                            // The SDK resolves on a non-2xx answer as well, so a rejected delete used to be logged as
                            // "Session deleted" while the session stayed on the backend
                            if (deleteResult && deleteResult.error) {
                                const { status, reason } = upstreamFailureReason(deleteResult);
                                logger.warn('[Proxy] Failed to delete session:', {
                                    sessionId,
                                    status,
                                    error: `delete rejected${reason}`
                                });
                            } else {
                                logDebug('Session deleted', { sessionId });
                            }
                        } catch (e) {
                            logger.debug('[Proxy] Failed to delete session:', { sessionId, error: e.message });
                        }
                    };

                    const promptParams = {
                        path: { id: sessionId },
                        body: {
                            model: { providerID: pID, modelID: mID },
                            system: systemWithGuard,
                            parts: parts
                        }
                    };
                    const toolOverrides = await getToolOverrides();
                    if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                        promptParams.body.tools = toolOverrides;
                    }
                    if (logger.isEnabled('debug')) {
                        logger.debug('Upstream payload (final request body to opencode serve)', {
                            reqId,
                            sessionId,
                            model: `${pID}/${mID}`,
                            payload: promptParams
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
                        const stopKeepAlive = () => {
                            if (keepAliveTimer) {
                                clearInterval(keepAliveTimer);
                                keepAliveTimer = null;
                            }
                        };
                        const noteClientGone = () => {
                            stopKeepAlive();
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
                        const promptResult = await promptWithTimeout(promptParams, remainingBudget());
                        logDebug('Prompt sent', { sessionId, ms: Date.now() - promptStart });
                        // A prompt the backend rejected is an upstream failure, not a slow answer: waiting for an
                        // assistant message that will never exist held the slot until the whole budget expired.
                        throwIfPromptRejected(promptResult, Boolean(streamedContent || streamedReasoning));
                        // The prompt has returned: if the stream never delivered a delta, stop waiting for one
                        const collector = await collectDeferred.catch(() => null);
                        if (collector) collector.endFirstDeltaWait();
                        const collected = await safeCollect;

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
                                throw new ProviderError(`${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
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
                                if (appendOnly && filteredSeen && safe.startsWith(filteredSeen)) {
                                    safe = safe.slice(filteredSeen.length);
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
                        const promptResult = await promptWithTimeout(promptParams, remainingBudget());
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
                        if (error && !content && !reasoning) {
                            // The session exists by now and must be deleted even though the answer failed
                            reply.code(502).send({
                                error: {
                                    // The provider's own text, masked and bounded like every other upstream reason: a
                                    // provider error routinely quotes the credential it rejected, and the streaming
                                    // path already ran this through clientFacingText(), so the two modes disagreed
                                    // about the same payload in size and in masking.
                                    message: clientFacingText(error.data?.message || error.message) || 'OpenCode provider error',
                                    type: 'server_error',
                                    code: error.name || 'OpenCodeError'
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
                    if (abortStream) abortStream();
                    const upstream = extractUpstreamError(error);
                    logger.error('[Proxy] API Error (upstream call failed)', {
                        reqId,
                        sessionId,
                        message: clientFacingText(error.message),
                        status: upstream.status,
                        // The body is backend-controlled text: it can quote a URL and a log line is collected as often as not
                        bodySummary: clientFacingText(upstream.bodySummary) || null
                    });
                    logger.debug('[Proxy] Error details', { reqId, sessionId, error });

                    // A dead/unreachable backend must not stay cached as healthy: drop the timestamp so the next
                    // request performs a real probe (and restarts the backend if needed)
                    if (isConnectionError(error)) {
                        const backend = backendState.get(OPENCODE_SERVER_URL);
                        if (backend) backend.healthyAt = 0;
                    }

                    // The reason can quote a URL (a proxy in front of the backend does), so it is masked before it
                    // reaches the response body and, below, the log line
                    let errorMessage = clientFacingText(error.message);
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
                    // a bug" instead of "the upstream is gone".
                    if (error.name === 'ProviderError' || isConnectionError(error)) {
                        statusCode = 502;
                    }
                    // The connection branch says what happened instead of forwarding Node's own wording: `fetch failed`
                    // is what a dead or refused backend produces, and a client reading it cannot tell whether the
                    // gateway, the backend or its own request is at fault.
                    if (error.name !== 'ProviderError' && isConnectionError(error)) {
                        errorMessage = `OpenCode backend is not reachable (${clientFacingText(error.message)})`;
                    }
                    if (error.message && error.message.includes('ENOENT')) {
                        errorMessage = 'OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service.';
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
                        // a client can act on
                        payload.error.code = isConnectionError(error)
                            ? 'backend_unreachable'
                            : (error.name === 'ProviderError' ? 'ProviderError' : 'upstream_error');
                    }
                    if (!reply.raw.headersSent) {
                        if (hijacked) {
                            reply.raw.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
                            reply.raw.end(JSON.stringify(payload));
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
            }, REQUEST_TIMEOUT_MS + 20000);
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
                logger.error('[Proxy] Request Handler Error:', { message: handlerMessage, stack: error.stack });
            }
            const payload = {
                error: {
                    message: timedOut
                        ? `OpenCode gateway did not finish the completion within ${REQUEST_TIMEOUT_MS}ms`
                        : handlerMessage,
                    type: 'server_error'
                }
            };
            const statusCode = timedOut ? 504 : 500;
            if (!reply.raw.headersSent) {
                if (hijacked) {
                    reply.raw.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
                    reply.raw.end(JSON.stringify(payload));
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
        const finish = (destroyAfter) => {
            if (settled) return;
            settled = true;
            clearTimeout(cut);
            raw.off('end', finishBody);
            raw.off('close', finishBody);
            send();
            if (destroyAfter && !raw.destroyed) raw.destroy();
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
                return 'request body is not valid JSON, or it carries a forbidden property name (__proto__, constructor); '
                    + 'send Content-Type: application/json';
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
// spawned a moment later is tracked instead of orphaned. The attempt aborts at its next checkpoint and the wait only
// has to cover what it is already inside: a health probe (2 s timeout) or the SIGTERM/SIGKILL escalation of the
// previous child (3 s). It stays under the 5 s hard exit `index.js` keeps as a backstop.
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
    if (state.shuttingDown) throw new Error('The gateway is shutting down');

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
        if (state.isStarting) throw new Error('Backend startup timeout');
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
                throw new Error(`OpenCode backend unavailable (last start attempt failed: ${state.lastStartError || 'unknown error'})`);
            }
            // The probe above suspended for up to its timeout, which is exactly the window a shutdown can land in
            if (state.shuttingDown) throw new Error('The gateway is shutting down');
            // Masked: the URL can carry a credential (see resolveBackendAuth), and this line is the one an operator
            // reads in `docker logs`
            logger.info(`[Proxy] OpenCode backend not found at ${maskBackendUrl(OPENCODE_SERVER_URL)}. Starting...`);

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
            if (state.shuttingDown) throw new Error('The gateway is shutting down');

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
            const jailParent = path.join(os.tmpdir(), 'opencode-proxy-jail');
            // mkdirSync does not change the mode of a directory that already exists, so a parent created by an older
            // build (0755) kept its permissions for the lifetime of the machine; re-assert them on every start.
            fs.mkdirSync(jailParent, { recursive: true, mode: 0o700 });
            if (!isWindows) {
                try {
                    fs.chmodSync(jailParent, 0o700);
                } catch (error) {
                    logger.warn('[Proxy] Could not restrict the backend jail directory:', { path: jailParent, error: error.message });
                }
            }
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

                    [fakeHome, opencodeDir, storageDir, messageDir, sessionDir].forEach(d => {
                        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
                    });

                    envVars = {
                        ...process.env,
                        HOME: fakeHome,
                        USERPROFILE: fakeHome,
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
                if (/["$`\u0000-\u001f\u007f]/.test(opencodeBin)) {
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
                logger.error(`[Proxy] Failed to spawn OpenCode: ${err.message}`);
                if (err.code === 'ENOENT') {
                    logger.error(`[Proxy] Command '${loggableConfigValue(OPENCODE_PATH)}' not found. Please ensure OpenCode is installed and in your PATH.`);
                    logger.error(`[Proxy] You can specify the full path in config.json using 'OPENCODE_PATH'`);
                }
            });

            // Wait for backend to be ready (a spawn failure aborts the wait right away instead of burning
            // the full startup budget)
            let started = false;
            for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
                await new Promise(r => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
                if (spawnError) break;
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
                try {
                    await checkHealth(OPENCODE_SERVER_URL);
                    logger.info('[Proxy] OpenCode backend ready.');
                    started = true;
                    break;
                } catch (e) { }
            }

            if (spawnError) {
                state.lastStartError = spawnError.message;
                state.lastStartFailureAt = Date.now();
                throw new Error(`Failed to start OpenCode backend: ${spawnError.message}`);
            }

            if (!started) {
                logger.warn('[Proxy] Backend start timed out.');
                state.lastStartError = 'Backend start timeout';
                state.lastStartFailureAt = Date.now();
                throw new Error('Backend start timeout');
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

    const config = {
        PORT: options.PORT || 8083,
        // Empty/blank values fall back to DEFAULT_API_KEY: authentication is always on
        API_KEY: resolveApiKey(options.API_KEY),
        OPENCODE_SERVER_URL: backendUrl.url,
        OPENCODE_BIND_HOST: options.OPENCODE_BIND_HOST || options.openCodeBindHost || process.env.OPENCODE_BIND_HOST || '127.0.0.1',
        OPENCODE_PATH: options.OPENCODE_PATH || 'opencode',
        BIND_HOST: options.BIND_HOST || options.bindHost || process.env.OPENCODE_PROXY_BIND_HOST || '127.0.0.1',
        // Raw LOG_LEVEL value: index.js already merged it as "env > config.json" and passes it in; when startProxy is
        // called directly, fall back to reading the environment variable
        LOG_LEVEL: options.LOG_LEVEL ?? options.logLevel ?? process.env.LOG_LEVEL ?? null,
        USE_ISOLATED_HOME: flagOption(
            options.USE_ISOLATED_HOME ?? options.useIsolatedHome,
            ['OPENCODE_USE_ISOLATED_HOME', 'USE_ISOLATED_HOME'],
            false
        ),
        REQUEST_TIMEOUT_MS: (() => {
            // A malformed value must fall back to the default: Number('abc') is NaN and setTimeout(NaN) fires
            // immediately, which would turn every completion into a 504. The fallback is named, like the queue and
            // body knobs: a typo used to be invisible, so the gateway ran with 300000 ms while the operator believed
            // a shorter budget was in force.
            const requested = options.REQUEST_TIMEOUT_MS ??
                process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS ??
                options.OPENCODE_PROXY_REQUEST_TIMEOUT_MS;
            const raw = Number(requested);
            if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
            const blank = requested === undefined || requested === null || String(requested).trim() === '';
            if (!blank) {
                logger.warn(`[Config] OPENCODE_PROXY_REQUEST_TIMEOUT_MS='${loggableConfigValue(String(requested).trim())}' is not a positive number, using ${DEFAULT_REQUEST_TIMEOUT_MS}`);
            }
            return DEFAULT_REQUEST_TIMEOUT_MS;
        })(),
        DISABLE_TOOLS: disableTools,
        DEBUG: flagOption(options.DEBUG, ['OPENCODE_PROXY_DEBUG'], false)
    };

    // The queue limits follow the same precedence as every other key (environment, then config.json, then default).
    // They used to be resolved from the environment alone, so the same keys in config.json were silently ignored and
    // the gateway kept the documented default while the operator believed a different value was in force.
    const resolvedLimits = getQueueLimits(options);
    MAX_CONCURRENCY = resolvedLimits.concurrency;
    MAX_QUEUE_LENGTH = resolvedLimits.queue;
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

    const { app } = createApp(config);

    // Fastify resolves listen() once the server is bound; log and warm the backend from the continuation.
    // No await here so startProxy stays synchronous for callers that need the server handle immediately.
    app.listen({ port: config.PORT, host: config.BIND_HOST })
        .then(async () => {
            logger.info(`Log level: ${logger.level} (source: ${levelSource})`);
            logger.info(`[Proxy] Active at http://${loggableConfigValue(config.BIND_HOST)}:${config.PORT}`);
            try {
                await ensureBackend(config, { force: true });
            } catch (error) {
                logger.error('[Proxy] Backend warmup failed:', { error: error.message });
            }
        })
        .catch((error) => {
            logger.error('[Fatal] Failed to start HTTP server:', { error: error.message, stack: error.stack });
            process.exit(1);
        });

    // Expose the Fastify instance as `server`: it implements close(cb), which index.js uses for shutdown
    return {
        server: app,
        // Stops the backend and resolves once it is really gone. The entry point awaits this before exiting: it used
        // to send SIGTERM and call process.exit() on the next line, so the SIGKILL escalation below never ran and a
        // backend that ignores SIGTERM outlived the gateway that owns it.
        killBackend: () => {
            const state = backendState.get(config.OPENCODE_SERVER_URL);
            if (!state) return Promise.resolve();
            // The jail directory is the child's cwd, so it goes only after the child is gone
            const removeJail = () => {
                if (!state.jailRoot || process.platform === 'win32') return;
                const jail = state.jailRoot;
                try {
                    fs.rmSync(jail, { recursive: true, force: true });
                    ownedJailRoots.delete(jail);
                } catch (e) { }
            };
            // SIGTERM, then SIGKILL after 3 s: a backend that ignores SIGTERM must not survive the gateway. Both timers
            // are unref'd so they cannot hold the process open, and the child keeps the loop alive while it still runs.
            const terminate = (child) => new Promise((resolve) => {
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
                    graceTimer = setTimeout(finish, 1000);
                    graceTimer.unref();
                }, 3000);
                killTimer.unref();
            });
            return (async () => {
                // Tell any start attempt in flight to stop: one that is still waiting on a health probe (or on the
                // previous child) would otherwise spawn a backend after this function resolved and after the gateway
                // exited, leaving an orphaned `opencode serve` that holds the backend port. The attempt notices the flag
                // at its next checkpoint and throws instead.
                state.shuttingDown = true;
                if (state.isStarting) await waitForPendingStart(state);
                const child = state.process;
                if (child && child.exitCode === null && child.signalCode === null) await terminate(child);
                removeJail();
            })();
        }
    };
}
