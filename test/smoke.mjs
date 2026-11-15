#!/usr/bin/env node
/**
 * End-to-end smoke test: boots the stub OpenCode backend, boots the gateway against it, and asserts the
 * OpenAI-compatible contract documented in AGENTS.md.
 *
 * Run with `pnpm test`. No external dependency and no real OpenCode CLI is required, so the same command works
 * locally and in CI.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = Number(process.env.SMOKE_STUB_PORT || 4199);
const GATEWAY_PORT = Number(process.env.SMOKE_PORT || 8199);
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
const BASE = `http://127.0.0.1:${GATEWAY_PORT}`;
const API_KEY = 'sk-dummy-123';
const ANSWER = 'Hello from the smoke test stub.';
const REASONING = 'Thinking about the request.';

const results = [];
const children = [];
let gatewayOutput = '';
let stubOutput = '';

const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    const mark = ok ? 'ok  ' : 'FAIL';
    console.log(`  [${mark}] ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const check = (name, condition, detail) => record(name, Boolean(condition), detail);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOk(url, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (response.ok) {
                await response.text();
                return;
            }
            lastError = new Error(`status ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await sleep(100);
    }
    throw new Error(`timeout waiting for ${url}: ${lastError ? lastError.message : 'unknown error'}`);
}

const stop = (child) => {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
};

const stopGateway = (child) => {
    if (child && child.exitCode === null) child.kill('SIGINT');
};

async function request(pathname, { method = 'GET', body, key = API_KEY, stream = false } = {}) {
    const headers = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${BASE}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
    });
    if (stream) return { response, text: await response.text() };
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    return { response, text, json };
}

function parseSseFrames(body) {
    return body
        .split('\n\n')
        .map((frame) => frame.trim())
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => frame.slice('data: '.length));
}

async function run() {
    // 1. stub backend first: the gateway trusts a fresh health probe, so the stub must be listening already
    const stub = spawn(process.execPath, [path.join(ROOT, 'test', 'stub-opencode.mjs')], {
        cwd: ROOT,
        env: { ...process.env, STUB_PORT: String(STUB_PORT) }
    });
    children.push(stub);
    stub.stdout.on('data', (chunk) => { stubOutput += chunk; });
    stub.stderr.on('data', (chunk) => { stubOutput += chunk; });
    await waitForOk(`${STUB_URL}/health`);

    // 2. gateway on top of the stub
    const gateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(GATEWAY_PORT),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            LOG_LEVEL: 'info'
        }
    });
    children.push(gateway);
    gateway.stdout.on('data', (chunk) => { gatewayOutput += chunk; });
    gateway.stderr.on('data', (chunk) => { gatewayOutput += chunk; });
    await waitForOk(`${BASE}/health`);

    // --- health -----------------------------------------------------------------------------------------
    const health = await request('/health', { key: null });
    check('GET /health returns 200', health.response.status === 200, `status ${health.response.status}`);
    check('GET /health reports gateway status ok', health.json?.status === 'ok', health.text.slice(0, 120));
    check('GET /health reports the backend URL', health.json?.backend === STUB_URL, health.text.slice(0, 120));
    check('GET /health keeps the exact documented body',
        health.text === JSON.stringify({ status: 'ok', backend: STUB_URL }), health.text);
    check('GET /health is served as JSON',
        (health.response.headers.get('content-type') || '').includes('application/json'),
        health.response.headers.get('content-type'));

    // --- root index -------------------------------------------------------------------------------------
    const root = await request('/', { key: null });
    check('GET / answers without a key', root.response.status === 200, `status ${root.response.status}`);
    check('GET / lists the service endpoints',
        root.json?.service === 'free-opencode-api' && root.json?.endpoints?.chat_completions === '/v1/chat/completions',
        root.text.slice(0, 160));

    // --- auth -------------------------------------------------------------------------------------------
    const noAuth = await request('/v1/models', { key: null });
    check('unauthenticated /v1/models is rejected', noAuth.response.status === 401, `status ${noAuth.response.status}`);
    check('401 uses the OpenAI error envelope', noAuth.json?.error?.message === 'Unauthorized', noAuth.text.slice(0, 120));
    check('401 carries a type and code', noAuth.json?.error?.type === 'invalid_request_error' &&
        noAuth.json?.error?.code === 'invalid_api_key', noAuth.text.slice(0, 160));
    check('the response echoes the request id used in the log line', /^gw-[a-z0-9]+$/.test(
        noAuth.response.headers.get('x-request-id') || ''), noAuth.response.headers.get('x-request-id'));

    const wrongKey = await request('/v1/models', { key: 'sk-wrong' });
    check('a wrong bearer token is rejected', wrongKey.response.status === 401, `status ${wrongKey.response.status}`);

    // --- preflight --------------------------------------------------------------------------------------
    const preflight = await fetch(`${BASE}/v1/chat/completions`, { method: 'OPTIONS' });
    check('OPTIONS preflight returns 204', preflight.status === 204, `status ${preflight.status}`);
    check('CORS headers are present on preflight', preflight.headers.get('access-control-allow-origin') === '*');

    // --- models -----------------------------------------------------------------------------------------
    const models = await request('/v1/models');
    check('GET /v1/models returns 200', models.response.status === 200, `status ${models.response.status}`);
    const modelIds = Array.isArray(models.json?.data) ? models.json.data.map((m) => m.id) : [];
    check('GET /v1/models lists provider/model ids', modelIds.includes('opencode/kimi-k2.5-free'), JSON.stringify(modelIds));

    const knownModel = await request('/v1/models/opencode%2Fkimi-k2.5-free');
    check('GET /v1/models/:id returns the listed model', knownModel.response.status === 200 &&
        knownModel.json?.id === 'opencode/kimi-k2.5-free', knownModel.text.slice(0, 120));
    const otherModel = await request('/v1/models/some-other-model');
    check('GET /v1/models/:id describes an unlisted model instead of 404', otherModel.response.status === 200 &&
        otherModel.json?.id === 'some-other-model' && otherModel.json?.owned_by === 'opencode',
        otherModel.text.slice(0, 120));

    // --- validation -------------------------------------------------------------------------------------
    const invalid = await request('/v1/chat/completions', { method: 'POST', body: {} });
    check('missing messages array returns 400', invalid.response.status === 400, `status ${invalid.response.status}`);
    check('400 uses the OpenAI error envelope', typeof invalid.json?.error?.message === 'string', invalid.text.slice(0, 120));
    check('400 carries the invalid_request_error type', invalid.json?.error?.type === 'invalid_request_error',
        invalid.text.slice(0, 120));

    const nullBody = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: 'null'
    });
    const nullBodyJson = await nullBody.json().catch(() => null);
    check('a JSON null body returns 400', nullBody.status === 400, `status ${nullBody.status}`);
    check('400 for a null body keeps the envelope', typeof nullBodyJson?.error?.message === 'string', JSON.stringify(nullBodyJson));

    const badModel = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: 5, messages: [{ role: 'user', content: 'hi' }] }
    });
    check('a non-string model returns 400', badModel.response.status === 400, `status ${badModel.response.status}`);

    const stringStream = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'hi' }], stream: 'false' }
    });
    check('stream: "false" is treated as non-streaming', stringStream.json?.object === 'chat.completion',
        stringStream.text.slice(0, 120));

    const unknownRoute = await request('/nope');
    check('unknown route returns 404', unknownRoute.response.status === 404, `status ${unknownRoute.response.status}`);
    check('404 uses the not_found envelope', unknownRoute.json?.error?.type === 'not_found', unknownRoute.text.slice(0, 120));

    // --- non-streaming completion -----------------------------------------------------------------------
    const completion = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'opencode/kimi-k2.5-free', messages: [{ role: 'user', content: 'hi' }] }
    });
    check('non-streaming completion returns 200', completion.response.status === 200, `status ${completion.response.status}`);
    check('non-streaming completion has object chat.completion', completion.json?.object === 'chat.completion', completion.text.slice(0, 160));
    check('non-streaming completion returns the stubbed content',
        completion.json?.choices?.[0]?.message?.content === ANSWER,
        JSON.stringify(completion.json?.choices?.[0]?.message?.content));
    check('non-streaming completion returns reasoning_content',
        completion.json?.choices?.[0]?.message?.reasoning_content === REASONING,
        JSON.stringify(completion.json?.choices?.[0]?.message?.reasoning_content));
    check('non-streaming completion finishes with stop',
        completion.json?.choices?.[0]?.finish_reason === 'stop',
        JSON.stringify(completion.json?.choices?.[0]?.finish_reason));

    // --- streaming completion ---------------------------------------------------------------------------
    const streamed = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'opencode/kimi-k2.5-free', messages: [{ role: 'user', content: 'hi' }], stream: true },
        stream: true
    });
    check('streaming completion returns 200', streamed.response.status === 200, `status ${streamed.response.status}`);
    check('streaming completion uses text/event-stream',
        (streamed.response.headers.get('content-type') || '').includes('text/event-stream'),
        streamed.response.headers.get('content-type'));

    const frames = parseSseFrames(streamed.text);
    check('stream ends with the [DONE] frame', frames[frames.length - 1] === '[DONE]', frames[frames.length - 1]);

    const chunks = frames
        .filter((frame) => frame !== '[DONE]')
        .map((frame) => {
            try {
                return JSON.parse(frame);
            } catch {
                return null;
            }
        });
    check('every SSE delta frame is valid JSON', chunks.every((chunk) => chunk !== null), `${chunks.length} frames`);

    const contentDeltas = chunks
        .filter((chunk) => chunk?.choices?.[0]?.delta?.content)
        .map((chunk) => chunk.choices[0].delta.content)
        .join('');
    check('streamed content matches the stubbed answer', contentDeltas === ANSWER, JSON.stringify(contentDeltas));
    // The stub interleaves events that carry no properties; a subscription that gave up on them would deliver the
    // answer in one polled frame instead of the stub's incremental ones
    const contentFrameCount = chunks.filter((chunk) => chunk?.choices?.[0]?.delta?.content).length;
    check('property-less backend events do not break the stream', contentFrameCount >= 2,
        `${contentFrameCount} content frame(s)`);

    const reasoningDeltas = chunks
        .filter((chunk) => chunk?.choices?.[0]?.delta?.reasoning_content)
        .map((chunk) => chunk.choices[0].delta.reasoning_content)
        .join('');
    check('streamed reasoning_content matches the stub', reasoningDeltas === REASONING, JSON.stringify(reasoningDeltas));

    check('stream ends with a finish_reason stop frame',
        chunks.some((chunk) => chunk?.choices?.[0]?.finish_reason === 'stop'),
        JSON.stringify(chunks[chunks.length - 1] || null));
    check('stream chunks carry the requested model',
        chunks.every((chunk) => !chunk?.model || chunk.model === 'opencode/kimi-k2.5-free'));

    // A model id can contain more than one slash; only the first one separates provider from model
    const multiSlash = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'vendor/family/version', messages: [{ role: 'user', content: 'hi' }], stream: true },
        stream: true
    });
    const multiSlashModels = parseSseFrames(multiSlash.text)
        .filter((frame) => frame !== '[DONE]')
        .map((frame) => {
            try {
                return JSON.parse(frame);
            } catch {
                return null;
            }
        })
        .map((chunk) => chunk?.model)
        .filter(Boolean);
    check('a model id with several slashes is echoed intact',
        multiSlashModels.length > 0 && multiSlashModels.every((name) => name === 'vendor/family/version'),
        JSON.stringify(multiSlashModels[0]));

    // --- no stalled stream requests ---------------------------------------------------------------------
    // Regression guard: a silent event stream used to cost a fixed 4 s wait on every other request
    const durations = [];
    for (let i = 0; i < 3; i += 1) {
        const startedAt = Date.now();
        const sequential = await request('/v1/chat/completions', {
            method: 'POST',
            body: { messages: [{ role: 'user', content: 'hi' }], stream: true },
            stream: true
        });
        durations.push(Date.now() - startedAt);
        check(`sequential stream #${i + 1} completes`, sequential.text.includes('[DONE]'));
    }
    check('sequential stream requests stay well under the old 4 s stall',
        durations.every((duration) => duration < 2000),
        `durations ${durations.join(', ')} ms`);

    // --- an abandoned stream must free the completion slot ------------------------------------------------
    // Regression guard: the queue has one slot by default, so a stream nobody reads used to block every other
    // client until the backend finished (or the 5 minute timeout hit).
    const abortController = new AbortController();
    const slowRequest = fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'SLOW reply please' }], stream: true }),
        signal: abortController.signal
    }).then((response) => response.text()).catch(() => null);
    await sleep(250);
    abortController.abort();
    await slowRequest;

    const afterAbortAt = Date.now();
    const afterAbort = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'hi' }] }
    });
    const afterAbortMs = Date.now() - afterAbortAt;
    check('a completion after an aborted stream succeeds', afterAbort.response.status === 200,
        `status ${afterAbort.response.status}`);
    check('an aborted stream releases its queue slot before the backend finishes', afterAbortMs < 1200,
        `${afterAbortMs} ms (the slow reply takes ~2000 ms)`);

    // --- a request abandoned while queued never reaches the backend ---------------------------------------
    // The aborted stream above frees the slot; this one proves the queue itself drops work nobody waits for, so an
    // abandoned request cannot spend backend time or delay the requests queued behind it.
    const statsBefore = await fetch(`${STUB_URL}/__sessions`).then((r) => r.json());
    const holderController = new AbortController();
    const holderPromise = fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'SLOW holder' }], stream: true }),
        signal: holderController.signal
    }).then((response) => response.text()).catch(() => null);
    await sleep(250); // the holder owns the only completion slot

    const queuedController = new AbortController();
    const queuedPromise = fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'never answered' }] }),
        signal: queuedController.signal
    }).then((response) => response.text()).catch(() => null);
    await sleep(200); // now queued behind the holder
    queuedController.abort();
    await queuedPromise;
    await holderPromise;
    await sleep(300);

    const statsAfter = await fetch(`${STUB_URL}/__sessions`).then((r) => r.json());
    check('a request abandoned while queued never reaches the backend',
        statsAfter.prompts === statsBefore.prompts + 1,
        `prompts ${statsBefore.prompts} -> ${statsAfter.prompts} (only the holder should have run)`);

    // --- session lifecycle -------------------------------------------------------------------------------
    // One session is created and must be deleted per completion; a leak would grow the backend without bound
    const stubStats = await fetch(`${STUB_URL}/__sessions`).then((r) => r.json()).catch(() => null);
    check('every completion deletes the session it created',
        stubStats && stubStats.deleted > 0 && stubStats.live === 0, JSON.stringify(stubStats));

    // --- bounded queue -----------------------------------------------------------------------------------
    // OPENCODE_PROXY_MAX_QUEUE=0 removes every waiting slot, so a completion is refused instead of queued
    const cappedPort = GATEWAY_PORT + 1;
    const cappedUrl = `http://127.0.0.1:${cappedPort}`;
    const cappedGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(cappedPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            LOG_LEVEL: 'warn',
            OPENCODE_PROXY_MAX_QUEUE: '0'
        }
    });
    children.push(cappedGateway);
    cappedGateway.stdout.on('data', () => {});
    cappedGateway.stderr.on('data', () => {});
    await waitForOk(`${cappedUrl}/health`);

    const cappedBody = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    const cappedResponse = await fetch(`${cappedUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: cappedBody
    });
    check('a full queue is answered with 503', cappedResponse.status === 503, `status ${cappedResponse.status}`);
    const cappedJson = await cappedResponse.json().catch(() => null);
    check('503 uses the queue_full envelope', cappedJson?.error?.type === 'queue_full', JSON.stringify(cappedJson));
    const cappedHealth = await fetch(`${cappedUrl}/health`);
    check('rejected requests leave the gateway healthy', cappedHealth.status === 200, `status ${cappedHealth.status}`);
    await cappedHealth.text();

    // --- a stalled stream still ends ---------------------------------------------------------------------
    // A backend that goes silent mid-answer used to leave the SSE connection open with no terminator: the client
    // waited for a stream that would never finish. The request timeout is shortened so the case stays fast.
    const stallPort = GATEWAY_PORT + 2;
    const stallUrl = `http://127.0.0.1:${stallPort}`;
    const stallGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(stallPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            LOG_LEVEL: 'warn',
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '3000'
        }
    });
    children.push(stallGateway);
    stallGateway.stdout.on('data', () => {});
    stallGateway.stderr.on('data', () => {});
    await waitForOk(`${stallUrl}/health`);

    const stallStartedAt = Date.now();
    const stallResponse = await Promise.race([
        fetch(`${stallUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'STALL please' }], stream: true })
        }).then((response) => response.text()),
        sleep(20000).then(() => 'timeout')
    ]);
    const stallMs = Date.now() - stallStartedAt;
    check('a stalled stream is closed instead of hanging', stallResponse !== 'timeout', `${stallMs} ms`);
    check('the closed stream ends with [DONE]',
        stallResponse !== 'timeout' && stallResponse.includes('data: [DONE]'), String(stallResponse).slice(0, 200));
    check('the client sees an error frame', stallResponse !== 'timeout' && stallResponse.includes('"error"'),
        String(stallResponse).slice(0, 200));

    // --- graceful shutdown ------------------------------------------------------------------------------
    const exitCode = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 10000);
        gateway.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
        stopGateway(gateway);
    });
    check('SIGINT shuts the gateway down cleanly', exitCode === 0, `exit ${exitCode}`);
}

const TIMEOUT_MS = 120000;

try {
    await Promise.race([
        run(),
        sleep(TIMEOUT_MS).then(() => {
            throw new Error(`smoke test exceeded ${TIMEOUT_MS} ms`);
        })
    ]);
} catch (error) {
    record('smoke run completed without throwing', false, error.message);
} finally {
    for (const child of children) stop(child);
}

const failed = results.filter((result) => !result.ok);

if (failed.length) {
    console.error('\n--- gateway output ---\n' + gatewayOutput.trim());
    console.error('\n--- stub output ---\n' + stubOutput.trim());
    console.error(`\n${failed.length} of ${results.length} checks failed:`);
    for (const failure of failed) console.error(` - ${failure.name}${failure.detail ? ` (${failure.detail})` : ''}`);
    process.exit(1);
}

console.log(`\nAll ${results.length} checks passed.`);
process.exit(0);
