import Fastify from 'fastify';
import { spawn } from 'child_process';
import { createOpencodeClient } from '@opencode-ai/sdk';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { logger, maskHeaders } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Mutex Logic with Timeout ---
const queue = [];

const STARTUP_WAIT_ITERATIONS = 60;
const STARTUP_WAIT_INTERVAL_MS = 2000;
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
// Deleting the OpenCode session that a completion created is cleanup: it must finish quickly or not at all, because the
// client already has its answer and a wedged delete would otherwise hold a queue slot for the full request budget.
const SESSION_CLEANUP_TIMEOUT_MS = 10000;
const DEFAULT_POLL_INTERVAL_MS = 500;
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
// After the idle timeout the gateway polls for the rest of the answer; this is how many identical polls (a full idle
// window worth) that recovery tolerates before it accepts a message the backend never marks finished.
const IDLE_RECOVERY_STALL_POLLS = Math.max(3, Math.ceil(DEFAULT_EVENT_IDLE_TIMEOUT_MS / DEFAULT_POLL_INTERVAL_MS));

// Two completions that reach this counter in the same millisecond used to receive the same
// `chatcmpl-<epoch>` id (a client that keys its messages by id merged two answers); the counter keeps ids distinct
// without a random source, and the millisecond stamp keeps them roughly sortable.
let completionIdSeq = 0;
const newCompletionId = () => `chatcmpl-${Date.now().toString(36)}${String(completionIdSeq++).padStart(3, '0')}`;

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
            logger.warn(`[Proxy] OPENCODE_PATH '${input}' does not exist; using the OpenCode found on PATH instead`);
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
// value once at startup is cheaper than wondering why nothing works.
function normalizeBackendUrl(raw) {
    let url = String(raw || '').trim();
    const notes = [];
    if (url === '') return { url: 'http://127.0.0.1:4097', notes };
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
        notes.push(`OPENCODE_SERVER_URL='${url}' has no scheme, assuming http://`);
        url = `http://${url}`;
    }
    const stripped = url.replace(/\/+$/, '');
    if (stripped !== url) {
        notes.push(`OPENCODE_SERVER_URL had a trailing slash, using '${stripped}'`);
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
        return { value: fallback, note: `${name}='${raw}' is not a number, using ${fallback}` };
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
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
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

/**
 * Robust Health Check Helper
 */
function checkHealth(serverUrl) {
    const secure = String(serverUrl).startsWith('https://');
    const transport = secure ? https : http;
    return new Promise((resolve, reject) => {
        const req = transport.get(`${serverUrl}/health`, { agent: secure ? healthAgentSecure : healthAgent }, (res) => {
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
const readMilliseconds = (name, fallback, fileValue) => {
    const fromEnv = process.env[name];
    const raw = (fromEnv === undefined || String(fromEnv).trim() === '') ? fileValue : fromEnv;
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
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
    let bodySummary = null;
    if (typeof body === 'string') {
        bodySummary = body.slice(0, 500) || null;
    } else if (body !== null && body !== undefined) {
        try {
            bodySummary = JSON.stringify(body).slice(0, 500);
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

    // Performance-oriented setup: no built-in logger (we log ourselves, so Fastify's automatic request logging has
    // nothing to write to anyway), 50 MB JSON body limit, and trailing-slash tolerance matching the previous behavior.
    const app = Fastify({
        logger: false,
        // Resolved from OPENCODE_PROXY_MAX_BODY_MB (see MAX_BODY_MB): the wait queue pins every waiting request's
        // parsed body, so this is the other half of the gateway's memory bound
        bodyLimit: MAX_BODY_MB * 1024 * 1024,
        routerOptions: { ignoreTrailingSlash: true },
        trustProxy: false
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

    const client = createOpencodeClient({ baseUrl: OPENCODE_SERVER_URL });

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

    // A single onRequest hook does bookkeeping + access log, CORS and authentication: one hook per request costs
    // fewer dispatches than three, and the order (log wiring, CORS, auth) is unchanged.
    app.addHook('onRequest', (request, reply, done) => {
        const startedAt = Date.now();
        const path = request.url.split('?')[0];
        // A client that supplies its own trace id keeps it, so its logs and ours can be joined. Anything that is not a
        // short, printable token is ignored instead of being echoed: a header value can carry newlines or control
        // characters, and this string ends up in the log line and in a response header.
        const meta = { reqId: requestId(request) || `gw-${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`, startedAt, path };
        request.gatewayLog = meta;

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
            const model = meta.model || '-';
            const streamText = typeof meta.stream === 'boolean' ? String(meta.stream) : '-';
            const line = `${request.method} ${request.url} -> ${reply.raw.statusCode} ${Date.now() - startedAt}ms [${meta.reqId}] model=${model} stream=${streamText}`;
            if (isApiPath) logger.info(line);
            else logger.debug(line);
        };
        reply.raw.once('finish', logSummary);
        reply.raw.once('close', logSummary);

        // CORS headers are written on the raw response so they are present for streamed (hijacked) replies as well.
        // x-api-key is not read by the gateway, but browsers send it on behalf of clients that do, and a rejected
        // preflight would break those clients before they ever reach the auth check.
        reply.raw.setHeader('Access-Control-Allow-Origin', '*');
        reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, X-Requested-With');
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
        const presented = Object.prototype.hasOwnProperty.call(request.headers, 'authorization')
            ? authorizationToken(request.headers.authorization)
            : apiKeyHeaderToken(request.headers['x-api-key']);

        if (!matchesToken(presented)) {
            reply.code(401).send({ error: { message: 'Unauthorized', type: 'invalid_request_error', code: 'invalid_api_key' } });
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
                    message: `Request bodies with Content-Encoding: ${contentEncoding} are not supported; send the body uncompressed (drop that header)`,
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
    const MODELS_TIMEOUT_MS = Math.min(REQUEST_TIMEOUT_MS, METADATA_TIMEOUT_CAP_MS);
    const TOOL_IDS_TIMEOUT_MS = MODELS_TIMEOUT_MS;
    let modelsCache = null;
    let modelsCacheAt = 0;

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
        if (modelsInFlight) return modelsInFlight;
        modelsInFlight = fetchModels();
        try {
            return await modelsInFlight;
        } finally {
            modelsInFlight = null;
        }
    };

    const fetchModels = async () => {
        const now = Date.now();
        try {
            const providersRes = await client.config.providers(backendDeadline(MODELS_TIMEOUT_MS));
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
                return STATIC_FALLBACK_MODELS;
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
                return STATIC_FALLBACK_MODELS;
            }
            modelsCache = { object: 'list', data: models };
            modelsCacheAt = now;
            return models;
        } catch (error) {
            logger.error('[Proxy] Model Fetch Error:', { error: error.message, status: error.status, body: error.response?.data || error.responseBody || null });
            // Same item shape as a provider-served model, and not cached: the next request probes the backend again
            return STATIC_FALLBACK_MODELS;
        }
    };

    app.get('/v1/models', { schema: { response: { 200: MODELS_SCHEMA } } }, async (request, reply) => {
        return { object: 'list', data: await loadModels() };
    });

    // OpenAI clients (and several SDKs) look a model up by id. The gateway does not restrict the model a chat
    // request may use, so an id that is not in the provider list is described here instead of being a 404.
    const describeModel = async (requestedId) => {
        const known = (await loadModels()).find((m) => m.id === requestedId);
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

    const stripFunctionCalls = (text, trim = true) => {
        if (!DISABLE_TOOLS || !text) return text;
        const cleaned = text
            .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
            .replace(/<\/?function_calls>/g, '');
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
            timer = setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
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
        const reason = typeof candidate === 'string' && candidate && isConnectionError({ message: candidate })
            ? `the backend is not reachable (${candidate})`
            : candidate;
        return {
            status,
            reason: typeof reason === 'string' && reason ? `: ${reason}` : ''
        };
    };

    function extractFromParts(parts) {
        if (!Array.isArray(parts)) return { content: '', reasoning: '' };
        // Single pass, no intermediate arrays: this runs for every polled message of every request
        let content = '';
        let reasoning = '';
        for (let i = 0; i < parts.length; i += 1) {
            const part = parts[i];
            if (!part) continue;
            if (part.type === 'text') content += part.text || '';
            else if (part.type === 'reasoning') reasoning += part.text || '';
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
        // answered once the text stops growing for three consecutive polls.
        const requireDone = Boolean(options.requireDone);
        // How many identical polls mean "this message will never be marked finished". Three (~1.5 s) is right after a
        // normal prompt, but not after an idle timeout: the backend has been silent for the whole idle window already,
        // and giving up 1.5 s into the same silence truncated an answer a slow model was still writing (the client got
        // `finish_reason: "stop"` for text that stopped mid-sentence). That path asks for a full idle window instead.
        const stablePollsRequired = Number.isFinite(options.stablePollsRequired) && options.stablePollsRequired >= 1
            ? Math.floor(options.stablePollsRequired)
            : 3;
        let lastContent = '';
        let stablePolls = 0;
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
                logger.warn('[Proxy] Polling failed', { sessionId, attempt: consecutiveFailures, status });
                if (consecutiveFailures >= MAX_POLL_FAILURES) {
                    throw new ProviderError(
                        `OpenCode backend failed while polling the answer${status ? ` (status ${status})` : ''}${reason}`,
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
                    if (content && content === lastContent) stablePolls += 1;
                    else {
                        lastContent = content;
                        stablePolls = 0;
                    }
                    if (done || stablePolls >= stablePollsRequired || (!requireDone && (content || reasoning))) {
                        if (error) {
                            logger.error('[Proxy] OpenCode assistant error:', { sessionId, error });
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
            await sleep(intervalMs);
        }
        logDebug('Polling timeout', { sessionId, ms: Date.now() - pollStart });
        throw new Error(`Request timeout after ${timeoutMs}ms`);
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
                reject(new Error(`Request timeout after ${timeoutMs}ms`));
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
                            /* opencode>=1.19 events carry no delta field: part.text is the part's current full text, so derive the increment by diffing against what has already been accumulated */
                            let delta = props.delta;
                            if (!delta && (part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
                                const acc = part.type === 'reasoning' ? reasoning : content;
                                delta = part.text.startsWith(acc) ? part.text.slice(acc.length) : part.text;
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
                    logDebug('Abandoned while queued, skipping completion', { url: request.url });
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
                            path: request.url,
                            headers: maskHeaders(request.headers),
                            body: request.body
                        });
                    }
                    // A body like `null` or `"text"` is valid JSON but not a completion request: answer 400 instead of
                    // letting a destructuring TypeError turn into a 500. A string body means the client sent JSON
                    // under a non-JSON content type (`curl -d '{...}'` without the header, or `text/plain`), which
                    // Fastify hands over unparsed - parse it here rather than reject a request whose body is fine.
                    let body = {};
                    if (typeof request.body === 'string') {
                        try {
                            const parsed = JSON.parse(request.body);
                            body = parsed && typeof parsed === 'object' ? parsed : {};
                        } catch (e) {
                            return reply.code(400).send({
                                error: {
                                    message: 'request body is not valid JSON; send Content-Type: application/json',
                                    type: 'invalid_request_error'
                                }
                            });
                        }
                    } else if (request.body && typeof request.body === 'object') {
                        body = request.body;
                    }
                    const { messages, model, stream } = body;
                    if (!messages || !Array.isArray(messages) || messages.length === 0) {
                        return reply.code(400).send({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
                    }
                    if (typeof model !== 'undefined' && typeof model !== 'string') {
                        return reply.code(400).send({ error: { message: 'model must be a string', type: 'invalid_request_error' } });
                    }

                    // `stream` arrives as a boolean from real SDKs, but hand-written clients (and template engines that
                    // stringify booleans) also send "true"/"1"/"yes". Anything unrecognised keeps the historical
                    // non-streaming default instead of guessing.
                    const wantsStream = parseBoolean(stream, false) === true;
                    // `stream_options: {include_usage: true}` asks for a final chunk that carries the token usage;
                    // without this the request is honoured only in the sense that nothing rejects it, and a client that
                    // waits for its usage chunk (the OpenAI SDK does) gets no numbers at all.
                    const includeUsage = wantsStream && parseBoolean(body.stream_options?.include_usage, false) === true;

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
                                message: `model "${modelId}" must be a "provider/model" id`,
                                type: 'invalid_request_error'
                            }
                        });
                    }
                    if (request.gatewayLog) {
                        request.gatewayLog.model = `${pID}/${mID}`;
                        request.gatewayLog.stream = wantsStream;
                    }

                    const normalizeMessageContent = (content) => {
                        if (typeof content === 'string') return content;
                        if (Array.isArray(content)) {
                            return content.map((part) => {
                                if (typeof part === 'string') return part;
                                if (part && typeof part.text === 'string') return part.text;
                                return '';
                            }).join('');
                        }
                        if (content && typeof content.text === 'string') return content.text;
                        if (content === null || content === undefined) return '';
                        if (typeof content === 'number' || typeof content === 'boolean') return String(content);
                        return '';
                    };

                    const buildPromptParts = (rawMessages) => {
                        const parts = [];
                        const systemChunks = [];
                        const userContents = [];
                        rawMessages.forEach((m) => {
                            const role = (m?.role || 'user').toLowerCase();
                            const content = normalizeMessageContent(m?.content);
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
                            const nameSuffix = m?.name ? `(${m.name})` : '';
                            parts.push({
                                type: 'text',
                                text: `${roleLabel}${nameSuffix}: ${content}`
                            });
                        });
                        return {
                            parts,
                            system: systemChunks.join('\n\n'),
                            lastUserMsg: userContents[userContents.length - 1] || ''
                        };
                    };

                    const { parts, system: systemMsg, lastUserMsg } = buildPromptParts(messages);
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
                        sessionRes = await client.session.create(backendDeadline(REQUEST_TIMEOUT_MS));
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
                        sessionRes = await client.session.create(backendDeadline(REQUEST_TIMEOUT_MS));
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
                            REQUEST_TIMEOUT_MS,
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
                        const promptResult = await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
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
                        const emitPolled = async (appendOnly, stallPolls = 3) => {
                            const { content, reasoning, error } = await pollForAssistantResponse(
                                sessionId,
                                REQUEST_TIMEOUT_MS,
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
                            let safeReasoning = stripFunctionCalls(reasoning, false) || '';
                            let safeContent = stripFunctionCalls(content, false) || '';
                            if (appendOnly) {
                                if (streamedReasoning && safeReasoning.startsWith(streamedReasoning)) {
                                    safeReasoning = safeReasoning.slice(streamedReasoning.length);
                                }
                                if (streamedContent && safeContent.startsWith(streamedContent)) {
                                    safeContent = safeContent.slice(streamedContent.length);
                                }
                            }
                            if (safeReasoning) await sendDelta(safeReasoning, true);
                            if (safeContent) await sendDelta(safeContent, false);
                        };

                        let polled = false;
                        if (collected && collected.__error) {
                            logDebug('SSE collect error, falling back to polling', {
                                sessionId,
                                error: collected.__error?.message
                            });
                            polled = true;
                            await emitPolled(false);
                        } else if (collected && collected.noData) {
                            logDebug('Fallback to polling (stream)', { sessionId });
                            polled = true;
                            await emitPolled(false);
                        } else if (collected && collected.idleTimeout) {
                            logDebug('SSE idle timeout, polling for completion', { sessionId });
                            polled = true;
                            // The backend just went silent on us: give it another full idle window before deciding the
                            // message will never be marked finished
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
                        const promptResult = await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
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
                            REQUEST_TIMEOUT_MS,
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
                                    message: error.data?.message || error.message || 'OpenCode provider error',
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
                        message: error.message,
                        status: upstream.status,
                        bodySummary: upstream.bodySummary
                    });
                    logger.debug('[Proxy] Error details', { reqId, sessionId, error });

                    // A dead/unreachable backend must not stay cached as healthy: drop the timestamp so the next
                    // request performs a real probe (and restarts the backend if needed)
                    if (isConnectionError(error)) {
                        const backend = backendState.get(OPENCODE_SERVER_URL);
                        if (backend) backend.healthyAt = 0;
                    }

                    let errorMessage = error.message;
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
                        errorMessage = `OpenCode backend is not reachable (${error.message})`;
                    }
                    if (error.message && error.message.includes('ENOENT')) {
                        errorMessage = 'OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service.';
                    }
                    // OpenAI clients branch on the type: a gateway/upstream failure is a server_error, and the
                    // constructor name of an internal exception is not part of any contract
                    const payload = { error: { message: errorMessage, type: 'server_error' } };
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
            // The last line of defence is the queue timer (waiting for a slot, or running longer than the whole
            // budget). That is a gateway timeout, not a gateway bug: answering 500 for it hid the timeout and leaked
            // the internal budget number to the client.
            const timedOut = typeof error?.message === 'string' && error.message.includes('Request timeout');
            if (timedOut) {
                logger.warn('[Proxy] Completion timed out:', { message: error.message });
            } else {
                logger.error('[Proxy] Request Handler Error:', { message: error.message, stack: error.stack });
            }
            const payload = {
                error: {
                    message: timedOut
                        ? `OpenCode gateway did not finish the completion within ${REQUEST_TIMEOUT_MS}ms`
                        : error.message,
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
    const healthBody = JSON.stringify({ status: 'ok', backend: OPENCODE_SERVER_URL });
    // Not async: a sync handler skips the promise Fastify would otherwise await on every probe, and the body is
    // already serialized - a liveness probe is the one request that never needs to suspend.
    app.get('/health', { schema: { response: { 200: HEALTH_SCHEMA } } }, (request, reply) =>
        reply.type('application/json; charset=utf-8').send(healthBody));

    // Uniform OpenAI-style error envelope for anything Fastify itself rejects (invalid JSON, body too large,
    // unknown route, ...) instead of the framework's default { statusCode, code, error, message } shape
    app.setErrorHandler((error, request, reply) => {
        const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
        const detail = {
            method: request.method,
            path: request.url,
            message: error.message,
            code: error.code || error.name
        };
        if (statusCode >= 500) logger.error('[Proxy] Unhandled request error:', detail);
        else logger.warn('[Proxy] Rejected request:', detail);
        if (reply.raw.headersSent) {
            if (!reply.raw.writableEnded) reply.raw.end();
            return;
        }
        reply.code(statusCode).send({
            error: {
                message: error.message,
                type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
                // Fastify's own identifier (FST_ERR_CTP_INVALID_JSON_BODY, ...) is kept for support tickets
                code: error.code || error.name || 'Error'
            }
        });
    });

    // Unknown routes use the same OpenAI-style envelope
    app.setNotFoundHandler((request, reply) => {
        reply.code(404).send({
            error: {
                message: `Route ${request.method} ${request.url.split('?')[0]} not found`,
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
            logger.info(`[Proxy] OpenCode backend not found at ${OPENCODE_SERVER_URL}. Starting...`);

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
            const salt = Math.random().toString(36).substring(7);
            const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail', salt);
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
                fs.mkdirSync(workspace, { recursive: true });
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
                        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
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

            let port = '4097';
            try {
                port = new URL(OPENCODE_SERVER_URL).port || '4097';
            } catch (e) {
                logger.warn(`[Proxy] Could not parse OPENCODE_SERVER_URL '${OPENCODE_SERVER_URL}', assuming port 4097`);
            }
            const resolved = resolveOpencodePath(OPENCODE_PATH);
            const opencodeBin = resolved.path || OPENCODE_PATH || OPENCODE_BASENAME;
            if (resolved.path) {
                logger.info(`[Proxy] Using OpenCode binary: ${opencodeBin} (source: ${resolved.source})`);
            } else {
                logger.warn(`[Proxy] Unable to resolve OpenCode binary for '${OPENCODE_PATH}'. Using as-is.`);
            }

            // Cross-platform spawn options
            const useShell = process.platform === 'win32' || !resolved.path ||
                opencodeBin.endsWith('.cmd') || opencodeBin.endsWith('.bat');
            // A shell parses the command line, so the binary has to survive it: quoting keeps spaces intact (an
            // unquoted "C:\Program Files\...opencode.cmd" does not start at all) and turns operators such as `;` or
            // `&` into literal text. Only what quoting cannot neutralise is refused.
            let spawnTarget = opencodeBin;
            if (useShell) {
                if (/["$`]/.test(opencodeBin)) {
                    throw new Error(`OPENCODE_PATH cannot be passed through a shell: ${opencodeBin}`);
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
            logger.info(`[Proxy] Starting OpenCode backend: --port ${port} --hostname ${bindHost}`);
            state.process = spawn(spawnTarget, ['serve', '--port', port, '--hostname', bindHost], spawnOptions);

            // Handle spawn errors
            let spawnError = null;
            state.process.on('error', (err) => {
                spawnError = err;
                logger.error(`[Proxy] Failed to spawn OpenCode: ${err.message}`);
                if (err.code === 'ENOENT') {
                    logger.error(`[Proxy] Command '${OPENCODE_PATH}' not found. Please ensure OpenCode is installed and in your PATH.`);
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
    const disableTools =
        parseBoolean(options.DISABLE_TOOLS) ??
        parseBoolean(options.disableTools) ??
        parseBoolean(process.env.OPENCODE_DISABLE_TOOLS) ??
        parseBoolean(process.env.DISABLE_TOOLS) ??
        false;

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
        USE_ISOLATED_HOME: parseBoolean(
            options.USE_ISOLATED_HOME ?? options.useIsolatedHome,
            parseBoolean(process.env.OPENCODE_USE_ISOLATED_HOME ?? process.env.USE_ISOLATED_HOME, false)
        ),
        REQUEST_TIMEOUT_MS: (() => {
            // A malformed value must fall back to the default: Number('abc') is NaN and setTimeout(NaN) fires
            // immediately, which would turn every completion into a 504
            const raw = Number(
                options.REQUEST_TIMEOUT_MS ??
                process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS ??
                options.OPENCODE_PROXY_REQUEST_TIMEOUT_MS
            );
            return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_REQUEST_TIMEOUT_MS;
        })(),
        DISABLE_TOOLS: disableTools,
        DEBUG: parseBoolean(options.DEBUG, parseBoolean(process.env.OPENCODE_PROXY_DEBUG, false))
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
    // The two backend timings follow the same precedence
    BACKEND_HEALTH_CACHE_MS = readMilliseconds(
        'OPENCODE_PROXY_HEALTH_CACHE_MS',
        2000,
        options.OPENCODE_PROXY_HEALTH_CACHE_MS
    );
    BACKEND_START_RETRY_COOLDOWN_MS = readMilliseconds(
        'OPENCODE_PROXY_START_RETRY_MS',
        15000,
        options.OPENCODE_PROXY_START_RETRY_MS
    );

    // Log level resolution (calibrated at startup; all later log output follows this level):
    // 1) LOG_LEVEL (options/env, case-insensitive) 2) when not explicitly set but the legacy DEBUG switch is on,
    // promote to debug (backward compatible) 3) default info; invalid values fall back to info with a warning
    let levelResolution = logger.setLevel(config.LOG_LEVEL);
    let levelSource = levelResolution.explicit ? 'LOG_LEVEL' : 'default';
    if (!levelResolution.valid) {
        logger.warn(`Invalid LOG_LEVEL '${levelResolution.requested}', fallback to 'info' (valid values: error/warn/info/debug)`);
    } else if (!levelResolution.explicit && config.DEBUG) {
        // setLevel() reports the promotion as explicit, so the source has to be recorded here: reading it back from
        // the resolved object claimed the operator had set LOG_LEVEL, which is not where `debug` came from.
        logger.setLevel('debug');
        levelSource = 'legacy DEBUG flag';
    }
    backendUrl.notes.forEach((note) => logger.warn(`[Config] ${note}`));
    config.LOG_LEVEL = logger.level;

    const { app } = createApp(config);

    // Fastify resolves listen() once the server is bound; log and warm the backend from the continuation.
    // No await here so startProxy stays synchronous for callers that need the server handle immediately.
    app.listen({ port: config.PORT, host: config.BIND_HOST })
        .then(async () => {
            logger.info(`Log level: ${logger.level} (source: ${levelSource})`);
            logger.info(`[Proxy] Active at http://${config.BIND_HOST}:${config.PORT}`);
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
