#!/usr/bin/env node
/**
 * Minimal stand-in for a 2.x `opencode serve`, used by test/smoke.mjs (and therefore by CI).
 *
 * It implements only the routes the gateway's generated client drives, in the shapes that client expects:
 *   GET    /api/info                    the readiness probe (JSON, which is what tells a 1.x backend apart)
 *   GET    /api/model                   the model catalogue, `{data:[…]}` - flat, one entry per model
 *   GET    /api/provider                the provider list, `{location, data:[…]}` (the gateway no longer calls it)
 *   POST   /api/session                 `{data: session}`
 *   POST   /api/session/:id/prompt      `{data: <user inbox item>}` - 2.x answers with the item it enqueued
 *   GET    /api/session/:id/message     `{data:[…], cursor}` - newest first unless `order=asc`
 *   DELETE /api/session/:id             204, and 404 once it is gone
 *   GET    /api/event                   SSE, one `{"id","type","data"}` frame per event
 *   GET    /health, GET /               the web UI's HTML (2.x answers a page here, not a health payload)
 *   GET    /__sessions                  test-only introspection
 *
 * The answer is published the way 2.x publishes it - `session.text.delta` carries an *increment* and
 * `session.text.ended` the part's whole text - and stored on the session, so the polling fallback answers the same text.
 */
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT || 4199);
const HOST = process.env.STUB_HOST || '127.0.0.1';
const VERSION = '2.3.2';
const BASE = `http://${HOST}:${PORT}`;
// Default pause between two scripted steps: a stream that emits everything in one burst cannot exercise the idle
// timer, the keep-alive or an abort that lands mid-answer, so a small gap is the realistic baseline
const ANSWER_DELAY_MS = 15;
// How many pieces the default answer is chopped into: one delta per piece, so the SSE frames and the timers that
// guard them are exercised the way a real provider exercises them (a sentence is not one frame)
const DEFAULT_PIECES = 3;
// The 2.x serve is password-protected on every route; the SDK sends `Basic base64("opencode:<password>")`.
// `STUB_BASIC_AUTH=user:pass` reproduces that gate with a known credential, so a test can prove the gateway
// authenticates its backend calls (and that the credential never reaches a client-facing body)
const BASIC_AUTH_HEADER = process.env.STUB_BASIC_AUTH
    ? `Basic ${Buffer.from(process.env.STUB_BASIC_AUTH).toString('base64')}`
    : '';
// An empty catalogue: the first call answers with no model at all, later calls with one entry that yields nothing
// usable, so both shapes of "the provider reported nothing" are covered
const EMPTY_PROVIDERS = process.env.STUB_EMPTY_PROVIDERS === '1';
// A failing catalogue (a proxy in front of the backend, a version whose route moved): the gateway must fall back to
// its static model instead of reporting an empty provider list
const FAIL_PROVIDERS = process.env.STUB_FAIL_PROVIDERS === '1';
// A backend that refuses POST /api/session because the gateway's API is not the one it speaks
const FAIL_SESSION = process.env.STUB_FAIL_SESSION === '1';
// A backend that refuses POST /api/session because it rejected the permission ruleset (a tool switch the server does
// not know): 400 is a declared status, so the client surfaces it as `InvalidRequestError` with the reason
const REJECT_PERMISSIONS = process.env.STUB_REJECT_PERMISSIONS === '1';
// Accept the session and then drop the connection before answering: what a backend that dies between accepting the call
// and writing the answer looks like. A gateway that retries it creates a second session and loses the id of the first
const DROP_CREATE = process.env.STUB_DROP_CREATE === '1';
// A `POST /api/session` that answers with the headers and a body that stops in the middle of the JSON, then destroys the
// socket: what a backend that died *while writing its answer* looks like. Nothing is recorded, so `/__sessions` reports
// `created: 0` and the id in the truncated body never reaches the gateway - a gateway that read it would try to delete
// a session nobody ever created.
const PARTIAL_CREATE = process.env.STUB_PARTIAL_CREATE === '1';
// A backend that wedges on this session creation (1-based) and never answers
const HANG_CREATE_AFTER = Number(process.env.STUB_HANG_CREATE_AFTER || 0);
// A backend whose socket dies for the first `n` session creations, before a session is made: what a backend that
// accepted `POST /api/session` and then died looks like from the client's side. This is **not** the case the gateway
// retries (`isConnectionRefused()` needs a refused *connection*, and dropping an accepted socket is `ECONNRESET`), so
// it pins the other half of that rule: no second create, and the orphan it would leave behind never appears.
// A genuine refusal is not reproducible against a live stub: the retry re-probes `/api/info` before its second call,
// so the port would have to be closed for the create and open again microseconds later.
const RESET_CREATE_TIMES = Number(process.env.STUB_RESET_CREATE_TIMES || 0);
// A backend that takes a while to answer POST /api/session, so a completion that waited for a queue slot can be
// granted a fresh request budget for a call that was already answered
const CREATE_DELAY_MS = Number(process.env.STUB_CREATE_DELAY_MS || 0);
// Refuse POST /api/session with a reason that quotes a URL carrying a credential, the way a proxy in front of the
// backend does when it cannot reach it
const URL_IN_ERROR = process.env.STUB_URL_IN_ERROR === '1';
// Refuse POST /api/session with the authorization header quoted back (a proxy reporting the credential it rejected)
const ECHO_AUTH = process.env.STUB_ECHO_AUTH === '1';
// Refuse POST /api/session with a megabyte of JSON in the body, for the log summary bound
const BIG_ERROR_BODY = process.env.STUB_BIG_ERROR_BODY === '1';
// Refuse GET /api/event with a 500, so a test can prove a streaming request still answers from the polling fallback
const FAIL_EVENTS = process.env.STUB_FAIL_EVENTS === '1';
// Fail the first N polls of a session's messages with a 500 (a transient backend hiccup), or every poll, so a test can
// prove the gateway retries a failed poll and gives up in bounded time
const FAIL_MESSAGES = Number(process.env.STUB_FAIL_MESSAGES || 0);
const ALWAYS_FAIL_MESSAGES = process.env.STUB_ALWAYS_FAIL_MESSAGES === '1';
const DROP_MESSAGES = Number(process.env.STUB_DROP_MESSAGES || 0);
// A 2xx whose body is not a message list at all (a proxy in front of the backend answering its own page)
const UNREADABLE_MESSAGES = process.env.STUB_UNREADABLE_MESSAGES === '1';
// Accepted for the 1.x suite: 2.x has no tool-list route, so nothing is counted and nothing changes
const FAIL_TOOL_IDS = process.env.STUB_FAIL_TOOL_IDS === '1';
// Refuse DELETE /api/session/:id with a 500 and keep the session
const REJECT_DELETES = process.env.STUB_REJECT_DELETES === '1';
// Answer a session that *is* in the store with a 404, the shape a backend whose store was reset produces
const GONE_DELETES = process.env.STUB_GONE_DELETES === '1';
// Accept a DELETE and never answer it
const HANG_DELETES = process.env.STUB_HANG_DELETES === '1';

// The stub's answer is a **constant**, not a variable: the suite carries its own copy of both sentences and asserts the
// gateway relays them verbatim (30-odd checks), so an override here would fail all of them while looking like a
// regression in the gateway. `STUB_ANSWER` / `STUB_REASONING` existed and were documented nowhere; change the sentence
// here and in `test/smoke.mjs` together instead.
export const ANSWER = 'Hello from the smoke test stub.';
export const REASONING = 'Thinking about the request.';
// An answer long enough that splitting it produces many more deltas than a sentence would (the idle timer is re-armed
// on every one of them). Kept in step with MANY_DELTAS_ANSWER in test/smoke.mjs.
export const MANY_DELTAS_ANSWER = Array.from({ length: 60 }, (_, index) => `part${index}`).join(' ');
export const LAGSTORE_ANSWER = 'The frames carry the whole answer, but the stored message lags behind them by a wide margin.';
const SHRINK_ANSWER = 'alpha beta gamma';
const MULTIPART_FIRST = 'alpha beta gamma';
const MULTIPART_SECOND = 'ALPHA BETA GAMMA';
const REASON_ONLY_TEXT = 'thinking only';
const BAD_PART_TEXT = 'Alpha';
const TOOL_TAG_ANSWER = 'hello <function_calls>secret</function_calls> world';
const TAIL_TAG_ANSWER = 'hello world <function_call';
// A closing tag with no block at all: the filter drops the tag and keeps the text around it (`aaaabbbb`)
const STRAY_TAG_ANSWER = 'aaaa</function_calls>bbbb';
// An opening tag that never closes: the tag is dropped and the text after it is kept
const OPEN_TAIL_ANSWER = 'visible text <function_calls>tail words here';
const TOOL_ANSWER = 'hello <function_calls>{"name":"shell"}</function_calls> world';
const TOOL_SPAM_ANSWER = '<function_calls>'.repeat(64000) + 'done';
const TWO_STEP_EARLIER = 'STEP ONE TEXT';
const TWO_STEP_FINAL = 'THE FINAL ANSWER';
// A provider that fails after it has written text (prompt marker FAILMID): the finishing event carries `error` next to
// `time.completed`, so the answer has to end as a failure, not as `finish_reason: "stop"`
const FAIL_MID_ANSWER = 'partial answer';
// A provider error whose own message quotes a credential-bearing URL and 2 KB of trailing text (prompt marker
// LEAKYFAIL): a provider says exactly this when it rejects a key, and both answer modes have to mask and bound it
// before the text becomes a client-facing body or log line.
const LEAKY_ERROR_TEXT = `provider rejected http://alice:s3cr3t-value@127.0.0.1:4097/proxy?token=abc123 and the upstream answered with a very long explanation ${'y'.repeat(2000)}`;
// Prompt marker MANYMESSAGES: a session with more messages than one page holds, all of them finished and each carrying a
// distinguishable text, so a poll that asks for the oldest page (or forgets `order=desc`, `limit` or `type`) serves one
// of the archived answers instead of the message the request just produced. Kept in step with the copies in
// test/smoke.mjs.
const MANY_MESSAGES_OLDER = 60;
const MANY_MESSAGES_OLD_PREFIX = 'archived answer';
const MANY_MESSAGES_NEWEST = 'the newest stored answer wins';
// Prompt marker BIGANSWER: an answer larger than the gateway's per-answer buffer cap (`MAX_ANSWER_CHARS`, 16 M chars),
// streamed in pieces so the deltas - not one closing snapshot - are what carries it. Kept in step with the copy in
// test/smoke.mjs.
const BIG_ANSWER_CHARS = 17 * 1024 * 1024;
const BIG_ANSWER_PIECES = 34;
const bigAnswerText = `${'0123456789abcdef'.repeat(BIG_ANSWER_CHARS / 16)}`;

const sessions = new Map();
let sessionSeq = 0;
let deletedSessions = 0;
let providerCalls = 0;
// How many times the 1.x tool-list route was asked for. 2.x has no such route and the gateway no longer builds a
// per-tool override map, so the count must stay 0 - and this counter is what makes that assertion falsifiable. It used
// to be declared and never incremented, so `toolIdCalls === 0` held no matter what the gateway did, and nothing
// answered the route either: a gateway that started calling `/api/tool/ids` again could not have been caught.
let toolIdCalls = 0;
let messagePolls = 0;
// The `order`/`cursor`/`limit`/`type` of each message poll, newest last (bounded).
const messagePollQueries = [];
// How many readiness probes (`GET /api/info`) the stub has seen. `/health` must never touch the backend, so a suite
// that reads this around a burst of `/health` requests can prove it instead of trusting the handler.
let infoCalls = 0;
let promptedSessions = 0;
let lastSystemPrompt = '';
let lastPromptText = '';
// The permission ruleset of the most recent POST /api/session: 2.x replaced the 1.x per-tool override map with a
// ruleset handed to session create, so this is where a test reads what the gateway actually sent
let lastPermissionRules = null;
// The `permissions` of every successful `POST /api/session`, in order. A gateway that retries a refused connection has
// to send the ruleset on the retry too, and that is only visible by looking past the first entry.
const sessionCreatePermissions = [];
// How many `POST /api/session` calls the stub has seen, so a refusal can be limited to the first few
let createCalls = 0;
// The largest number of messages any session has held. A poll over a "long session" is only over a long session if the
// backend really stored that many, and this is how a test proves it instead of trusting the prompt marker.
let largestSessionMessages = 0;
const eventClients = new Set();
let eventSeq = 0;
// The `types` parameter of every `GET /api/event` subscription, in order (one entry per subscription, each entry the
// list that request asked for). A streaming answer is incremental only because the collector subscribes with the event
// types it collects, and the query it sends is the one thing about that subscription a test can observe.
const eventSubscriptionQueries = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventId = () => `evt_${++eventSeq}`;

/**
 * The model catalogue.
 *
 * Flat, one entry per model, with the bare model name in `id` and the provider in `providerID`: the gateway builds
 * `<providerID>/<id>` itself. `big-pickle` is the alias the gateway hardcodes, and the last two entries exist to prove
 * the gateway skips a model that is disabled or no longer active instead of publishing it.
 */
const modelInfo = (id, name, overrides = {}) => ({
    id,
    modelID: id,
    providerID: 'opencode',
    name,
    type: 'language',
    family: 'opencode',
    capabilities: { tools: true, reasoning: false, streaming: true },
    variants: {},
    status: 'active',
    enabled: true,
    limit: { context: 128000, output: 8192 },
    cost: { input: 0, output: 0 },
    time: { released: '2025-01-01T00:00:00.000Z' },
    ...overrides
});
// A provider that publishes a model name that is not a string (a number, an object). The gateway must still answer
// with the documented `{id,name,object,owned_by}` shape on both the warm and the cold path: the warm cache sends the
// entry it built verbatim, so an unvalidated `name` reached the client as a number, while the cold path coerced the
// same entry through the response schema - one listing, two shapes, decided only by cache warmth.
const ODD_MODEL_NAMES = process.env.STUB_ODD_MODEL_NAMES === '1';
const ODD_MODELS = [
    modelInfo('odd-name', 7),
    modelInfo('odd-object', { label: 'Odd' }),
    modelInfo('odd-empty', '')
];
const MODELS = [
    modelInfo('big-pickle', 'Big Pickle'),
    modelInfo('kimi-k2.5-free', 'Kimi K2.5 Free', { capabilities: { tools: false, reasoning: true, streaming: true } }),
    modelInfo('gpt-5-mini-free', 'GPT-5 Mini Free', { capabilities: { tools: false, reasoning: false, streaming: true } }),
    modelInfo('some-other-model', 'Some Other Model'),
    modelInfo('retired-model', 'Retired Model', { status: 'deprecated' }),
    modelInfo('hidden-model', 'Hidden Model', { enabled: false })
];
const PROVIDERS = [
    {
        id: 'opencode',
        name: 'opencode',
        activation: { source: 'environment' },
        package: '@opencode/client',
        compatibility: { version: VERSION }
    }
];

const sendJson = (res, status, payload, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
};
const sendError = (res, status, tag, message) => sendJson(res, status, { _tag: tag, message });
const sendEvent = (event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of eventClients) client.write(frame);
};
const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
});

/**
 * A 2.x assistant message: flat, with the answer in `content` (`[{type:'text'|'reasoning', text}]`) and no `role`.
 * `finish` is absent while the message is still being written, which is what keeps the poll loop waiting.
 */
const assistantMessage = (sessionID, id, content, options = {}) => {
    const { finish = null, error = null, completed = true } = options;
    return {
        id,
        sessionID,
        type: 'assistant',
        agent: 'build',
        model: { providerID: 'opencode', id: 'kimi-k2.5-free' },
        time: { created: Date.now(), ...(completed ? { completed: Date.now() } : {}) },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        content,
        ...(finish ? { finish } : {}),
        ...(error ? { error } : {})
    };
};

/**
 * The 1.x prompt-response payload: `{info, parts}`.
 *
 * 2.x answers a prompt with the user inbox item, so nothing in the protocol produces this any more - but the gateway
 * still recognises it on purpose, and the suite asserts the round trip it saves. It travels in the **single** envelope a
 * 1.x server sent (`{"data":{info,parts}}`), which the 2.x client unwraps to `{info, parts}`: the shape the gateway's
 * `completedPromptMessage()` has to read. An extra `data` here would test a body no server produces.
 */
const legacyMessage = (sessionID, text, reasoning = '', finish = 'stop') => ({
    info: {
        id: `msg_${sessionID}`,
        sessionID,
        role: 'assistant',
        finish,
        time: { created: Date.now(), completed: Date.now() }
    },
    parts: [
        ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
        { type: 'text', text }
    ]
});

/** The user inbox item a 2.x prompt answers with. */
const inboxItem = (sessionID, text) => ({
    id: `inbox_${sessionID}_${promptedSessions}`,
    sessionID,
    type: 'user',
    time: { created: Date.now() },
    payload: { text },
    delivery: 'immediate'
});

/** Splits a text field by piece count into roughly equal parts. */
const chunkText = (text, pieces) => {
    const count = Math.max(1, Math.min(pieces, text.length || 1));
    const step = Math.ceil(text.length / count) || 1;
    const parts = [];
    for (let i = 0; i < text.length; i += step) parts.push(text.slice(i, i + step));
    return parts;
};

/**
 * 2.x sends one text string, so the system prompt and the labelled conversation arrive joined by a blank line. The
 * split is that first blank line *if* a role label follows it; `lastSystemPrompt` stays empty otherwise, which is
 * what the suite reads to prove a system message never reached the model as a `SYSTEM:` part.
 */
const splitPromptText = (text) => {
    // A conversation that opens with a role label has no system prompt, however many turns follow it: the blank line
    // between two turns is not the join, and reading it as one reported "USER: first turn" as the system prompt
    if (/^(?:USER|ASSISTANT|SYSTEM|DEVELOPER):/.test(text)) return { system: '', conversation: text };
    const match = /\n\n(?=(?:USER|ASSISTANT|SYSTEM|DEVELOPER):)/.exec(text);
    if (!match) return { system: '', conversation: text };
    return { system: text.slice(0, match.index), conversation: text.slice(match.index + 2) };
};

/**
 * Builds the event script for one answer.
 *
 * 2.x splits a part's life across events that each carry a different amount of the same text: `session.text.delta`
 * carries an increment, `session.text.ended` the part's whole text. A gateway that appends both therefore duplicates
 * the answer, which is why the closing event is diffed against what the deltas added up to.
 * `onPiece` keeps the stored message in step with the stream for the markers whose store must lag or stop short.
 */
const answerSteps = (session, options = {}) => {
    const {
        text,
        reasoning = '',
        chunks = null,
        pieces = DEFAULT_PIECES,
        delayMs = ANSWER_DELAY_MS,
        ordinal = 0,
        withId = true,
        pauseAfterFirstMs = 0,
        onPiece = null,
        finish = 'stop',
        close = true,
        endPart = true
    } = options;
    const envelope = (extra) => ({
        sessionID: session.id,
        ...(withId ? { assistantMessageID: session.messageId } : {}),
        ordinal,
        ...extra
    });
    const steps = [{ type: 'session.step.started', data: envelope({}) }];
    if (reasoning) {
        steps.push({ type: 'session.reasoning.started', data: envelope({}) });
        steps.push({ type: 'session.reasoning.delta', data: envelope({ delta: reasoning }) });
        steps.push({ type: 'session.reasoning.ended', data: envelope({ text: reasoning }) });
    }
    steps.push({ type: 'session.text.started', data: envelope({}) });
    let running = '';
    const deltas = (chunks || chunkText(text, pieces)).map((part) => {
        running += part;
        return { part, snapshot: running };
    });
    deltas.forEach((delta, index) => {
        // A pause before the second delta is silence in the middle of an answer, not a pause before it starts
        const wait = index === 0 ? 0 : (index === 1 && pauseAfterFirstMs ? pauseAfterFirstMs : delayMs);
        steps.push({
            type: 'session.text.delta',
            data: envelope({ delta: delta.part }),
            wait,
            onEmit: onPiece ? () => onPiece(delta.snapshot) : null
        });
    });
    // A stream that is cut mid-answer never closes its part: `endPart: false` leaves the deltas as the last thing the
    // subscriber sees, which is what makes the gateway fall back to the stored message instead of settling on a part
    // the backend never finished
    if (endPart) steps.push({ type: 'session.text.ended', data: envelope({ text }), wait: delayMs });
    if (close) {
        steps.push({
            type: 'session.step.ended',
            data: envelope({ finish, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
            wait: delayMs
        });
    }
    return steps;
};

/**
 * Plays a scripted answer on the event stream.
 *
 * The wait for a subscriber is bounded: a non-streaming completion never subscribes, and its answer comes from the
 * stored message instead, so waiting forever would only park the handler.
 */
const playSteps = async (steps) => {
    for (let i = 0; i < 200 && eventClients.size === 0; i += 1) await sleep(5);
    for (const step of steps) {
        if (step.wait) await sleep(step.wait);
        if (step.type === 'stream.end') {
            for (const client of eventClients) client.end();
            eventClients.clear();
            continue;
        }
        sendEvent({ id: eventId(), type: step.type, data: step.data });
        if (step.onEmit) step.onEmit();
    }
};

const startSteps = (session, steps) => {
    playSteps(steps).catch(() => {});
    void session;
};

const server = http.createServer(async (req, res) => {
    let url;
    try {
        url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    } catch {
        return sendError(res, 400, 'InvalidRequestError', 'a request target is required');
    }
    const path = url.pathname;

    // Every route is behind the password in 2.x, including /api/info: the gateway has to send the credential its
    // backend URL carries to learn whether the backend is there at all
    if (BASIC_AUTH_HEADER && req.headers.authorization !== BASIC_AUTH_HEADER) {
        return sendJson(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' }, {
            'www-authenticate': 'Basic realm="opencode"'
        });
    }

    // The 2.x serve answers the web UI here. A probe that expects a JSON health payload is looking at a 1.x backend
    // (or should be reading /api/info); the suite only needs a 200 to know the process is up.
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html><head><title>opencode</title></head><body><div id="app"></div></body></html>');
    }

    // The readiness probe: a 1.x backend answers /health with JSON and has no /api/* route at all, so this is the
    // route that tells the two apart (and it must answer JSON, not the web UI's HTML)
    if (req.method === 'GET' && path === '/api/info') {
        infoCalls += 1;
        return sendJson(res, 200, {
            version: VERSION,
            pid: process.pid,
            hostname: HOST,
            urls: { api: `${BASE}/api`, ui: BASE },
            paths: { home: process.env.HOME || process.env.USERPROFILE || '/', config: '' },
            capabilities: {}
        });
    }

    // The model catalogue: flat, one entry per model, behind the same envelope every 2.x collection uses
    if (req.method === 'GET' && path === '/api/model') {
        providerCalls += 1;
        if (FAIL_PROVIDERS) {
            return sendJson(res, 500, { error: { message: 'model catalogue unavailable' } });
        }
        // The first call is an empty catalogue; later ones carry a single entry with no usable fields, so both shapes
        // of "the provider reported nothing" end at the gateway's fallback model
        return sendJson(res, 200, { data: EMPTY_PROVIDERS ? (providerCalls === 1 ? [] : [{}]) : (ODD_MODEL_NAMES ? ODD_MODELS : MODELS) });
    }

    // The provider list. The 2.x gateway reads the catalogue from /api/model, so nothing calls this any more; it stays
    // because the route exists on a real server and a translating client may still ask for it
    if (req.method === 'GET' && path === '/api/provider') {
        return sendJson(res, 200, { location: `${BASE}/api/provider`, data: PROVIDERS });
    }

    // The 1.x tool-list route. 2.x does not serve it, so the gateway must never ask: counting the request is what turns
    // "the gateway asks nothing" into an assertion, and the answer mimics the 1.x shape for the same reason the other
    // accepted no-ops are kept (a release or a translating proxy that starts answering here again keeps its meaning).
    if (req.method === 'GET' && path === '/api/tool/ids') {
        toolIdCalls += 1;
        if (FAIL_TOOL_IDS) return sendError(res, 500, 'InternalServerError', 'tool list unavailable');
        return sendJson(res, 200, { location: `${BASE}/api/tool/ids`, data: ['bash', 'edit', 'read', 'write'] });
    }

    if (req.method === 'POST' && path === '/api/session') {
        if (URL_IN_ERROR) {
            // **400, not 502**: the generated 2.x client declares 400/401/404 for this route and throws a typed
            // `InvalidRequestError` carrying the body's message. Any other status arrives as a bare `ClientError`
            // (`UnexpectedStatus: 502`) that keeps only `cause.status` and **discards the body**, so a reason quoted
            // here could never reach a client or a log line. The sentence still quotes a credential-bearing URL, which
            // is what proves the masking on that path.
            return sendError(res, 400, 'InvalidRequestError',
                'cannot reach http://alice:s3cr3t-value@127.0.0.1:4097/proxy?token=abc123 (connection refused)');
        }
        // A proxy in front of the backend reporting the credential it rejected: the gateway copies this sentence into
        // a client-facing body and into its log, so both have to mask the header it quotes. The value is quoted, which
        // is the shape the masking helpers recognise as a credential rather than prose
        if (ECHO_AUTH) {
            return sendError(res, 401, 'UnauthorizedError',
                `invalid token: "${req.headers.authorization || '(none)'}" (token=abc123def456)`);
        }
        if (BIG_ERROR_BODY) {
            // **400 and the declared `{_tag, message}` shape**, for the same reason as URL_IN_ERROR: an undeclared status
            // (500) is reduced to `UnexpectedStatus: 500` and a body that does not decode into the declared error is
            // kept on `.error` with an empty message - in both cases the megabyte never reaches the gateway, so the
            // summary bound would be tested against nothing. `message` is the payload: a megabyte of backend text in
            // the one field the client hands over as the error's message, with a nested `detail` beside it so the
            // extraction still has to bound a tree rather than copy a string.
            return sendJson(res, 400, {
                _tag: 'InvalidRequestError',
                message: 'x'.repeat(1024 * 1024),
                detail: { nested: ['y'.repeat(200 * 1024)] }
            });
        }
        // A ruleset the server refuses. 400 is a declared status for this route, so the client surfaces the body as an
        // `InvalidRequestError` whose message names the reason instead of an opaque status
        if (REJECT_PERMISSIONS) {
            return sendError(res, 400, 'InvalidRequestError', 'Invalid permissions ruleset');
        }
        // A build whose session API is not there. **404, not 405**: 404 is declared for this route, so the 2.x client
        // throws a typed error carrying the body's message; 405 is undeclared and arrives as a bare `ClientError` that
        // discards the body, so the reason would be lost before the gateway could name it. Both statuses mean the same
        // thing to the gateway (the "probably a 1.x release" warning).
        if (FAIL_SESSION) {
            return sendError(res, 404, 'NotFoundError', 'session creation is not supported by this build');
        }
        let body = {};
        try {
            body = JSON.parse((await readBody(req)) || '{}');
        } catch {
            body = {};
        }
        // The whole ruleset is kept as it arrived: 2.x replaced the 1.x per-tool override map with a permission
        // ruleset on session create, and this is what a test reads to prove which tools the gateway denied.
        // Recorded for **every** call, refused ones included: a call that never produced a session is still a call the
        // gateway made, and "how many creates did it attempt" is what the no-retry rule is asserted on.
        lastPermissionRules = body.permissions ?? null;
        sessionCreatePermissions.push(body.permissions ?? null);
        createCalls += 1;
        if (PARTIAL_CREATE) {
            // Headers and a body that stops mid-JSON, then the socket goes away: a backend that read the call and died
            // while writing its answer. No session is recorded, so `created` stays 0 - and the id in the truncated body
            // (`ses_partial`) must never reach the gateway, because a gateway that read it would answer from a session it
            // cannot see and then try to delete a session nobody made. The bytes are written before the destroy: dropping
            // the socket with them still buffered is the `ECONNRESET`-before-any-body shape, not a truncated answer.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{"data":{"id":"ses_partial","time":');
            setTimeout(() => res.destroy(), 10).unref();
            return;
        }
        if (createCalls <= RESET_CREATE_TIMES) {
            // The connection is dropped before the session exists, so the id never reaches the gateway: what a backend
            // that accepted the call and then died looks like. `fetch` reports `ECONNRESET`/`socket hang up`, which is
            // deliberately *not* the refused-connection case the gateway retries - retrying it is what orphaned a session.
            return req.socket.destroy();
        }
        if (HANG_CREATE_AFTER > 0 && sessionSeq >= HANG_CREATE_AFTER) return;
        if (CREATE_DELAY_MS) await sleep(CREATE_DELAY_MS);
        sessionSeq += 1;
        // Every created session's ruleset, not just the last one: "which tools did each session deny" has to be
        // provable per session, and one global `lastPermissionRules` is overwritten by whichever call finished last.
        const session = { id: `ses_${sessionSeq}`, time: { created: Date.now() }, title: 'smoke test', permissionRules: lastPermissionRules, messages: [], messageId: null, promptText: '' };
        sessions.set(session.id, session);
        // Accepted, **then** the connection goes away without an answer: what a backend that dies between accepting the
        // call and writing the reply looks like. The session is recorded first, because the whole point of the marker is
        // that the id was lost on the way back - a gateway that retries the call creates a second session and leaves the
        // first one alive with nobody able to delete it, which is what `/__sessions` is read for. Destroying the socket
        // before recording it would have made the check pass with `created: 0`.
        if (DROP_CREATE) return req.socket.destroy();
        return sendJson(res, 200, { data: session });
    }

    if (req.method === 'GET' && path === '/__sessions') {
        return sendJson(res, 200, {
            live: sessions.size,
            created: sessionSeq,
            deleted: deletedSessions,
            prompts: promptedSessions,
            providerCalls,
            infoCalls,
            toolIdCalls,
            messagePolls,
            messagePollQueries,
            lastSystemPrompt,
            lastPromptText,
            lastPermissionRules,
            sessionCreatePermissions,
            eventSubscriptionQueries,
            largestSessionMessages
        });
    }

    // One event stream for the whole server, as in 2.x: every session publishes to it and the client filters by
    // `sessionID`. A subscriber that has not appeared when an answer is emitted is simply a non-streaming request.
    if (req.method === 'GET' && path === '/api/event') {
        if (FAIL_EVENTS) return sendError(res, 500, 'ServiceUnavailableError', 'event stream unavailable');
        // Recorded before the stream is opened, so even a subscription the gateway aborts immediately is visible: the
        // generated client sends an array as a repeated `types` parameter
        eventSubscriptionQueries.push(url.searchParams.getAll('types'));
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
        });
        // Some comment line: it is written first so that the connected event is followed by something other than an
        // event, which is what a client skipping non-data lines has to survive
        res.write(': connected\n\n');
        eventClients.add(res);
        req.on('close', () => eventClients.delete(res));
        return;
    }

    const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(path);
    if (promptMatch && req.method === 'POST') {
        const session = sessions.get(promptMatch[1]);
        if (!session) return sendError(res, 404, 'SessionNotFoundError', `unknown session ${promptMatch[1]}`);
        let body = {};
        try {
            body = JSON.parse((await readBody(req)) || '{}');
        } catch {
            body = {};
        }
        // 2.x has one `text` field: the system prompt and the labelled conversation arrive joined by a blank line
        const text = typeof body.text === 'string' ? body.text : '';
        const split = splitPromptText(text);
        lastSystemPrompt = split.system;
        lastPromptText = split.conversation;
        session.promptText = text;
        promptedSessions += 1;

        if (text.includes('REJECTPROMPT')) {
            // 400, not 500: 400 is declared for this route, so the 2.x client throws a typed `InvalidRequestError`
            // carrying the body's message. A 500 is undeclared and arrives as a bare `ClientError`
            // (`UnexpectedStatus: 500`) that keeps only `cause.status` and drops the body - the gateway would answer
            // `502` either way, but the reason the backend gave would be gone.
            return sendError(res, 400, 'InvalidRequestError', 'provider refused the prompt');
        }
        // A turn the gateway would otherwise read as a finished message it already holds: the answer is served from
        // the prompt response and no message is stored, so a poll would find nothing (which is what proves the fast
        // path was used)
        if (text.includes('PROMPTDONE')) {
            return sendJson(res, 200, { data: legacyMessage(session.id, ANSWER, REASONING) });
        }
        if (text.includes('PROMPTTOOLCALLS')) {
            // The prompt response carries a *finished* step that only asked for a tool (`finish: "tool-calls"`) and
            // the step that answers it is stored. Serving the prompt response handed the client the model's preamble
            // for a request that went on to run a tool and answer, so the poll loop reads the newest message instead
            const stepId = `msg_${session.id}_step`;
            session.messages.push(assistantMessage(session.id, stepId, [{ type: 'text', text: TWO_STEP_EARLIER }], { finish: 'tool-calls' }));
            const answer = assistantMessage(session.id, `msg_${session.id}_answer`, [{ type: 'text', text: ANSWER }]);
            session.messages.push(answer);
            session.messageId = answer.id;
            return sendJson(res, 200, { data: legacyMessage(session.id, TWO_STEP_EARLIER, '', 'tool-calls') });
        }
        if (text.includes('BADPART')) {
            // A part whose `text` is a number instead of a string, next to a normal one: only the string is answer text
            session.messages.push(assistantMessage(session.id, `msg_${session.id}`, [
                { type: 'text', text: 42 },
                { type: 'text', text: BAD_PART_TEXT }
            ], { finish: null, completed: false }));
        } else if (text.includes('REASONONLY')) {
            // A message that carries reasoning and no text, and is never marked finished: the stall window has to
            // watch the reasoning too, or the gateway polls until its whole budget and answers 504
            session.messages.push(assistantMessage(session.id, `msg_${session.id}`, [
                { type: 'reasoning', text: REASON_ONLY_TEXT }
            ], { finish: null, completed: false }));
        } else if (text.includes('TOOLSPAM')) {
            // A tool-call block repeated until the answer is megabytes wide: a lazy/backtracking markup scan wedges
            // the only completion slot (plus the EPIPE a closed devNull stdout used to cause)
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: TOOL_SPAM_ANSWER }]);
            session.messages.push(message);
            session.messageId = message.id;
        } else if (text.includes('MANYMESSAGES')) {
            // More messages than one page holds, every one of them finished and distinguishable, and the newest pushed
            // last: a poll that asks for the oldest page - or forgets `order=desc`, `limit` or `type` - serves one of
            // the archived answers instead of the message this request just produced. Nothing is streamed, so the
            // non-streaming poll loop is what answers.
            for (let i = 0; i < MANY_MESSAGES_OLDER; i += 1) {
                session.messages.push(assistantMessage(session.id, `msg_${session.id}_old_${i}`, [
                    { type: 'text', text: `${MANY_MESSAGES_OLD_PREFIX} ${i}` }
                ], { finish: 'stop' }));
            }
            const newest = assistantMessage(session.id, `msg_${session.id}_newest`, [
                { type: 'text', text: MANY_MESSAGES_NEWEST }
            ], { finish: 'stop' });
            session.messages.push(newest);
            session.messageId = newest.id;
        } else if (text.includes('TWOSTEP')) {
            // The step that used a tool, then the step that answers. The second is still *being written* when the
            // prompt returns, so a gateway that reads the first finished message answers with the preamble
            session.messages.push(assistantMessage(session.id, `msg_${session.id}_step`, [{ type: 'text', text: TWO_STEP_EARLIER }], { finish: 'tool-calls' }));
            const final = assistantMessage(session.id, `msg_${session.id}_final`, [{ type: 'text', text: TWO_STEP_FINAL.slice(0, 5) }], { finish: null, completed: false });
            session.messages.push(final);
            session.messageId = final.id;
            setTimeout(() => {
                final.content[0].text = TWO_STEP_FINAL;
                final.finish = 'stop';
                final.time.completed = Date.now();
            }, 400).unref();
        } else if (text.includes('GROW')) {
            // The stored answer keeps growing after the prompt returned: polling once serves a truncated answer
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: ANSWER.slice(0, 12) }], { finish: null, completed: false });
            session.messages.push(message);
            session.messageId = message.id;
            setTimeout(() => {
                message.content[0].text = ANSWER;
                message.finish = 'stop';
                message.time.completed = Date.now();
            }, 150).unref();
        } else if (text.includes('SLOWFINISH')) {
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: ANSWER.slice(0, 12) }], { finish: null, completed: false });
            session.messages.push(message);
            session.messageId = message.id;
            setTimeout(() => {
                message.content[0].text = ANSWER;
                message.finish = 'stop';
                message.time.completed = Date.now();
            }, 3000).unref();
        } else if (text.includes('HOLD')) {
            // Finishes after 400ms: a completion that stays in flight while the backend is killed
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: ANSWER.slice(0, 12) }], { finish: null, completed: false });
            session.messages.push(message);
            session.messageId = message.id;
            setTimeout(() => {
                message.content[0].text = ANSWER;
                message.finish = 'stop';
                message.time.completed = Date.now();
            }, 400).unref();
        } else if (text.includes('SUICIDE')) {
            // A backend that dies right after accepting the prompt: a request that started before the death must not
            // be retried, and the next one has to recover (the suite asserts no completion ever returns 502)
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            setTimeout(() => process.kill(process.pid, 'SIGKILL'), 25).unref();
            return;
        } else if (text.includes('STALL')) {
            // Two deltas and then silence forever: the idle timer alone can end this turn, and nothing is stored for
            // the polling fallback to find
            const steps = answerSteps(session, { text: ANSWER.slice(0, 16), reasoning: REASONING, close: false, endPart: false });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        } else if (text.includes('FAIL') || text.includes('LEAKYFAIL') || text.includes('FAILMID')) {
            // A provider failure: the message is stored with the error and never finished. A streaming request is told
            // through `session.execution.failed`, which is the only 2.x event that carries one
            const leaky = text.includes('LEAKYFAIL');
            const message = leaky ? LEAKY_ERROR_TEXT : 'Provider Error: the model provider returned an error';
            const partial = text.includes('FAILMID') ? FAIL_MID_ANSWER : null;
            session.messages.push(assistantMessage(session.id, `msg_${session.id}`, partial
                ? [{ type: 'text', text: partial }]
                : [], { finish: null, error: { name: 'ProviderError', data: { message } } }));
            const steps = partial
                ? answerSteps(session, { text: partial, pieces: 2, close: false, endPart: false })
                : [];
            steps.push({ type: 'session.execution.failed', data: { sessionID: session.id, error: { name: 'ProviderError', data: { message } } } });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        } else if (text.includes('CUTSTREAM')) {
            // A stream cut mid-answer: the gateway has to resume from the stored message instead of answering with
            // what it managed to collect. The store already holds the whole answer; the frames carry only its start
            const message = assistantMessage(session.id, `msg_${session.id}`, [
                { type: 'reasoning', text: REASONING },
                { type: 'text', text: ANSWER }
            ]);
            session.messages.push(message);
            session.messageId = message.id;
            const cut = Math.floor(ANSWER.length / 2);
            const steps = answerSteps(session, {
                text: ANSWER.slice(0, cut),
                reasoning: REASONING,
                pieces: 2,
                close: false,
                endPart: false
            });
            steps.push({ type: 'stream.end' });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        } else if (text.includes('LAGSTORE')) {
            // The stream delivers the whole answer while the stored message keeps only its first characters, then the
            // stream is cut: a recovery poll that trusts the store over the frames answers with those few characters
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: LAGSTORE_ANSWER.slice(0, 13) }]);
            session.messages.push(message);
            session.messageId = message.id;
            const steps = answerSteps(session, { text: LAGSTORE_ANSWER, pieces: 4, close: false, endPart: false });
            steps.push({ type: 'stream.end' });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        } else if (text.includes('SHRINK')) {
            // A part the backend rewrote: the closing event carries less text than the deltas added up to, so a
            // gateway that appends every snapshot serves "alpha beta gamma" twice
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: 'alpha beta' }]);
            session.messages.push(message);
            session.messageId = message.id;
            const steps = answerSteps(session, { text: SHRINK_ANSWER, close: false, endPart: false });
            steps.push({ type: 'session.text.ended', data: {
                sessionID: session.id,
                assistantMessageID: message.id,
                ordinal: 0,
                text: 'alpha beta'
            } });
            steps.push({ type: 'session.step.ended', data: { sessionID: session.id, assistantMessageID: message.id, ordinal: 0, finish: 'stop' } });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        } else if (text.includes('MIXED')) {
            // The opening events carry both an increment and the part's text so far, the closing one carries neither:
            // a gateway that appends the whole snapshot on every event ends with "HelloHello worldHello world"
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: 'Hello world' }]);
            session.messages.push(message);
            session.messageId = message.id;
            const envelope = {
                sessionID: session.id,
                assistantMessageID: message.id,
                ordinal: 0
            };
            const steps = [
                { type: 'session.text.started', data: envelope },
                { type: 'session.text.delta', data: { ...envelope, delta: 'Hello' } },
                { type: 'session.text.delta', data: { ...envelope, delta: ' world' } },
                { type: 'session.text.ended', data: { ...envelope, text: 'Hello world' } },
                { type: 'session.step.ended', data: { ...envelope, finish: 'stop' } }
            ];
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        } else if (text.includes('CUTTOOL') || text.includes('OPENTOOL')) {
            // A tool-call answer whose stream is cut inside the closing/opening tag: the filter holds a fragment that
            // could still become a tag, and the recovery poll has to release it
            const toolAnswer = text.includes('CUTTOOL') ? TOOL_ANSWER : TOOL_TAG_ANSWER;
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: toolAnswer }]);
            session.messages.push(message);
            session.messageId = message.id;
            // The cut lands *inside* a tag, not merely before one: only a boundary that splits `<function_calls>` or
            // `</function_calls>` proves the filter holds the fragment back instead of writing half a tag to the client
            const cut = text.includes('CUTTOOL')
                ? toolAnswer.indexOf('</function_calls>') + 4
                : toolAnswer.indexOf('<function_calls>') + 5;
            const steps = answerSteps(session, { text: toolAnswer.slice(0, cut), pieces: 2, close: false, endPart: false });
            steps.push({ type: 'stream.end' });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        } else if (text.includes('LONGPAUSE')) {
            // Silence longer than the SSE keep-alive interval (15 s): the stream carries a `: keep-alive` comment line
            // while the answer is still coming, and a client that reads every line as an event breaks on the comment.
            // The store has to stay **empty and unfinished** for the whole pause, exactly as `PAUSE` does: a store that
            // already held the answer let the idle-timeout recovery poll (8 s) serve it and end the stream at ~8.1 s, so
            // the 15 s of silence the keep-alive line is written after never arrived and this check could not pass.
            // The pause clears 15 s by three, not by one: the comment goes out on the first timer tick at or after the
            // interval, so the stream has to outlive the tick that follows it (the keep-alive tick is one second).
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: '' }], { completed: false });
            session.messages.push(message);
            session.messageId = message.id;
            const steps = answerSteps(session, {
                text: ANSWER,
                reasoning: REASONING,
                pieces: 2,
                pauseAfterFirstMs: 18000,
                onPiece: (snapshot) => {
                    message.content = [
                        ...(REASONING ? [{ type: 'reasoning', text: REASONING }] : []),
                        { type: 'text', text: snapshot }
                    ];
                }
            });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            playSteps(steps).then(() => {
                message.time = { created: message.time.created, completed: Date.now() };
            }).catch(() => {});
            return;
        } else if (text.includes('PAUSE')) {
            // Silence longer than the idle timeout, in the middle of an answer: the gateway has to tell a slow answer
            // from a dead turn, and settling on the idle timer would truncate this one. The stored message starts
            // **empty** and *unfinished* (`time.completed` is only added when the stream ends), so the polling fallback
            // that runs on the silence has nothing to serve yet: a store that already held the whole answer, or one that
            // looked finished, let the gateway settle at the idle timeout (measured 8 s for a 13 s pause) and the
            // "waited for the answer" contract went untested.
            const message = assistantMessage(session.id, `msg_${session.id}`, [{ type: 'text', text: '' }], { completed: false });
            session.messages.push(message);
            session.messageId = message.id;
            const steps = answerSteps(session, {
                text: ANSWER,
                reasoning: REASONING,
                pieces: 2,
                pauseAfterFirstMs: 13000,
                onPiece: (snapshot) => {
                    message.content = [
                        ...(REASONING ? [{ type: 'reasoning', text: REASONING }] : []),
                        { type: 'text', text: snapshot }
                    ];
                }
            });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            playSteps(steps).then(() => {
                message.time = { created: message.time.created, completed: Date.now() };
            }).catch(() => {});
            return;
        } else if (text.includes('ENDONLY')) {
            // The backend closed the part without ever finishing the message: only `time.completed` says the turn is
            // over, and `session.idle` is the only event left to close it. A gateway that waits for a finish event
            // times out on a turn that already answered
            const message = assistantMessage(session.id, `msg_${session.id}`, [
                { type: 'reasoning', text: REASONING },
                { type: 'text', text: ANSWER }
            ], { finish: null });
            session.messages.push(message);
            session.messageId = message.id;
            const steps = answerSteps(session, { text: ANSWER, reasoning: REASONING, close: false });
            steps.push({ type: 'session.idle', data: { sessionID: session.id } });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        } else if (text.includes('MULTIPART')) {
            // One message whose two text parts stream their own cumulative snapshots, interleaved. A gateway that keys
            // the snapshots by part id alone merges the two parts, and one that appends every snapshot duplicates
            // each of them. Without the id the parts are told apart by their ordinal alone.
            const withId = !text.includes('MULTIPARTNOID');
            // The pieces are built so that the two parts interleave into `alpha ALPHA beta BETA gamma GAMMA` and each
            // part's own text is exactly what its deltas added up to - a closing event that disagrees with its deltas
            // is the duplication this marker is about
            const first = MULTIPART_FIRST.split(' ').map((word) => `${word} `);
            const second = MULTIPART_SECOND.split(' ').map((word, index, all) => (
                index === all.length - 1 ? word : `${word} `
            ));
            const firstText = first.join('');
            const secondText = second.join('');
            const message = assistantMessage(session.id, `msg_${session.id}`, [
                { type: 'text', text: firstText },
                { type: 'text', text: secondText }
            ]);
            session.messages.push(message);
            session.messageId = message.id;
            const envelope = (ordinal) => ({
                sessionID: session.id,
                ...(withId ? { assistantMessageID: message.id } : {}),
                ordinal
            });
            const steps = [
                { type: 'session.step.started', data: envelope(0) },
                { type: 'session.text.started', data: envelope(0) },
                { type: 'session.text.started', data: envelope(1) }
            ];
            // Interleaved on purpose: each part's deltas arrive between the other part's, so the two snapshots advance
            // in turn instead of one after the other
            for (let i = 0; i < Math.max(first.length, second.length); i += 1) {
                if (i < first.length) steps.push({ type: 'session.text.delta', data: { ...envelope(0), delta: first[i] } });
                if (i < second.length) steps.push({ type: 'session.text.delta', data: { ...envelope(1), delta: second[i] } });
            }
            steps.push({ type: 'session.text.ended', data: { ...envelope(0), text: firstText } });
            steps.push({ type: 'session.text.ended', data: { ...envelope(1), text: secondText } });
            steps.push({ type: 'session.step.ended', data: { ...envelope(0), finish: 'stop' } });
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        } else {
            const answerText = text.includes('TOOLTAG') ? TOOL_TAG_ANSWER
                : text.includes('TAILTAG') ? TAIL_TAG_ANSWER
                    : text.includes('STRAYTAG') ? STRAY_TAG_ANSWER
                        : text.includes('OPENTAIL') ? OPEN_TAIL_ANSWER
                            // Many deltas need a long answer: the default sentence splits into one delta per character,
                            // which is not the "an idle timer re-armed on every one" case this marker exists for
                            : text.includes('MANYDELTAS') ? MANY_DELTAS_ANSWER
                                // The big answer is one 17 M-character text, not the default sentence repeated: the
                                // point is a single answer past the gateway's cap, and a short one would not reach it
                                : text.includes('BIGANSWER') ? bigAnswerText
                                    : ANSWER;
            const withReasoning = !text.includes('TOOLTAG') && !text.includes('TAILTAG')
                && !text.includes('STRAYTAG') && !text.includes('OPENTAIL')
                // The many-deltas marker is about the delta count, so a reasoning part would only add noise
                && !text.includes('MANYDELTAS')
                // A reasoning part would double the traffic of an answer that exists to be large
                && !text.includes('BIGANSWER');
            const message = assistantMessage(session.id, `msg_${session.id}`, [
                ...(withReasoning ? [{ type: 'reasoning', text: REASONING }] : []),
                { type: 'text', text: answerText }
            ]);
            session.messages.push(message);
            session.messageId = message.id;
            let steps;
            if (text.includes('SLOW')) {
                steps = answerSteps(session, { text: answerText, reasoning: REASONING, pieces: 10, delayMs: 200 });
            } else if (text.includes('MANYDELTAS')) {
                steps = answerSteps(session, { text: answerText, pieces: 200, delayMs: 0 });
            } else if (text.includes('BIGANSWER')) {
                // An answer past the gateway's per-answer buffer cap (`MAX_ANSWER_CHARS`, 16 M chars): the deltas carry
                // it in pieces (no event is a second copy of the whole answer), and the closing `session.text.ended`
                // still carries the part's whole text the way the protocol says. A gateway that truncates a delta, or
                // that appends that closing snapshot instead of diffing it, answers a cut or a doubled answer.
                steps = answerSteps(session, { text: answerText, pieces: BIG_ANSWER_PIECES, delayMs: 0 });
            } else if (text.includes('TOOLTAG')) {
                // The boundary falls inside both of the closing tag's two halves
                steps = answerSteps(session, { text: answerText, chunks: ['hello ', '<function_ca', 'lls>secret</function_ca', 'lls> world'], delayMs: 1 });
            } else if (text.includes('TAILTAG')) {
                // The final delta ends in a prefix of an opening tag that never completes, so the streaming filter has
                // to release it at end of stream instead of swallowing it
                steps = answerSteps(session, { text: answerText, chunks: ['hello world ', '<function_call'], delayMs: 1 });
            } else {
                steps = answerSteps(session, { text: answerText, reasoning: REASONING });
            }
            sendJson(res, 200, { data: inboxItem(session.id, text) });
            startSteps(session, steps);
            return;
        }

        // The markers above that only store a message (nothing to stream): the poll loop answers them
        sendJson(res, 200, { data: inboxItem(session.id, text) });
        return;
    }

    const messageMatch = /^\/api\/session\/([^/]+)\/message$/.exec(path);
    if (messageMatch && req.method === 'GET') {
        messagePolls += 1;
        // Each counter counts only its own polls: a test that drops N and then fails N others must see exactly N
        // drops and N failures, so the always-fail switch cannot swallow the drop count
        if (DROP_MESSAGES > 0 && messagePolls <= DROP_MESSAGES) return req.socket.destroy();
        if (ALWAYS_FAIL_MESSAGES) return sendJson(res, 500, { error: { message: 'transient poll failure' } });
        if (FAIL_MESSAGES > 0 && messagePolls <= FAIL_MESSAGES) {
            return sendJson(res, 500, { error: { message: 'transient poll failure' } });
        }
        if (UNREADABLE_MESSAGES) return sendJson(res, 200, { result: 'unexpected', items: null });
        const session = sessions.get(messageMatch[1]);
        if (!session) return sendError(res, 404, 'SessionNotFoundError', `unknown session ${messageMatch[1]}`);
        // Read on the way past, so the suite can prove a "many messages" scenario really stored that many
        largestSessionMessages = Math.max(largestSessionMessages, session.messages.length);
        // 2.x answers newest first, and `order` cannot be combined with `cursor`: a client that passes both is asking
        // for two orderings at once, so it is refused instead of being answered one of them
        const order = url.searchParams.get('order');
        const cursor = url.searchParams.get('cursor');
        const limit = Number(url.searchParams.get('limit') || 0);
        const type = url.searchParams.get('type');
        // The query each poll actually made, so a test can assert the shape the gateway is written against
        // (`order=desc&limit=1&type=assistant`) from the request rather than from the source or from a behavioural
        // proxy. Bounded, because a long poll loop would otherwise grow it for the life of the stub.
        messagePollQueries.push({ order, cursor, limit, type });
        if (messagePollQueries.length > 50) messagePollQueries.shift();
        if (cursor && order) {
            return sendError(res, 400, 'InvalidRequestError', 'cursor and order cannot be used together');
        }
        let items = session.messages.slice();
        if (order === 'asc') items = items.slice();
        else items.reverse();
        if (type) items = items.filter((message) => message.type === type);
        if (limit > 0) items = items.slice(0, limit);
        return sendJson(res, 200, { data: items, cursor: { previous: null, next: null } });
    }

    const sessionMatch = /^\/api\/session\/([^/]+)$/.exec(path);
    if (sessionMatch && req.method === 'DELETE') {
        const id = sessionMatch[1];
        // A session that is already gone is a 404 in 2.x, which is how the gateway recognises "already deleted"
        if (!sessions.has(id)) return sendError(res, 404, 'SessionNotFoundError', `unknown session ${id}`);
        // A 404 for a session this process still holds is the "the backend lost its store" shape: the cleanup's purpose is
        // met either way, so the gateway must classify it as already gone rather than retry it for the whole budget.
        if (GONE_DELETES) return sendError(res, 404, 'SessionNotFoundError', `unknown session ${id}`);
        if (REJECT_DELETES) return sendError(res, 500, 'ProviderError', 'the session store is busy');
        // Accepted and never answered: the gateway's own deadline (not this process) is what ends the cleanup, so a
        // test can prove a wedged delete is classified as a transient failure instead of holding the slot
        if (HANG_DELETES) return;
        sessions.delete(id);
        deletedSessions += 1;
        // 204: no body at all, not even `{}`. A gateway that reads a body here waits for one that never comes
        res.writeHead(204);
        return res.end();
    }

    sendError(res, 404, 'NotFoundError', `stub: unhandled route ${req.method} ${path}`);
});

server.listen(PORT, HOST, () => {
    console.log(`[stub] listening on http://${HOST}:${PORT} (opencode ${VERSION}, answer: ${JSON.stringify(ANSWER)})`);
});

const shutdown = () => {
    for (const client of eventClients) client.end();
    eventClients.clear();
    server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);