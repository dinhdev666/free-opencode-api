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
// Refuse POST /session with a reason that quotes a URL carrying a credential, the way a proxy in front of the backend
// does when it cannot reach it: the gateway copies that reason into a client-facing 502 body and into its log, so a
// test can prove both are masked
const URL_IN_ERROR = process.env.STUB_URL_IN_ERROR === '1';
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
const HOST = process.env.STUB_HOST || '127.0.0.1';
// Refuse every route without the Basic credential the gateway is configured with (STUB_BASIC_AUTH=user:pass), the way
// a proxy in front of the backend does: a gateway that hands the userinfo to the SDK as a URL cannot reach it at all,
// and one that sends it as a header does. The `/health` probe is covered too - a gateway that authenticates its calls
// but not its probe reads the backend as missing and starts a second one.
const BASIC_AUTH = process.env.STUB_BASIC_AUTH || '';
const BASIC_HEADER = BASIC_AUTH ? `Basic ${Buffer.from(BASIC_AUTH, 'utf8').toString('base64')}` : '';
export const ANSWER = process.env.STUB_ANSWER || 'Hello from the smoke test stub.';
export const REASONING = process.env.STUB_REASONING || 'Thinking about the request.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        if (FAIL_SESSION) return sendJson(res, 405, { error: { message: 'session creation is not supported by this build' } });
        if (URL_IN_ERROR) {
            return sendJson(res, 502, {
                error: { message: 'cannot reach http://alice:s3cr3t-value@127.0.0.1:4097/proxy?token=abc123 (connection refused)' }
            });
        }
        const id = `ses_smoke_${(sessionSeq += 1)}`;
        sessions.set(id, { messages: [] });
        return sendJson(res, 200, { id });
    }

    const sessionMatch = path.match(/^\/session\/([^/]+)(\/message)?$/);
    if (sessionMatch) {
        const id = sessionMatch[1];
        const isMessage = Boolean(sessionMatch[2]);
        const session = sessions.get(id);

        if (!isMessage && req.method === 'DELETE') {
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
            if (session.promptText.includes('TOOLSPAM')) {
                // 64 000 unclosed tags: the strip has to walk the answer once, so this answers in milliseconds and used
                // to spend seconds inside the regular expression before the client saw anything
                return sendJson(res, 200, buildAssistantMessage(id, TOOL_SPAM_ANSWER, ''));
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
            const toolTag = session.promptText.includes('TOOLTAG');
            const tailTag = session.promptText.includes('TAILTAG');
            if (session.promptText.includes('STALL')) {
                // Nothing for polling to find and no finish event: the caller must time out and close the stream
                session.messages = [];
                stallAfterTwoDeltas(id).catch(() => {});
                sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
                return;
            }
            const answerText = toolTag ? TOOL_TAG_ANSWER : tailTag ? TAIL_TAG_ANSWER : ANSWER;
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
