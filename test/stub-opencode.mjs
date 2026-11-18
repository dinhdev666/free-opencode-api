#!/usr/bin/env node
/**
 * Minimal stand-in for `opencode serve`, used by test/smoke.mjs (and therefore by CI).
 *
 * It implements only the handful of routes the gateway actually calls:
 *   GET    /health
 *   GET    /config/providers
 *   POST   /session
 *   POST   /session/:id/message
 *   GET    /session/:id/message
 *   DELETE /session/:id
 *   GET    /event              (SSE)
 *
 * The assistant answer is emitted twice on purpose: incrementally through the event stream (so streaming is
 * exercised) and as a completed message (so the polling fallback would also return the same text).
 */
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT || 4199);
// Serve an empty provider list (see the /config/providers handler)
const EMPTY_PROVIDERS = process.env.STUB_EMPTY_PROVIDERS === '1';
// Reject the provider listing with a 500: the SDK resolves that with an error tuple instead of throwing, so a test can
// prove the gateway inspects it instead of reporting a refused call as "the backend reported no models"
const FAIL_PROVIDERS = process.env.STUB_FAIL_PROVIDERS === '1';
// Reject POST /session (an incompatible backend, a proxy in front of it) so a test can prove the gateway reports the
// upstream status and reason instead of a bare 500
const FAIL_SESSION = process.env.STUB_FAIL_SESSION === '1';
// Accept POST /session (the session is created on the backend) and then drop the connection without answering: what a
// backend that dies between accepting the call and writing the answer looks like. A gateway that retries it creates a
// second session and loses the id of the first, so the test reads `/__sessions` to prove only one was created
const DROP_CREATE = process.env.STUB_DROP_CREATE === '1';
// Refuse DELETE /session/:id with a 500 and keep the session: the SDK resolves that with an error tuple instead of
// throwing, so a test can prove the gateway inspects it instead of counting a refused delete as a deletion
const REJECT_DELETES = process.env.STUB_REJECT_DELETES === '1';
// Hang on this session creation (1-based) and never answer: a backend that wedges on POST /session, which is
// what a queued completion used to be granted a second, fresh request budget for
const HANG_CREATE_AFTER = Number(process.env.STUB_HANG_CREATE_AFTER || 0);
// Refuse POST /session with a reason that quotes a URL carrying a credential, the way a proxy in front of the backend
// does when it cannot reach it: the gateway copies that reason into a client-facing 502 body and into its log, so a
// test can prove both are masked
const URL_IN_ERROR = process.env.STUB_URL_IN_ERROR === '1';
// Refuse POST /session with the authorization header quoted back (a proxy in front of the backend reporting the
// credential it rejected): the header value is the one the gateway lifted out of OPENCODE_SERVER_URL, so a test can
// prove the client answer and the log line mask it instead of publishing the credential
const ECHO_AUTH = process.env.STUB_ECHO_AUTH === '1';
// Refuse POST /session with a megabyte of JSON in the body (a proxy in front of the backend answering its own error
// page): the gateway keeps 500 characters of it as a log summary, and used to serialise all of it first
const BIG_ERROR_BODY = process.env.STUB_BIG_ERROR_BODY === '1';
// Reject GET /event with a 500 (a build whose event stream moved, a proxy in front of it) so a test can prove a
// streaming request still answers from the polling fallback instead of failing
const FAIL_EVENTS = process.env.STUB_FAIL_EVENTS === '1';
// Fail the first N polls of a session's messages with a 500 (a transient backend hiccup), or every poll
// (STUB_ALWAYS_FAIL_MESSAGES=1), so a test can prove the gateway retries a failed poll and gives up in bounded time
const FAIL_MESSAGES = Number(process.env.STUB_FAIL_MESSAGES || 0);
const ALWAYS_FAIL_MESSAGES = process.env.STUB_ALWAYS_FAIL_MESSAGES === '1';
// Drop the connection on the first N polls, the way a backend that is being restarted does
const DROP_MESSAGES = Number(process.env.STUB_DROP_MESSAGES || 0);
// Answer every poll with a 2xx body that is not a message list (an envelope that moved, a proxy in front of the
// backend), so a test can prove the gateway reports an unreadable payload as such instead of "failed (status 200)"
const UNREADABLE_MESSAGES = process.env.STUB_UNREADABLE_MESSAGES === '1';
let failedMessagePolls = 0;
let droppedMessagePolls = 0;
// Counts GET /session/:id/message calls, so a test can prove the non-streaming fast path needed no poll at all
let messagePolls = 0;
// An answer with a tool-call block whose tags are cut in the middle by the delta boundaries (prompt marker TOOLTAG)
const TOOL_TAG_ANSWER = 'hello <function_calls>secret</function_calls> world';
// An answer whose last delta ends with a fragment that looks like the start of a tool-call tag but never becomes
// one (prompt marker TAILTAG): the gateway holds that fragment back, and must still deliver it when the stream ends
const TAIL_TAG_ANSWER = 'hello world <function_call';
// An answer made of 64 000 *unclosed* tool-call tags plus one word (prompt marker TOOLSPAM), the input a model that
// renders its tool attempts as text produces: the gateway must strip them in one pass. A lazy regex restarted a
// closing-tag search at every opener and spent 8.5 s on this 1 MB answer, stalling everything else in the process.
const TOOL_SPAM_ANSWER = `${'<function_calls>'.repeat(64000)}done`;
// A provider error whose own message quotes a credential-bearing URL and 2 KB of trailing text (prompt marker
// LEAKYFAIL): a provider says exactly this when it rejects a key, and both answer modes have to mask and bound it
// before the text becomes a client-facing body or log line.
const LEAKY_ERROR_TEXT = `provider rejected http://alice:s3cr3t-value@127.0.0.1:4097/proxy?token=abc123 and the upstream answered with a very long explanation ${'y'.repeat(2000)}`;
const HOST = process.env.STUB_HOST || '127.0.0.1';
// Refuse every route without the Basic credential the gateway is configured with (STUB_BASIC_AUTH=user:pass), the way
// a proxy in front of the backend does: a gateway that hands the userinfo to the SDK as a URL cannot reach it at all,
// and one that sends it as a header does. The `/health` probe is covered too - a gateway that authenticates its calls
// but not its probe reads the backend as missing and starts a second one.
const BASIC_AUTH = process.env.STUB_BASIC_AUTH || '';
const BASIC_HEADER = BASIC_AUTH ? `Basic ${Buffer.from(BASIC_AUTH, 'utf8').toString('base64')}` : '';

// The snapshots the SHRINK marker sends: the second one is shorter, so it carries no derivable increment
const SHRINK_SNAPSHOTS = ['alpha beta gamma', 'alpha beta'];
const SHRINK_LAST = 'alpha beta';
// The answer the LAGSTORE marker delivers on the event stream, and how much of it the stored message keeps: a store
// written behind the broadcast (or a part the backend rewrote shorter) leaves the polled copy *behind* what the client
// already has, so the recovery poll carries nothing new.
const LAGSTORE_ANSWER = 'The frames carry the whole answer, but the stored message lags behind them by a wide margin.';
const LAGSTORE_STORED_CHARS = 13;
// The two halves of the MULTIPART answer, each sent as its own cumulative snapshots by streamTwoParts()
const MULTIPART_FIRST = 'alpha beta gamma';
const MULTIPART_SECOND = 'ALPHA BETA GAMMA';
// The answer the CUTTOOL and OPENTOOL markers carry, and the two points inside its tool block where the stream stops:
// the first cuts the opening tag in half, the second the closing one. The stored message is the complete answer, so the
// recovery poll holds the whole text while the client only has `hello `.
const TOOL_ANSWER = 'hello <function_calls>secret</function_calls> world';
const TOOL_OPEN_CUT = 'hello <function_ca';
const TOOL_CLOSE_CUT = 'hello <function_calls>secret</function_cal';
// The two-step answer (prompt marker TWOSTEP): the step that asked for a tool, already finished with
// `finish: "tool-calls"`, and the real answer, which is still being written when the gateway starts polling
const TWO_STEP_EARLIER = 'STEP ONE TEXT';
const TWO_STEP_FINAL = 'THE FINAL ANSWER';
// Answers carrying tool-call markup the streaming filter used to get wrong (prompt markers STRAYTAG and OPENTAIL): a
// stray closing tag with no block at all, and an opening tag that never closes, whose text must survive
const STRAY_TAG_ANSWER = 'aaaa</function_calls>bbbb';
const OPEN_TAIL_ANSWER = 'visible text <function_calls>tail words here';
// A provider that fails after it has written text (prompt marker FAILMID): the finishing event carries `error` next to
// `time.completed`, so the answer has to end as a failure, not as `finish_reason: "stop"`
const FAIL_MID_ANSWER = 'partial answer';
// The MIXED answer: two increments, each also carrying the part's cumulative text, then a closing update with no delta
const MIXED_ANSWER = 'Hello world';
// A text part whose `text` is not a string (a changed backend shape): it is not text and must not be stringified into
// the answer, while the string part next to it is the answer
const BAD_PART_TEXT = 'Alpha';
// The reasoning-only answer: a provider that writes reasoning and no text, and never marks the message finished
const REASON_ONLY_TEXT = 'thinking only';
export const ANSWER = process.env.STUB_ANSWER || 'Hello from the smoke test stub.';
// An answer long enough to be delivered as ~180 deltas (prompt marker MANYDELTAS): the gateway re-arms its idle timer on
// every delta, and the whole answer still has to arrive in order
export const MANY_DELTAS_ANSWER = Array.from({ length: 60 }, (_, index) => `part${index}`).join(' ');
export const REASONING = process.env.STUB_REASONING || 'Thinking about the request.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long `POST /session` takes to answer (STUB_CREATE_DELAY_MS): a shutdown that lands inside this window used to
// leave the created session in a set nobody read again
const CREATE_DELAY_MS = Number(process.env.STUB_CREATE_DELAY_MS || 0) || 0;

const sessions = new Map();
const eventClients = new Set();
let sessionSeq = 0;
let deletedSessions = 0;
let promptedSessions = 0;
// Counts /config/providers calls, so a test can prove the gateway collapses a cold-cache burst into one round trip
let providerCalls = 0;
// The system prompt of the most recent prompt body: the gateway folds `system`/`developer` messages into it, so a
// test can prove they never reach the conversation parts
let lastSystemPrompt = '';
// The conversation text of the most recent prompt body, exactly as the model would read it: a test can prove how a
// message is labelled (`USER(name): …`) and that a client-supplied value did not reach it raw
let lastPromptText = '';

const sendJson = (res, statusCode, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
    });
    res.end(payload);
};

const sendEvent = (payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of eventClients) {
        // A subscriber may disconnect mid-answer; writing to it must not take the stub down
        try {
            client.write(frame);
        } catch {
            eventClients.delete(client);
        }
    }
};

const partUpdate = (sessionID, part) => ({
    type: 'message.part.updated',
    properties: { part: { sessionID, ...part } }
});

const buildAssistantMessage = (sessionID, text, reasoning) => ({
    info: {
        id: `msg_${sessionID}`,
        sessionID,
        role: 'assistant',
        finish: 'stop',
        time: { created: Date.now(), completed: Date.now() }
    },
    parts: [
        { type: 'reasoning', text: reasoning },
        { type: 'text', text }
    ]
});

// Part updates that carry a `delta` *and* the part's cumulative text, then one closing update for the same part with no
// delta at all. The SDK's event type allows both fields on one event, so this is a conforming backend (or a version
// transition): the closing update must add nothing, because the deltas already carried its text.
async function streamMixedDeltas(sessionID, pieces, delayMs = 1) {
    for (let i = 0; i < 200 && eventClients.size === 0; i += 1) await sleep(5);
    let text = '';
    for (const piece of pieces) {
        text += piece;
        sendEvent({
            type: 'message.part.updated',
            properties: { part: { id: 'prt_mixed', sessionID, type: 'text', text }, delta: piece }
        });
        await sleep(delayMs);
    }
    sendEvent({ type: 'message.part.updated', properties: { part: { id: 'prt_mixed', sessionID, type: 'text', text } } });
    await sleep(delayMs);
    sendEvent({
        type: 'message.updated',
        properties: {
            info: {
                id: `msg_${sessionID}`,
                sessionID,
                role: 'assistant',
                finish: 'stop',
                time: { created: Date.now(), completed: Date.now() }
            }
        }
    });
}

// Emit two deltas and then go silent without ever finishing, so a completion can only end through a timeout.
async function stallAfterTwoDeltas(sessionID) {
    for (let i = 0; i < 200 && eventClients.size === 0; i += 1) await sleep(5);
    sendEvent(partUpdate(sessionID, { type: 'text', text: 'partial answer that never ends' }));
    await sleep(10);
    sendEvent(partUpdate(sessionID, { type: 'text', text: 'partial answer that never ends, still going' }));
}

// Emit two deltas and then close every event subscriber (a FIN, not a reset) without ever reporting a finish, while the
// stored message is already complete: what a backend that restarts mid-answer, or a proxy in front of it that drops an
// idle SSE connection, looks like from the gateway's side.
async function cutStreamMidAnswer(sessionID, snapshots) {
    for (let i = 0; i < 200 && eventClients.size === 0; i += 1) await sleep(5);
    // `snapshots` are cumulative texts (the shape opencode >= 1.19 sends), not increments
    for (const snapshot of snapshots) {
        sendEvent(partUpdate(sessionID, { type: 'text', text: snapshot }));
        await sleep(10);
    }
    for (const client of eventClients) {
        client.end();
        eventClients.delete(client);
    }
}

// Deltas followed by a finishing event that reports a provider error: a provider that fails after it has written text.
// `error` sits next to `time.completed` on the same `message.updated`, which is how opencode reports it.
async function failMidStream(sessionID, pieces) {
    for (let i = 0; i < 200 && eventClients.size === 0; i += 1) await sleep(5);
    let text = '';
    for (const piece of pieces) {
        text += piece;
        sendEvent({ type: 'message.part.updated', properties: { part: { id: 'prt_failmid', sessionID, type: 'text', text } } });
        await sleep(5);
    }
    sendEvent({
        type: 'message.updated',
        properties: {
            info: {
                id: `msg_${sessionID}`,
                sessionID,
                role: 'assistant',
                error: { name: 'ProviderError', data: { message: 'provider failed mid-answer' } },
                time: { created: Date.now(), completed: Date.now() }
            }
        }
    });
}

// One text part whose snapshots are exactly what a backend that rewrote its part sends: the second snapshot is
// shorter than the first, so there is no increment to derive and the whole text has to be forwarded.
async function streamSnapshots(sessionID, snapshots, delayMs) {
    for (let i = 0; i < 200 && eventClients.size === 0; i += 1) await sleep(5);
    for (const text of snapshots) {
        sendEvent({ type: 'message.part.updated', properties: { part: { id: 'prt_text', sessionID, type: 'text', text } } });
        await sleep(delayMs);
    }
    sendEvent({
        type: 'message.updated',
        properties: {
            info: {
                id: `msg_${sessionID}`,
                sessionID,
                role: 'assistant',
                finish: 'stop',
                time: { created: Date.now(), completed: Date.now() }
            }
        }
    });
}

// Two text parts in one message, each sending its own cumulative snapshots, interleaved: what a backend does when the
// model writes, calls a tool and keeps writing. Each part's text is the part's own full text, never the whole answer.
// `withIds: false` sends the same two parts without `id`, the shape a backend that does not identify its parts uses:
// both parts are then of type `text`, so a diff keyed by the type alone mixes them up
async function streamTwoParts(sessionID, pieces, delayMs, withIds = true) {
    for (let i = 0; i < 200 && eventClients.size === 0; i += 1) await sleep(5);
    let first = '';
    let second = '';
    for (const piece of pieces) {
        first += piece;
        sendEvent({
            type: 'message.part.updated',
            properties: { part: { ...(withIds ? { id: 'prt_first' } : {}), sessionID, type: 'text', text: first } }
        });
        await sleep(delayMs);
        second += piece.toUpperCase();
        sendEvent({
            type: 'message.part.updated',
            properties: { part: { ...(withIds ? { id: 'prt_second' } : {}), sessionID, type: 'text', text: second } }
        });
        await sleep(delayMs);
    }
    sendEvent({
        type: 'message.updated',
        properties: {
            info: {
                id: `msg_${sessionID}`,
                sessionID,
                role: 'assistant',
                finish: 'stop',
                time: { created: Date.now(), completed: Date.now() }
            }
        }
    });
}

// Wait (briefly) for the gateway to be subscribed before emitting, then replay the answer as incremental updates.
// `pieces`/`delayMs` let a test ask for a deliberately slow answer (a prompt containing SLOW) so it can abort a
// stream while the backend is still working.
async function streamAssistantReply(
    sessionID,
    text,
    reasoning,
    { pieces = 3, delayMs = 5, chunks = null, finish = 'stop', pauseAfterFirstMs = 0, onSnapshot = null } = {}
) {
    const full = text;
    for (let i = 0; i < 200 && eventClients.size === 0; i += 1) await sleep(5);

    // opencode interleaves events that have no `properties` at all; the gateway must ignore them instead of
    // treating the subscription as broken
    sendEvent({ type: 'server.heartbeat' });
    sendEvent(partUpdate(sessionID, { type: 'reasoning', text: reasoning }));
    await sleep(delayMs);


    // `chunks` overrides the even split with explicit incremental pieces, so a test can cut the answer in the
    // middle of a tag; the gateway sees cumulative snapshots either way.
    let snapshots;
    if (chunks) {
        let text = '';
        snapshots = chunks.map((piece) => {
            text += piece;
            return text;
        });
    } else {
        const step = Math.max(1, Math.ceil(full.length / pieces));
        snapshots = [];
        for (let end = step; end < full.length; end += step) snapshots.push(full.slice(0, end));
        snapshots.push(full);
    }
    for (const snapshot of snapshots) {
        sendEvent(partUpdate(sessionID, { type: 'text', text: snapshot }));
        if (onSnapshot) onSnapshot(snapshot);
        // A backend that goes quiet for longer than the gateway's idle timeout before it carries on: the stored
        // message stays partial and unfinished for the whole pause, exactly like a slow provider
        if (pauseAfterFirstMs && snapshot === snapshots[0]) await sleep(pauseAfterFirstMs);
        // A message.updated for something the gateway does not care about, with no `info` at all
        sendEvent({ type: 'message.updated', properties: {} });
        // A part event that names the session but carries no part: same class of noise the gateway must skip
        sendEvent({ type: 'message.part.updated', properties: { sessionID } });
        await sleep(delayMs);
    }
    await sleep(delayMs);

    sendEvent({
        type: 'message.updated',
        properties: {
            info: {
                id: `msg_${sessionID}`,
                sessionID,
                role: 'assistant',
                // A provider may report a finish reason other than "stop" (tool calls, "end", ...)
                ...(finish === 'completed-only' ? {} : { finish }),
                time: { created: Date.now(), completed: Date.now() }
            }
        }
    });
}

// The prompt body is only needed to decide whether a test asked for a slow answer
const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
};

const server = http.createServer(async (req, res) => {
    // A `Host` header that is not a valid host (a raw client, a test that sets a placeholder) made `new URL` throw
    // inside an async handler, which Node reports as an unhandled rejection and exits: one harness mistake took the
    // whole stub down and every later assertion failed for an unrelated reason.
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || HOST}`);
    } catch {
        return sendJson(res, 400, { error: 'stub: unreadable request target' });
    }
    const path = url.pathname;

    // Test-only: the same gate a credential-requiring proxy puts in front of the backend
    if (BASIC_HEADER && req.headers.authorization !== BASIC_HEADER) {
        res.setHeader('www-authenticate', 'Basic realm="stub"');
        return sendJson(res, 401, { error: { message: 'stub: credentials required' } });
    }

    if (path === '/health') return sendJson(res, 200, { healthy: true });

    // Test-only introspection (not part of the OpenCode API): proves the gateway deletes the session it created
    if (path === '/__sessions') {
        return sendJson(res, 200, {
            live: sessions.size,
            created: sessionSeq,
            deleted: deletedSessions,
            prompts: promptedSessions,
            providerCalls,
            messagePolls,
            lastSystemPrompt,
            lastPromptText
        });
    }

    if (path === '/config/providers') {
        providerCalls += 1;
        if (FAIL_PROVIDERS) return sendJson(res, 500, { error: { message: 'provider listing unavailable' } });
        // A backend version whose payload the gateway cannot read answers with nothing to choose from; a listing with
        // no models at all is as useless to a client as a failed call, so a test can prove the gateway falls back
        // instead of serving []. The first call reports an empty provider list and every later one a provider whose
        // model map the gateway cannot read, so one stub covers both shapes of an unreadable answer.
        if (EMPTY_PROVIDERS) {
            return sendJson(res, 200, providerCalls === 1 ? { providers: [] } : { providers: [{ id: 'opencode' }] });
        }
        return sendJson(res, 200, {
            providers: [
                {
                    id: 'opencode',
                    // Two models, so a test can tell the provider list apart from the gateway's single-model fallback
                    models: {
                        'kimi-k2.5-free': { name: 'Kimi K2.5 Free' },
                        'gpt-5-mini-free': { name: 'GPT-5 Mini Free' }
                    }
                }
            ]
        });
    }

    if (path === '/session' && req.method === 'POST') {
        // A backend that is slow to answer the creation: the gateway is still waiting for it when its shutdown begins,
        // which is the window in which a session used to be created after the teardown had already counted the set
        if (CREATE_DELAY_MS) await sleep(CREATE_DELAY_MS);
        if (BIG_ERROR_BODY) {
            return sendJson(res, 502, { error: { message: 'x'.repeat(1000000), detail: { nested: ['y'.repeat(200000)] } } });
        }
        if (FAIL_SESSION) return sendJson(res, 405, { error: { message: 'session creation is not supported by this build' } });
        if (URL_IN_ERROR) {
            return sendJson(res, 502, {
                error: { message: 'cannot reach http://alice:s3cr3t-value@127.0.0.1:4097/proxy?token=abc123 (connection refused)' }
            });
        }
        if (ECHO_AUTH) {
            return sendJson(res, 401, {
                error: { message: `the proxy refused the credential: Authorization: ${req.headers.authorization || 'none'}` }
            });
        }
        const id = `ses_smoke_${(sessionSeq += 1)}`;
        if (HANG_CREATE_AFTER && sessionSeq > HANG_CREATE_AFTER) {
            // Accepted and never answered: the caller has to give up through its own deadline
            return;
        }
        sessions.set(id, { messages: [] });
        if (DROP_CREATE) {
            // Accepted, then the connection is dropped: the session exists and the caller never learns its id
            req.destroy();
            return;
        }
        return sendJson(res, 200, { id });
    }

    const sessionMatch = path.match(/^\/session\/([^/]+)(\/message)?$/);
    if (sessionMatch) {
        const id = sessionMatch[1];
        const isMessage = Boolean(sessionMatch[2]);
        const session = sessions.get(id);

        if (!isMessage && req.method === 'DELETE') {
            if (REJECT_DELETES) return sendJson(res, 500, { error: { message: 'the session store is busy' } });
            if (sessions.delete(id)) deletedSessions += 1;
            return sendJson(res, 200, {});
        }

        if (isMessage && req.method === 'POST') {
            if (!session) return sendJson(res, 404, { error: 'unknown session' });
            if (session.prompted) return sendJson(res, 200, { info: buildAssistantMessage(id, ANSWER, REASONING).info, parts: [] });
            try {
                const parsed = JSON.parse((await readBody(req)) || '{}');
                session.promptText = (parsed.parts || []).map((part) => part?.text || '').join(' ');
                lastSystemPrompt = typeof parsed.system === 'string' ? parsed.system : '';
                lastPromptText = (parsed.parts || []).map((part) => (part?.type === 'text' ? String(part.text || '') : '')).join('\n');
            } catch {
                session.promptText = '';
                lastSystemPrompt = '';
            }
            session.prompted = true;
            promptedSessions += 1;
            if (session.promptText.includes('REJECTPROMPT')) {
                // The SDK resolves with { error, response } on a non-2xx answer instead of throwing: a gateway that
                // ignores that tuple waits for an assistant message that will never exist and answers 504
                return sendJson(res, 500, { error: { message: 'provider refused the prompt' } });
            }
            if (session.promptText.includes('PROMPTDONE')) {
                // The prompt response already carries the finished message and nothing is stored for polling: an answer
                // served without a single GET /session/:id/message proves the fast path was used
                return sendJson(res, 200, buildAssistantMessage(id, ANSWER, REASONING));
            }
            if (session.promptText.includes('BADPART')) {
                // A part carrying a number instead of text, next to a normal one: only the string is answer text
                return sendJson(res, 200, {
                    info: {
                        id: `msg_${id}`,
                        sessionID: id,
                        role: 'assistant',
                        finish: 'stop',
                        time: { created: Date.now(), completed: Date.now() }
                    },
                    parts: [{ type: 'text', text: 42 }, { type: 'text', text: BAD_PART_TEXT }]
                });
            }
            if (session.promptText.includes('REASONONLY')) {
                // A message that carries reasoning and no text, and is never marked finished: the stall window has to
                // watch the reasoning too, or the gateways polls until its whole budget and answers 504
                session.messages.push({
                    info: { id: `msg_${id}`, sessionID: id, role: 'assistant' },
                    parts: [{ type: 'reasoning', text: REASON_ONLY_TEXT }]
                });
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                return;
            }
            if (session.promptText.includes('TOOLSPAM')) {
                // 64 000 unclosed tags: the strip has to walk the answer once, so this answers in milliseconds and used
                // to spend seconds inside the regular expression before the client saw anything
                return sendJson(res, 200, buildAssistantMessage(id, TOOL_SPAM_ANSWER, ''));
            }
            if (session.promptText.includes('TWOSTEP')) {
                // A tool-using completion: the step that asked for the tool is already finished, and the answer that
                // follows it is still being written. `finish: "tool-calls"` is what opencode reports for such a step.
                session.messages.push({
                    info: {
                        id: `msg_${id}_step`,
                        sessionID: id,
                        role: 'assistant',
                        finish: 'tool-calls',
                        time: { created: Date.now(), completed: Date.now() }
                    },
                    parts: [{ type: 'text', text: TWO_STEP_EARLIER }]
                });
                const finalMessage = {
                    info: { id: `msg_${id}_final`, sessionID: id, role: 'assistant' },
                    parts: [{ type: 'text', text: TWO_STEP_FINAL.slice(0, 5) }]
                };
                session.messages.push(finalMessage);
                sendJson(res, 200, { info: finalMessage.info, parts: [] });
                setTimeout(() => {
                    finalMessage.parts[0].text = TWO_STEP_FINAL;
                    finalMessage.info.finish = 'stop';
                    finalMessage.info.time = { created: Date.now(), completed: Date.now() };
                }, 400);
                return;
            }
            if (session.promptText.includes('FAILMID')) {
                // A provider failure that arrives after the text: the event that ends the message carries the error, so
                // the truncated answer must not be reported as a completed one
                session.messages.push({
                    info: {
                        id: `msg_${id}`,
                        sessionID: id,
                        role: 'assistant',
                        error: { name: 'ProviderError', data: { message: 'provider failed mid-answer' } },
                        time: { created: Date.now(), completed: Date.now() }
                    },
                    parts: [{ type: 'text', text: FAIL_MID_ANSWER }]
                });
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                failMidStream(id, ['partial ', 'answer']).catch(() => {});
                return;
            }
            if (session.promptText.includes('STRAYTAG') || session.promptText.includes('OPENTAIL')) {
                // Tool-call markup the streaming filter has to answer exactly like the non-streaming scan: a stray
                // closing tag (dropped, text around it kept) and an opening tag that never closes (dropped, the text
                // after it kept)
                const stray = session.promptText.includes('STRAYTAG');
                const text = stray ? STRAY_TAG_ANSWER : OPEN_TAIL_ANSWER;
                session.messages.push(buildAssistantMessage(id, text, REASONING));
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                streamAssistantReply(id, text, REASONING, {
                    chunks: stray
                        ? ['aaaa', '</function_calls>', 'bbbb']
                        : ['visible text ', '<function_calls>', 'tail words here'],
                    delayMs: 1
                }).catch(() => {});
                return;
            }
            if (session.promptText.includes('LEAKYFAIL')) {
                // The provider error carries a credential-bearing URL and 2 KB of text. Checked before FAIL, whose
                // marker is a substring of this one.
                session.messages.push({
                    info: {
                        id: `msg_${id}`,
                        sessionID: id,
                        role: 'assistant',
                        error: { name: 'ProviderError', data: { message: LEAKY_ERROR_TEXT } },
                        time: { created: Date.now(), completed: Date.now() }
                    },
                    parts: []
                });
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                return;
            }
            if (session.promptText.includes('FAIL')) {
                // A provider failure: the assistant message carries an error and no content, so a non-streaming
                // request must answer 502 and a streaming one must end with an in-band error frame
                session.messages.push({
                    info: {
                        id: `msg_${id}`,
                        sessionID: id,
                        role: 'assistant',
                        error: { name: 'ProviderError', data: { message: 'provider failed' } },
                        time: { created: Date.now(), completed: Date.now() }
                    },
                    parts: []
                });
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                return;
            }
            if (session.promptText.includes('GROW')) {
                // The answer is still growing when the prompt returns and only marks itself finished later: a poller
                // that answers with the first poll would truncate it
                const message = {
                    info: { id: `msg_${id}`, sessionID: id, role: 'assistant' },
                    parts: [{ type: 'text', text: ANSWER.slice(0, 12) }]
                };
                session.messages.push(message);
                sendJson(res, 200, { info: message.info, parts: [] });
                setTimeout(() => {
                    message.parts[0].text = ANSWER;
                    message.info.finish = 'stop';
                    message.info.time = { created: Date.now(), completed: Date.now() };
                }, 150);
                return;
            }
            if (session.promptText.includes('SLOWFINISH')) {
                // Written slowly and only finished after 3 s: a non-streaming request is still running well after a
                // client that disconnected has given up, so a test can prove the slot was freed for real
                const message = {
                    info: { id: `msg_${id}`, sessionID: id, role: 'assistant' },
                    parts: [{ type: 'text', text: ANSWER.slice(0, 12) }]
                };
                session.messages.push(message);
                sendJson(res, 200, { info: message.info, parts: [] });
                setTimeout(() => {
                    message.parts[0].text = ANSWER;
                    message.info.finish = 'stop';
                    message.info.time = { created: Date.now(), completed: Date.now() };
                }, 3000);
                return;
            }
            if (session.promptText.includes('HOLD')) {
                // Finished only after 400 ms: a non-streaming request is still waiting when the gateway starts
                // shutting down, so a test can prove the backend outlives the responses it is answering
                const message = {
                    info: { id: `msg_${id}`, sessionID: id, role: 'assistant' },
                    parts: [{ type: 'text', text: ANSWER.slice(0, 12) }]
                };
                session.messages.push(message);
                sendJson(res, 200, { info: message.info, parts: [] });
                setTimeout(() => {
                    message.parts[0].text = ANSWER;
                    message.info.finish = 'stop';
                    message.info.time = { created: Date.now(), completed: Date.now() };
                }, 400);
                return;
            }
            if (session.promptText.includes('SUICIDE')) {
                // The backend dies the moment it has accepted the prompt: the poll can never race a completed answer
                // the way a timed SIGKILL from the test could (a slow runner let the kill land after the gateway had
                // already accepted a stable partial answer), so "the backend disappears mid request" is deterministic
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                setTimeout(() => process.kill(process.pid, 'SIGKILL'), 25);
                return;
            }
            if (session.promptText.includes('PAUSE')) {
                // Silenced for longer than the SSE idle timeout and finished only afterwards: the gateway must recover
                // through polling instead of ending the stream on the text it already had
                const message = {
                    info: { id: `msg_${id}`, sessionID: id, role: 'assistant' },
                    parts: [{ type: 'text', text: '' }]
                };
                session.messages.push(message);
                sendJson(res, 200, { info: message.info, parts: [] });
                streamAssistantReply(id, ANSWER, REASONING, {
                    delayMs: 2,
                    pauseAfterFirstMs: 12500,
                    onSnapshot: (text) => {
                        message.parts[0].text = text;
                    }
                })
                    .then(() => {
                        message.info.finish = 'stop';
                        message.info.time = { created: Date.now(), completed: Date.now() };
                    })
                    .catch(() => {});
                return;
            }
            if (session.promptText.includes('CUTSTREAM')) {
                // The event stream is closed mid-answer without a finish event, but the stored message is already the
                // complete answer: the gateway has to recover through polling instead of waiting out its budget and
                // answering an in-band error. The deltas sent before the cut are prefixes of ANSWER, so a fallback that
                // re-sends the whole message duplicates the text and one that appends nothing truncates it.
                session.messages.push(buildAssistantMessage(id, ANSWER, REASONING));
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                const cut = Math.ceil(ANSWER.length / 2);
                cutStreamMidAnswer(id, [ANSWER.slice(0, Math.ceil(cut / 2)), ANSWER.slice(0, cut)]).catch(() => {});
                return;
            }
            if (session.promptText.includes('LAGSTORE')) {
                // The stored message is behind the event stream, and the stream is then cut without a finish event, so
                // the recovery poll reads the short copy. It holds nothing the client does not already have: appending
                // it repeated the head of the answer (`LAGSTORE_ANSWER` plus its first characters again) under
                // `finish_reason: "stop"`.
                session.messages.push(buildAssistantMessage(id, LAGSTORE_ANSWER.slice(0, LAGSTORE_STORED_CHARS), ''));
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                cutStreamMidAnswer(id, [
                    LAGSTORE_ANSWER.slice(0, Math.ceil(LAGSTORE_ANSWER.length / 2)),
                    LAGSTORE_ANSWER
                ]).catch(() => {});
                return;
            }
            if (session.promptText.includes('MULTIPARTNOID')) {
                // The same interleaved cumulative parts, sent without ids: two parts of the same type must still be
                // delivered once each instead of being diffed against one another
                session.messages.push({
                    info: { id: `msg_${id}`, sessionID: id, role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } },
                    parts: [{ type: 'text', text: MULTIPART_FIRST }, { type: 'text', text: MULTIPART_SECOND }]
                });
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                streamTwoParts(id, ['alpha ', 'beta ', 'gamma '], 1, false).catch(() => {});
                return;
            }
            if (session.promptText.includes('MULTIPART')) {
                // The same answer as two interleaved cumulative text parts, so a diff taken against the whole message
                // instead of against the part re-sends each part on every event and the client sees it three times
                session.messages.push({
                    info: { id: `msg_${id}`, sessionID: id, role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } },
                    parts: [{ type: 'text', text: MULTIPART_FIRST }, { type: 'text', text: MULTIPART_SECOND }]
                });
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                streamTwoParts(id, ['alpha ', 'beta ', 'gamma '], 1).catch(() => {});
                return;
            }
            if (session.promptText.includes('SHRINK')) {
                // A part that gets shorter (the backend rewrote what it had written): the snapshot is not an
                // extension of the previous one, so the collector must forward it instead of swallowing it
                session.messages.push({
                    info: { id: `msg_${id}`, sessionID: id, role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } },
                    parts: [{ type: 'text', text: SHRINK_LAST }]
                });
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                streamSnapshots(id, SHRINK_SNAPSHOTS, 1).catch(() => {});
                return;
            }
            if (session.promptText.includes('MIXED')) {
                // A backend that sends `delta` on the streaming updates and the finished part without one: the part's
                // snapshot has to be recorded by the delta-bearing events too, or the closing update is diffed against
                // '' and the client receives the whole answer a second time
                session.messages.push({
                    info: { id: `msg_${id}`, sessionID: id, role: 'assistant', finish: 'stop', time: { created: Date.now(), completed: Date.now() } },
                    parts: [{ type: 'text', text: MIXED_ANSWER }]
                });
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                streamMixedDeltas(id, ['Hello', ' world']).catch(() => {});
                return;
            }
            if (session.promptText.includes('CUTTOOL') || session.promptText.includes('OPENTOOL')) {
                // The answer carries a tool-call block and the stream is cut inside it (CUTTOOL: inside the closing
                // tag, OPENTOOL: inside the opening one), then every event subscriber is closed. The stored message is
                // the complete answer, so the recovery poll has all of it: the gateway has to strip the block out and
                // append what the client is missing, whatever the streaming filter was holding when the stream died.
                session.messages.push(buildAssistantMessage(id, TOOL_ANSWER, REASONING));
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                const cut = session.promptText.includes('OPENTOOL') ? TOOL_OPEN_CUT : TOOL_CLOSE_CUT;
                if (!TOOL_ANSWER.startsWith(cut)) throw new Error('the cut point is not a prefix of the answer');
                cutStreamMidAnswer(id, [cut]).catch(() => {});
                return;
            }
            const toolTag = session.promptText.includes('TOOLTAG');
            const tailTag = session.promptText.includes('TAILTAG');
            if (session.promptText.includes('STALL')) {
                // Nothing for polling to find and no finish event: the caller must time out and close the stream
                session.messages = [];
                stallAfterTwoDeltas(id).catch(() => {});
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                return;
            }
            const manyDeltas = session.promptText.includes('MANYDELTAS');
            const answerText = toolTag
                ? TOOL_TAG_ANSWER
                : tailTag
                    ? TAIL_TAG_ANSWER
                    : manyDeltas
                        ? MANY_DELTAS_ANSWER
                        : ANSWER;
            session.messages.push(buildAssistantMessage(id, answerText, REASONING));
            sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
            // Fire and forget: the gateway collects the answer from /event (or polling). A prompt containing SLOW
            // is answered over ~2 s so a test can abort mid-stream while the backend is still working.
            const slow = session.promptText.includes('SLOW');
            // A provider that ends the message without the literal "stop" (only time.completed is set)
            const completedOnly = session.promptText.includes('ENDONLY');
            const options = slow ? { pieces: 10, delayMs: 200 } : {};
            if (toolTag) {
                // A tool-call block cut in the middle of both its tags: nothing of it may reach the client
                options.chunks = ['hello ', '<function_ca', 'lls>secret</function_ca', 'lls> world'];
                options.delayMs = 1;
            }
            if (tailTag) {
                // The last delta ends inside a tag prefix: the held fragment is not markup and must still be sent
                options.chunks = ['hello world ', '<function_call'];
                options.delayMs = 1;
            }
            if (completedOnly) options.finish = 'completed-only';
            if (manyDeltas) {
                // 200 pieces over a 470-character answer: one SSE delta per ~3 characters, no artificial delay
                options.pieces = 200;
                options.delayMs = 0;
            }
            streamAssistantReply(id, answerText, REASONING, options).catch(() => {});
            return;
        }

        if (isMessage && req.method === 'GET') {
            messagePolls += 1;
            // The two failure counters used to be incremented together on every poll, so the "drop the connection"
            // and "answer 500" knobs counted each other's polls and could not be combined in one test. Each counter now
            // counts only the polls it actually failed.
            if (droppedMessagePolls < DROP_MESSAGES) {
                droppedMessagePolls += 1;
                req.destroy();
                return undefined;
            }
            if (UNREADABLE_MESSAGES) return sendJson(res, 200, { result: 'unexpected', items: null });
            if (ALWAYS_FAIL_MESSAGES || failedMessagePolls < FAIL_MESSAGES) {
                failedMessagePolls += 1;
                return sendJson(res, 500, { error: { message: 'transient poll failure' } });
            }
            return sendJson(res, 200, session ? session.messages : []);
        }
    }

    if (path === '/event') {
        if (FAIL_EVENTS) return sendJson(res, 500, { error: { message: 'event stream unavailable' } });
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
        });
        res.write(': connected\n\n');
        eventClients.add(res);
        req.on('close', () => eventClients.delete(res));
        return;
    }

    sendJson(res, 404, { error: `stub: unhandled route ${req.method} ${path}` });
});

server.listen(PORT, HOST, () => {
    console.log(`[stub] listening on http://${HOST}:${PORT} (answer: ${JSON.stringify(ANSWER)})`);
});

const shutdown = () => {
    for (const client of eventClients) client.end();
    eventClients.clear();
    server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
