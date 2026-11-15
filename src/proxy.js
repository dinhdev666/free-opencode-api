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
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = 4000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 8000;
// A stream that has written nothing for this long gets a comment line, so a proxy or client does not drop the
// connection while the backend is still thinking. The tick is shorter so the silence stays close to the interval.
const SSE_KEEPALIVE_INTERVAL_MS = 15000;
const SSE_KEEPALIVE_TICK_MS = 5000;

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

// How many chat completions may run at the same time. 1 (the default) preserves the historical behaviour of
// serializing every completions request; raise it to let independent OpenCode sessions run in parallel.
const MAX_CONCURRENCY = (() => {
    const raw = Number(process.env.OPENCODE_PROXY_MAX_CONCURRENCY);
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(Math.floor(raw), 32);
})();

let activeTasks = 0;

function runQueuedTask() {
    const { task, timeout, resolve, reject } = queue.shift();
    activeTasks += 1;
    let settled = false;
    const timeoutMs = timeout || 120000;
    const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve()
        .then(() => task())
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
        .finally(() => {
            activeTasks -= 1;
            // Drain the queue on the next tick instead of waiting a fixed 100 ms between requests
            setImmediate(processQueue);
        });
}

function processQueue() {
    while (activeTasks < MAX_CONCURRENCY && queue.length > 0) {
        runQueuedTask();
    }
}

// Every waiting request holds its parsed body (up to the 50 MB body limit), so the wait queue is bounded:
// past this point new requests are rejected immediately with a 503 instead of growing memory until they time out.
const MAX_QUEUE_LENGTH = (() => {
    const raw = Number(process.env.OPENCODE_PROXY_MAX_QUEUE);
    // A missing or malformed value must never disable the cap (Number('abc') is NaN, which would compare false forever)
    if (!Number.isFinite(raw) || raw < 0) return 64;
    return Math.min(Math.floor(raw), 4096);
})();

class QueueFullError extends Error {
    constructor() {
        super(`Queue full: ${MAX_QUEUE_LENGTH} completions are already waiting, retry later`);
        this.name = 'QueueFullError';
    }
}

function lock(task, timeout = 120000) {
    return new Promise((resolve, reject) => {
        if (queue.length >= MAX_QUEUE_LENGTH) {
            reject(new QueueFullError());
            return;
        }
        queue.push({ task, timeout, resolve, reject });
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

// How long a successful health probe is trusted before the next one (0 disables the cache)
const BACKEND_HEALTH_CACHE_MS = (() => {
    const raw = Number(process.env.OPENCODE_PROXY_HEALTH_CACHE_MS);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2000;
})();

// After a failed start attempt (missing binary, backend never became healthy) requests fail fast for this long
// instead of repeating a multi-minute startup wait on every single request
const BACKEND_START_RETRY_COOLDOWN_MS = (() => {
    const raw = Number(process.env.OPENCODE_PROXY_START_RETRY_MS);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15000;
})();

const isConnectionError = (error) => {
    const message = String(error?.message || '');
    return message.includes('fetch failed') ||
        message.includes('ECONNREFUSED') ||
        message.includes('socket hang up') ||
        error?.cause?.code === 'ECONNREFUSED';
};

/**
 * Cleanup temporary directories
 */
function cleanupTempDirs() {
    // Only cleanup jail directories on non-Windows platforms
    // On Windows, we don't use isolated jail to avoid path issues
    if (process.platform === 'win32') return;

    const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail');
    try {
        if (fs.existsSync(jailRoot)) {
            fs.rmSync(jailRoot, { recursive: true, force: true });
        }
    } catch (e) {
        logger.error('[Cleanup] Failed to remove temp dirs:', { error: e.message });
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
        bodyLimit: 50 * 1024 * 1024,
        routerOptions: { ignoreTrailingSlash: true },
        trustProxy: false
    });

    const client = createOpencodeClient({ baseUrl: OPENCODE_SERVER_URL });

    // Precomputed once: comparing against a ready-made buffer avoids rebuilding the token on every request.
    // resolveApiKey() guarantees a non-empty key, so authentication can never be switched off.
    const bearerToken = `Bearer ${resolveApiKey(API_KEY)}`;
    const bearerTokenBuffer = Buffer.from(bearerToken);

    // A single onRequest hook does bookkeeping + access log, CORS and authentication: one hook per request costs
    // fewer dispatches than three, and the order (log wiring, CORS, auth) is unchanged.
    app.addHook('onRequest', (request, reply, done) => {
        const startedAt = Date.now();
        const path = request.url.split('?')[0];
        const meta = { reqId: `gw-${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`, startedAt, path };
        request.gatewayLog = meta;

        // The summary is emitted from the raw response's events so hijacked SSE streams (which bypass the normal
        // reply lifecycle) are covered too; whichever event arrives first wins.
        let logged = false;
        const logSummary = () => {
            if (logged) return;
            logged = true;
            const model = meta.model || '-';
            const streamText = typeof meta.stream === 'boolean' ? String(meta.stream) : '-';
            const line = `${request.method} ${request.url} -> ${reply.raw.statusCode} ${Date.now() - startedAt}ms [${meta.reqId}] model=${model} stream=${streamText}`;
            if (path.startsWith('/v1/')) logger.info(line);
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
        // The same id the request log carries, so a client-side report can be traced back to a log line
        reply.raw.setHeader('X-Request-Id', meta.reqId);

        if (request.method === 'OPTIONS') return done();
        // /health and / stay open; every other route always requires the bearer token
        if (path === '/health' || path === '/') return done();

        const provided = request.headers.authorization;
        // Constant-time comparison (the length check is required because timingSafeEqual throws on size mismatch)
        if (provided === undefined || provided.length !== bearerToken.length ||
            !timingSafeEqual(Buffer.from(provided), bearerTokenBuffer)) {
            reply.code(401).send({ error: { message: 'Unauthorized', type: 'invalid_request_error', code: 'invalid_api_key' } });
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
    let modelsCache = null;
    let modelsCacheAt = 0;

    // Shared by /v1/models and /v1/models/:modelId so both answer from the same cache
    const loadModels = async () => {
        const now = Date.now();
        if (modelsCache && now - modelsCacheAt < MODELS_CACHE_TTL_MS) {
            return modelsCache.data;
        }
        try {
            const providersRes = await client.config.providers();
            const providersRaw = providersRes.data?.providers || [];
            const models = [];
            const list = Array.isArray(providersRaw)
                ? providersRaw
                : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));

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
            modelsCache = { object: 'list', data: models };
            modelsCacheAt = now;
            return models;
        } catch (error) {
            logger.error('[Proxy] Model Fetch Error:', { error: error.message, status: error.status, body: error.response?.data || error.responseBody || null });
            // Same item shape as a provider-served model, and not cached: the next request probes the backend again
            return [{ id: 'opencode/kimi-k2.5-free', name: 'Kimi K2.5 Free', object: 'model', owned_by: 'opencode' }];
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
        const slash = requestedId.indexOf('/');
        const provider = slash > 0 ? requestedId.slice(0, slash) : 'opencode';
        const name = slash > 0 ? requestedId.slice(slash + 1) : requestedId;
        return { id: requestedId, name, object: 'model', owned_by: provider };
    };
    const modelByIdSchema = { schema: { response: { 200: MODEL_SCHEMA } } };
    app.get('/v1/models/:modelId', modelByIdSchema, async (request) => describeModel(String(request.params?.modelId || '')));
    // Model ids contain slashes (`opencode/kimi-k2.5-free`), and clients send them unencoded as often as escaped:
    // without the wildcard route the unencoded form hit the 404 handler.
    app.get('/v1/models/*', modelByIdSchema, async (request) => describeModel(String(request.params?.['*'] || '')));

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
        let inBlock = false;
        let held = '';
        // Splits text into the part that can be written out and the suffix that could still become a tag
        const splitAtPossibleTag = (text) => {
            for (let length = Math.min(text.length, OPEN_TAG.length - 1); length > 0; length -= 1) {
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
            const idsRes = await client.tool.ids();
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
        try {
            return await Promise.race([client.session.prompt(promptParams), timeoutPromise]);
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

    async function pollForAssistantResponse(sessionId, timeoutMs, intervalMs = DEFAULT_POLL_INTERVAL_MS, shouldAbort = null) {
        const pollStart = Date.now();
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            // A disconnected client must not keep the completion queue busy while polling for an answer nobody reads
            if (shouldAbort && shouldAbort()) {
                logDebug('Polling abandoned', { sessionId, ms: Date.now() - pollStart });
                return { content: '', reasoning: '', aborted: true };
            }
            const messagesRes = await client.session.messages({ path: { id: sessionId } });
            const messages = messagesRes?.data || messagesRes || [];
            if (Array.isArray(messages) && messages.length) {
                for (let i = messages.length - 1; i >= 0; i -= 1) {
                    const entry = messages[i];
                    const info = entry?.info;
                    if (info?.role !== 'assistant') continue;
                    const { content, reasoning } = extractFromParts(entry?.parts || []);
                    const error = info?.error || null;
                    const done = Boolean(info.finish || info.time?.completed || error);
                    if (done || content || reasoning) {
                        if (error) {
                            logger.error('[Proxy] OpenCode assistant error:', { sessionId, error });
                        }
                        logDebug('Polling completed', {
                            sessionId,
                            ms: Date.now() - pollStart,
                            done,
                            contentLen: content.length,
                            reasoningLen: reasoning.length,
                            error: error ? error.name : null
                        });
                        return { content, reasoning, error };
                    }
                }
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
        const eventStream = eventStreamResult.stream;
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
                logDebug('Event idle timeout', {
                    sessionId,
                    ms: Date.now() - startedAt,
                    deltaChars
                });
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
                                    logDebug('SSE first delta', {
                                        sessionId,
                                        ms: firstDeltaAt - startedAt,
                                        type: part.type
                                    });
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
                        if (event.type === 'message.updated' &&
                            props.info?.sessionID === sessionId &&
                            props.info?.finish === 'stop') {
                            logDebug('SSE completed', {
                                sessionId,
                                ms: Date.now() - startedAt,
                                deltaChars
                            });
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

            await lock(async () => {
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
                    // letting a destructuring TypeError turn into a 500
                    const body = request.body && typeof request.body === 'object' ? request.body : {};
                    const { messages, model, stream } = body;
                    if (!messages || !Array.isArray(messages) || messages.length === 0) {
                        return reply.code(400).send({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
                    }
                    if (typeof model !== 'undefined' && typeof model !== 'string') {
                        return reply.code(400).send({ error: { message: 'model must be a string', type: 'invalid_request_error' } });
                    }

                    // `stream` may arrive as a boolean or as the strings "true"/"false"
                    const wantsStream = stream === true || stream === 'true';

                    // Split on the first slash only: a model id may itself contain slashes
                    // (`vendor/family/version`), and `split('/')` used to drop everything after the second one
                    const modelId = (model || '').trim() || 'opencode/kimi-k2.5-free';
                    const modelSlash = modelId.indexOf('/');
                    const pID = modelSlash === -1 ? 'opencode' : modelId.slice(0, modelSlash);
                    const mID = modelSlash === -1 ? modelId : modelId.slice(modelSlash + 1);
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
                            if (role === 'system') {
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
                    logDebug('Request start', {
                        model: `${pID}/${mID}`,
                        stream: wantsStream,
                        userMessages: messages.length,
                        system: Boolean(systemMsg),
                        lastUserLength: lastUserMsg.length,
                        parts: parts.length,
                        disableTools: DISABLE_TOOLS
                    });

                    // Ensure backend is running
                    await ensureBackend(config);

                    // Create session
                    const sessionRes = await client.session.create();
                    sessionId = sessionRes.data?.id;
                    if (!sessionId) throw new Error('Failed to create OpenCode session');
                    logDebug('Session created', { sessionId });

                    // A session is created per completion, so it must also be deleted per completion: otherwise the
                    // backend accumulates one session (with its full message history) for every request served.
                    let sessionCleaned = false;
                    cleanupSession = async () => {
                        if (!sessionId || sessionCleaned) return;
                        sessionCleaned = true;
                        try {
                            await client.session.delete({ path: { id: sessionId } });
                            logDebug('Session deleted', { sessionId });
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
                        const id = `chatcmpl-${Date.now()}`;
                        const filterContentDelta = createToolCallFilter();
                        const filterReasoningDelta = createToolCallFilter();
                        let streamedContent = '';
                        let streamedReasoning = '';
                        let sseChunkCount = 0;

                        // The envelope fields are identical for every chunk of this stream, so they are serialized
                        // once up front; per delta only the escaped text is stringified and appended.
                        const createdAt = Math.floor(Date.now() / 1000);
                        const chunkHead = `data: {"id":"${id}","object":"chat.completion.chunk","created":${createdAt},"model":${JSON.stringify(`${pID}/${mID}`)},"choices":[{"index":0,"delta":{"`;
                        // Closes the delta object and the chunk envelope: `"<field>":<value>},"finish_reason":null}]}`
                        const chunkTail = '},"finish_reason":null}]}\n\n';
                        const stopFrame = `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;

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
                            if (raw.writableEnded) return;
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

                        // Respect write backpressure so a slow reader cannot force the whole answer into memory
                        const writeFrame = async (frame) => {
                            if (clientGone) return;
                            lastWriteAt = Date.now();
                            if (raw.write(frame)) return;
                            await new Promise((resolve) => {
                                const settleDrain = () => {
                                    raw.off('drain', settleDrain);
                                    raw.off('close', settleDrain);
                                    raw.off('error', settleDrain);
                                    resolve();
                                };
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
                            await writeFrame(`${chunkHead}${isReasoning ? 'reasoning_content' : 'content'}":${JSON.stringify(filtered)}${chunkTail}`);
                            sseChunkCount++;
                        };

                        const collectDeferred = collectFromEvents(
                            sessionId,
                            REQUEST_TIMEOUT_MS,
                            sendDelta,
                            DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                            DEFAULT_EVENT_IDLE_TIMEOUT_MS
                        );
                        const safeCollect = collectDeferred
                            .then((collector) => {
                                collectorHandle = collector;
                                // The client left before the subscription was ready: stop it right away
                                if (clientGone) collector.abort();
                                return collector.promise;
                            })
                            .catch((err) => ({ __error: err }));
                        const promptStart = Date.now();
                        await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                        logDebug('Prompt sent', { sessionId, ms: Date.now() - promptStart });
                        // The prompt has returned: if the stream never delivered a delta, stop waiting for one
                        const collector = await collectDeferred.catch(() => null);
                        if (collector) collector.endFirstDeltaWait();
                        const collected = await safeCollect;

                        // One place that turns a polled assistant message into deltas. `appendOnly` trims the part that
                        // was already streamed over SSE, so an idle-timeout fallback never repeats itself.
                        const emitPolled = async (appendOnly) => {
                            const { content, reasoning, error } = await pollForAssistantResponse(
                                sessionId,
                                REQUEST_TIMEOUT_MS,
                                DEFAULT_POLL_INTERVAL_MS,
                                () => clientGone
                            );
                            if (clientGone) return;
                            if (error && !content && !reasoning) {
                                await sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                                return;
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
                            await emitPolled(true);
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
                            if (tailContent) await sendDelta(tailContent, false);
                            const tailReasoning = filterReasoningDelta.flush();
                            if (tailReasoning) await sendDelta(tailReasoning, true);
                        }

                        stopKeepAlive();
                        if (!clientGone) {
                            await writeFrame(stopFrame);
                            sseChunkCount++;
                            await writeFrame('data: [DONE]\n\n');
                            raw.end();
                        }
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
                        const promptStart = Date.now();
                        await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                        logDebug('Prompt sent', { sessionId, ms: Date.now() - promptStart });
                        const { content, reasoning, error } = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                        if (error && !content && !reasoning) {
                            return reply.code(502).send({
                                error: {
                                    message: error.data?.message || error.message || 'OpenCode provider error',
                                    type: error.name || 'OpenCodeError'
                                }
                            });
                        }
                        const safeContent = stripFunctionCalls(content);
                        const safeReasoning = stripFunctionCalls(reasoning);

                        const responsePayload = {
                            id: `chatcmpl-${Date.now()}`,
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
                        await cleanupSession();
                        return reply.send(responsePayload);
                    }
                } catch (error) {
                    // Upstream (opencode serve) call chain failed: always emitted at error level with status code and
                    // error-body summary; the full error object goes to debug level
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
                    reply.code(503).send({ error: { message: error.message, type: 'queue_full' } });
                }
                return reply;
            }
            logger.error('[Proxy] Request Handler Error:', { message: error.message, stack: error.stack });
            const payload = { error: { message: error.message, type: 'server_error' } };
            if (!reply.raw.headersSent) {
                if (hijacked) {
                    reply.raw.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                    reply.raw.end(JSON.stringify(payload));
                } else {
                    reply.code(500).send(payload);
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
    app.get('/health', { schema: { response: { 200: HEALTH_SCHEMA } } }, async (request, reply) =>
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

/**
 * Backend Lifecycle Management
 */
async function ensureBackend(config, options = {}) {
    const { OPENCODE_SERVER_URL, OPENCODE_PATH, OPENCODE_BIND_HOST, USE_ISOLATED_HOME } = config;
    const stateKey = OPENCODE_SERVER_URL;

    if (!backendState.has(stateKey)) {
        backendState.set(stateKey, {
            isStarting: false,
            process: null,
            jailRoot: null,
            healthyAt: 0,
            lastStartError: null,
            lastStartFailureAt: 0
        });
    }

    const state = backendState.get(stateKey);

    // A recent successful probe is trusted for BACKEND_HEALTH_CACHE_MS so a burst of chat requests shares one
    // health round trip instead of one per request; connection failures reset the timestamp (see chat error path)
    if (options.force !== true && BACKEND_HEALTH_CACHE_MS > 0 && state.healthyAt && Date.now() - state.healthyAt < BACKEND_HEALTH_CACHE_MS) {
        return;
    }

    if (state.isStarting) {
        // Wait for startup to complete
        for (let i = 0; i < STARTING_WAIT_ITERATIONS; i++) {
            await new Promise(r => setTimeout(r, STARTING_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL);
                state.healthyAt = Date.now();
                return;
            } catch (e) { }
            if (!state.isStarting) {
                // The other request finished its start attempt without the backend becoming reachable: fail now
                // instead of continuing to wait for a startup that is no longer running
                throw new Error(`OpenCode backend unavailable (last start attempt failed: ${state.lastStartError || 'unknown error'})`);
            }
        }
        throw new Error('Backend startup timeout');
    }

    try {
        await checkHealth(OPENCODE_SERVER_URL);
        state.healthyAt = Date.now();
        state.lastStartFailureAt = 0;
    } catch (err) {
        // Recent start attempt already failed: answer immediately instead of retrying the whole startup wait
        if (state.lastStartFailureAt && Date.now() - state.lastStartFailureAt < BACKEND_START_RETRY_COOLDOWN_MS) {
            throw new Error(`OpenCode backend unavailable (last start attempt failed: ${state.lastStartError || 'unknown error'})`);
        }
        state.isStarting = true;
        try {
            logger.info(`[Proxy] OpenCode backend not found at ${OPENCODE_SERVER_URL}. Starting...`);

            // Kill existing process if any
            if (state.process) {
                try {
                    state.process.kill();
                } catch (e) { }
            }

            // Cleanup old temp dir
            if (state.jailRoot && fs.existsSync(state.jailRoot)) {
                try {
                    fs.rmSync(state.jailRoot, { recursive: true, force: true });
                } catch (e) { }
            }

            const isWindows = process.platform === 'win32';
            const useIsolatedHome = typeof USE_ISOLATED_HOME === 'boolean'
                ? USE_ISOLATED_HOME
                : String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
                process.env.OPENCODE_USE_ISOLATED_HOME === '1';

            // On Windows, don't use isolated fake-home to avoid path issues
            // On Unix-like systems, use jail for isolation
            const salt = Math.random().toString(36).substring(7);
            const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail', salt);
            state.jailRoot = jailRoot;
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
            state.process = spawn(opencodeBin, ['serve', '--port', port, '--hostname', bindHost], spawnOptions);

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
                // emitting 'error'; stop waiting as soon as that happens
                if (state.process.exitCode !== null) {
                    spawnError = new Error(`OpenCode backend exited during startup (code ${state.process.exitCode})`);
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
        } finally {
            state.isStarting = false;
        }
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

    const config = {
        PORT: options.PORT || 8083,
        // Empty/blank values fall back to DEFAULT_API_KEY: authentication is always on
        API_KEY: resolveApiKey(options.API_KEY),
        OPENCODE_SERVER_URL: options.OPENCODE_SERVER_URL || 'http://127.0.0.1:4097',
        OPENCODE_BIND_HOST: options.OPENCODE_BIND_HOST || options.openCodeBindHost || process.env.OPENCODE_BIND_HOST || '127.0.0.1',
        OPENCODE_PATH: options.OPENCODE_PATH || 'opencode',
        BIND_HOST: options.BIND_HOST || options.bindHost || process.env.OPENCODE_PROXY_BIND_HOST || '127.0.0.1',
        // Raw LOG_LEVEL value: index.js already merged it as "env > config.json" and passes it in; when startProxy is
        // called directly, fall back to reading the environment variable
        LOG_LEVEL: options.LOG_LEVEL ?? options.logLevel ?? process.env.LOG_LEVEL ?? null,
        USE_ISOLATED_HOME: typeof options.USE_ISOLATED_HOME === 'boolean'
            ? options.USE_ISOLATED_HOME
            : String(options.USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            options.USE_ISOLATED_HOME === '1' ||
            String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_USE_ISOLATED_HOME === '1',
        REQUEST_TIMEOUT_MS: (() => {
            // A malformed value must fall back to the default: Number('abc') is NaN and setTimeout(NaN) fires
            // immediately, which would turn every completion into a 504
            const raw = Number(options.REQUEST_TIMEOUT_MS ?? process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS);
            return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_REQUEST_TIMEOUT_MS;
        })(),
        DISABLE_TOOLS: disableTools,
        DEBUG: String(options.DEBUG || '').toLowerCase() === 'true' ||
            options.DEBUG === '1' ||
            String(process.env.OPENCODE_PROXY_DEBUG || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_PROXY_DEBUG === '1'
    };

    // Log level resolution (calibrated at startup; all later log output follows this level):
    // 1) LOG_LEVEL (options/env, case-insensitive) 2) when not explicitly set but the legacy DEBUG switch is on,
    // promote to debug (backward compatible) 3) default info; invalid values fall back to info with a warning
    let levelResolution = logger.setLevel(config.LOG_LEVEL);
    if (!levelResolution.valid) {
        logger.warn(`Invalid LOG_LEVEL '${levelResolution.requested}', fallback to 'info' (valid values: error/warn/info/debug)`);
    } else if (!levelResolution.explicit && config.DEBUG) {
        levelResolution = logger.setLevel('debug');
    }
    config.LOG_LEVEL = logger.level;
    const levelSource = !levelResolution.explicit
        ? (config.DEBUG ? 'legacy DEBUG flag' : 'default')
        : 'LOG_LEVEL';

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
        killBackend: () => {
            const state = backendState.get(config.OPENCODE_SERVER_URL);
            if (state && state.process && state.process.exitCode === null && state.process.signalCode === null) {
                const child = state.process;
                try {
                    child.kill('SIGTERM');
                } catch (e) {
                    // already gone
                }
                // Escalate if the backend ignores SIGTERM; unref so this cannot hold the process open
                const escalated = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null) {
                        try {
                            child.kill('SIGKILL');
                        } catch (e) {
                            // already gone
                        }
                    }
                }, 3000);
                escalated.unref();
            }
            // Cleanup temp dir (only on non-Windows where we use jail)
            if (state && state.jailRoot && process.platform !== 'win32') {
                try {
                    fs.rmSync(state.jailRoot, { recursive: true, force: true });
                } catch (e) { }
            }
        }
    };
}
