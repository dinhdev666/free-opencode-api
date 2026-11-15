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
const HOST = process.env.STUB_HOST || '127.0.0.1';
export const ANSWER = process.env.STUB_ANSWER || 'Hello from the smoke test stub.';
export const REASONING = process.env.STUB_REASONING || 'Thinking about the request.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sessions = new Map();
const eventClients = new Set();
let sessionSeq = 0;
let deletedSessions = 0;

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

// Wait (briefly) for the gateway to be subscribed before emitting, then replay the answer as incremental updates.
// `pieces`/`delayMs` let a test ask for a deliberately slow answer (a prompt containing SLOW) so it can abort a
// stream while the backend is still working.
async function streamAssistantReply(sessionID, text, reasoning, { pieces = 3, delayMs = 5 } = {}) {
    for (let i = 0; i < 200 && eventClients.size === 0; i += 1) await sleep(5);

    sendEvent(partUpdate(sessionID, { type: 'reasoning', text: reasoning }));
    await sleep(delayMs);

    const step = Math.max(1, Math.ceil(text.length / pieces));
    for (let end = step; end < text.length; end += step) {
        sendEvent(partUpdate(sessionID, { type: 'text', text: text.slice(0, end) }));
        await sleep(delayMs);
    }
    sendEvent(partUpdate(sessionID, { type: 'text', text }));
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

// The prompt body is only needed to decide whether a test asked for a slow answer
const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    const path = url.pathname;

    if (path === '/health') return sendJson(res, 200, { healthy: true });

    // Test-only introspection (not part of the OpenCode API): proves the gateway deletes the session it created
    if (path === '/__sessions') {
        return sendJson(res, 200, { live: sessions.size, created: sessionSeq, deleted: deletedSessions });
    }

    if (path === '/config/providers') {
        return sendJson(res, 200, {
            providers: [
                {
                    id: 'opencode',
                    models: { 'kimi-k2.5-free': { name: 'Kimi K2.5 Free' } }
                }
            ]
        });
    }

    if (path === '/session' && req.method === 'POST') {
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
            } catch {
                session.promptText = '';
            }
            session.prompted = true;
            session.messages.push(buildAssistantMessage(id, ANSWER, REASONING));
            sendJson(res, 200, { info: { id: `msg_${id}`, sessionID: id, role: 'assistant' }, parts: [] });
            // Fire and forget: the gateway collects the answer from /event (or polling). A prompt containing SLOW
            // is answered over ~2 s so a test can abort mid-stream while the backend is still working.
            const slow = session.promptText.includes('SLOW');
            const options = slow ? { pieces: 10, delayMs: 200 } : {};
            streamAssistantReply(id, ANSWER, REASONING, options).catch(() => {});
            return;
        }

        if (isMessage && req.method === 'GET') {
            return sendJson(res, 200, session ? session.messages : []);
        }
    }

    if (path === '/event') {
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
