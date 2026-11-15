#!/usr/bin/env node
/**
 * End-to-end smoke test: boots the stub OpenCode backend, boots the gateway against it, and asserts the
 * OpenAI-compatible contract documented in AGENTS.md.
 *
 * Run with `pnpm test`. No external dependency and no real OpenCode CLI is required, so the same command works
 * locally and in CI.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { parseBoolean } from '../src/proxy.js';
import { readConfigFile } from '../src/config.js';
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

// SIGTERM first, SIGKILL if a child ignores it: a leaked stub keeps the port and the next run silently tests the
// previous checkout's code
const stop = (child) => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
};

const waitForExit = (child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
    }, 3000);
    child.once('exit', () => {
        clearTimeout(timer);
        resolve();
    });
});

// A process already listening on the port would answer the checks with someone else's build
async function assertPortFree(port, label) {
    try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    } catch {
        return;
    }
    throw new Error(`${label} port ${port} is already in use: stop that process or set SMOKE_STUB_PORT / SMOKE_PORT`);
}

const stopGateway = (child) => {
    if (child && child.exitCode === null) child.kill('SIGINT');
};

async function request(pathname, { method = 'GET', body, key = API_KEY, stream = false, headers: extraHeaders } = {}) {
    const headers = { ...(extraHeaders || {}) };
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
    // The same parser is used by the entry point and by startProxy; a value that means "on" in one place must mean
    // "on" in the other (`-e DISABLE_TOOLS=yes` used to be read differently in the container and outside it)
    const booleanCases = [
        ['1', true], ['true', true], ['TRUE', true], ['yes', true], [' on ', true], [1, true], [true, true],
        ['0', false], ['false', false], ['no', false], ['off', false], [0, false], [false, false]
    ];
    const booleanResults = booleanCases.map(([input, expected]) => [input, parseBoolean(input, null), expected]);
    check('parseBoolean treats on/off spellings consistently',
        booleanResults.every(([, actual, expected]) => actual === expected), JSON.stringify(booleanResults));
    check('parseBoolean returns the fallback for an unknown value',
        parseBoolean('maybe', 'fallback') === 'fallback' && parseBoolean(undefined, 'fallback') === 'fallback');

    // A config.json that exists but cannot be used must stop the gateway instead of silently running with defaults
    // (which would serve traffic with the built-in key rather than the one the operator wrote)
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-'));
    try {
        const goodPath = path.join(configDir, 'good.json');
        fs.writeFileSync(goodPath, JSON.stringify({ PORT: 8188, API_KEY: 'sk-from-file' }));
        const good = readConfigFile(goodPath);
        check('readConfigFile loads an object', good.error === null && good.config.API_KEY === 'sk-from-file', String(good.error));

        check('readConfigFile accepts a missing file', readConfigFile(path.join(configDir, 'absent.json')).error === null);

        const badJsonPath = path.join(configDir, 'bad.json');
        fs.writeFileSync(badJsonPath, '{ "PORT": 8188, ');
        check('readConfigFile rejects malformed JSON', Boolean(readConfigFile(badJsonPath).error),
            String(readConfigFile(badJsonPath).error));

        const arrayPath = path.join(configDir, 'array.json');
        fs.writeFileSync(arrayPath, '[1, 2]');
        check('readConfigFile rejects a non-object document', Boolean(readConfigFile(arrayPath).error),
            String(readConfigFile(arrayPath).error));
    } finally {
        fs.rmSync(configDir, { recursive: true, force: true });
    }

    await assertPortFree(STUB_PORT, 'stub');
    await assertPortFree(GATEWAY_PORT, 'gateway');

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

    // Cold cache under a burst: ten simultaneous listings must cost the backend a single provider round trip, not ten
    const burstBefore = (await (await fetch(`${STUB_URL}/__sessions`)).json()).providerCalls;
    const burst = await Promise.all(Array.from({ length: 10 }, () => request('/v1/models')));
    const burstAfter = (await (await fetch(`${STUB_URL}/__sessions`)).json()).providerCalls;
    check('a cold-cache burst answers every request', burst.every((r) => r.response.status === 200),
        JSON.stringify(burst.map((r) => r.response.status)));
    check('a cold-cache burst costs one provider round trip', burstAfter - burstBefore === 1,
        `provider calls: ${burstAfter - burstBefore}`);
    // The burst above also proves the result was cached: a listing served from the cache must not reach the backend
    await request('/v1/models');
    await request('/v1/models');
    const cachedCalls = (await (await fetch(`${STUB_URL}/__sessions`)).json()).providerCalls;
    check('a repeated listing is served from the cache', cachedCalls === burstAfter,
        `provider calls: ${cachedCalls - burstAfter} extra`);

    // A model id is looked up in both shapes: the slash escaped and the slash as a path separator
    const encodedModel = await request('/v1/models/opencode%2Fkimi-k2.5-free');
    check('GET /v1/models/<id> finds the listed model', encodedModel.response.status === 200 &&
        encodedModel.json?.id === 'opencode/kimi-k2.5-free', encodedModel.text.slice(0, 160));
    const unencodedModel = await request('/v1/models/opencode/kimi-k2.5-free');
    check('GET /v1/models/<id> accepts an unencoded slash', unencodedModel.response.status === 200 &&
        unencodedModel.json?.id === 'opencode/kimi-k2.5-free', unencodedModel.text.slice(0, 160));

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

    // A liveness probe must not have to carry the key, whatever form it takes: the router tolerates a trailing
    // slash, and many probes use HEAD
    const healthSlash = await fetch(`${BASE}/health/`);
    check('a trailing slash does not turn /health into a 401', healthSlash.status === 200, `status ${healthSlash.status}`);
    await healthSlash.text();
    const healthHead = await fetch(`${BASE}/health`, { method: 'HEAD' });
    check('HEAD /health answers without a key', healthHead.status === 200, `status ${healthHead.status}`);

    // --- models -----------------------------------------------------------------------------------------
    const models = await request('/v1/models');
    check('GET /v1/models returns 200', models.response.status === 200, `status ${models.response.status}`);
    const modelIds = Array.isArray(models.json?.data) ? models.json.data.map((m) => m.id) : [];
    check('GET /v1/models lists provider/model ids',
        modelIds.includes('opencode/kimi-k2.5-free') && modelIds.includes('opencode/gpt-5-mini-free'),
        JSON.stringify(modelIds));

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

    // Fastify rejects the body before the handler runs; its error must use the same envelope as ours
    const badJson = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: '{"messages": ['
    });
    const badJsonPayload = await badJson.json().catch(() => null);
    check('malformed JSON returns 400', badJson.status === 400, `status ${badJson.status}`);
    check('malformed JSON uses the invalid_request_error type',
        badJsonPayload?.error?.type === 'invalid_request_error', JSON.stringify(badJsonPayload).slice(0, 160));

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
    // Every frame is a chat.completion.chunk, the terminal one included: a client that validates the object type
    // on each frame used to hit a bare {id, choices} envelope on the last one
    const stopChunk = chunks.find((chunk) => chunk?.choices?.[0]?.finish_reason === 'stop');
    check('the terminal frame carries the full chunk envelope',
        stopChunk?.object === 'chat.completion.chunk' && typeof stopChunk?.created === 'number' &&
        stopChunk?.model === 'opencode/kimi-k2.5-free', JSON.stringify(stopChunk));

    // `stream_options.include_usage` asks for the OpenAI usage chunk: empty choices, sent after the finish chunk and
    // before [DONE]. A client that reads it (the OpenAI SDK does) otherwise ends up without token numbers
    check('a plain stream carries no usage chunk',
        chunks.every((chunk) => !chunk?.usage), JSON.stringify(chunks.filter((chunk) => chunk?.usage)[0] || null));
    const withUsage = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } },
        stream: true
    });
    const usageChunks = parseSseFrames(withUsage.text)
        .filter((frame) => frame !== '[DONE]')
        .map((frame) => { try { return JSON.parse(frame); } catch { return null; } })
        .filter(Boolean);
    const usageChunk = usageChunks.find((chunk) => chunk?.usage);
    check('stream_options.include_usage is answered with a usage chunk',
        Boolean(usageChunk) && Array.isArray(usageChunk.choices) && usageChunk.choices.length === 0,
        JSON.stringify(usageChunk));
    check('the usage chunk carries the same envelope as the other chunks',
        usageChunk?.object === 'chat.completion.chunk' && usageChunk?.model === 'opencode/kimi-k2.5-free' &&
        typeof usageChunk?.usage?.total_tokens === 'number', JSON.stringify(usageChunk));
    check('the usage chunk comes after the finish chunk and before [DONE]',
        usageChunks.indexOf(usageChunk) > usageChunks.findIndex((chunk) => chunk?.choices?.[0]?.finish_reason === 'stop') &&
        withUsage.text.trimEnd().endsWith('data: [DONE]'), withUsage.text.slice(-120));

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

    // `stream` is sent as a boolean by real SDKs, but hand-written clients also send 1/"yes". Anything unrecognised
    // keeps the non-streaming default instead of guessing at the client's intent.
    const numericStream = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'opencode/kimi-k2.5-free', messages: [{ role: 'user', content: 'hi' }], stream: 1 },
        stream: true
    });
    check('stream accepts a numeric 1 as true',
        numericStream.text.includes('data: [DONE]') && numericStream.text.includes('"finish_reason":"stop"'),
        JSON.stringify(numericStream.text).slice(0, 120));
    const wordStream = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'opencode/kimi-k2.5-free', messages: [{ role: 'user', content: 'hi' }], stream: 'yes' },
        stream: true
    });
    check('stream accepts "yes" as true', wordStream.text.includes('data: [DONE]'),
        JSON.stringify(wordStream.text).slice(0, 120));
    const falseStream = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'opencode/kimi-k2.5-free', messages: [{ role: 'user', content: 'hi' }], stream: 'no' }
    });
    check('stream accepts "no" as false',
        falseStream.json?.object === 'chat.completion' && !falseStream.text.includes('data: [DONE]'),
        JSON.stringify(falseStream.text).slice(0, 120));

    // A provider that ends its message without the literal finish reason "stop" must still end the stream: waiting
    // for the exact word would leave the client hanging until the 8 s idle timeout
    const endOnlyStart = Date.now();
    const endOnly = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'opencode/kimi-k2.5-free', messages: [{ role: 'user', content: 'ENDONLY' }], stream: true },
        stream: true
    });
    const endOnlyElapsed = Date.now() - endOnlyStart;
    const endOnlyContent = parseSseFrames(endOnly.text)
        .filter((frame) => frame !== '[DONE]')
        .map((frame) => {
            try {
                return JSON.parse(frame);
            } catch {
                return null;
            }
        })
        .filter((chunk) => chunk?.choices?.[0]?.delta?.content)
        .map((chunk) => chunk.choices[0].delta.content)
        .join('');
    check('a finish signal other than "stop" still ends the stream quickly', endOnlyElapsed < 2000,
        `${endOnlyElapsed} ms`);
    check('the answer of a non-"stop" finish is complete', endOnlyContent === ANSWER, JSON.stringify(endOnlyContent));

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

    // --- a non-streaming answer must be complete -----------------------------------------------------------
    // The prompt returns while the answer is still being written; the first poll therefore sees a fragment
    const growing = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'GROW' }], stream: false }
    });
    check('a non-streaming completion waits for the finished message',
        growing.json?.choices?.[0]?.message?.content === ANSWER,
        JSON.stringify(growing.json?.choices?.[0]?.message?.content));

    // --- a provider failure in non-streaming mode ---------------------------------------------------------
    const failed = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'FAIL' }], stream: false }
    });
    check('a non-streaming provider error answers 502', failed.response.status === 502, `status ${failed.response.status}`);
    check('a 502 carries the server_error envelope with the provider error code',
        failed.json?.error?.type === 'server_error' && failed.json?.error?.code === 'ProviderError',
        failed.text.slice(0, 160));
    const afterFailure = await fetch(`${STUB_URL}/__sessions`).then((r) => r.json()).catch(() => null);
    check('a failed completion still deletes its session',
        afterFailure && afterFailure.live === 0, JSON.stringify(afterFailure));

    // --- a provider failure in streaming mode -------------------------------------------------------------
    // The provider reports the failure before a single frame reaches the client, so the answer is an HTTP error
    // envelope (like the non-streaming 502). It used to be a 200 SSE stream whose only content was the string
    // "[Proxy Error] …" with finish_reason stop, which every client reads as a successful answer.
    const streamedFailure = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'FAIL' }], stream: true },
        stream: true
    });
    check('a streaming provider error answers 502, not a 200 stream',
        streamedFailure.response.status === 502, `status ${streamedFailure.response.status}`);
    const streamedFailureError = (() => {
        try {
            return JSON.parse(streamedFailure.text);
        } catch {
            return null;
        }
    })();
    check('a streaming provider error carries the server_error envelope',
        streamedFailureError?.error?.type === 'server_error' &&
        /ProviderError/.test(streamedFailureError?.error?.message || ''),
        streamedFailure.text.slice(0, 160));
    check('a streaming provider error is never delivered as model text',
        !/Proxy Error/.test(streamedFailure.text), streamedFailure.text.slice(0, 160));

    // --- request ids --------------------------------------------------------------------------------------
    // A client-supplied trace id is kept so its logs and the gateway's can be joined; the response header is
    // exposed to browsers, and a value that could break the log line or the header is ignored rather than echoed
    const traced = await request('/health', { headers: { 'X-Request-Id': 'trace-abc123' } });
    check('a client trace id is echoed back in X-Request-Id',
        traced.response.headers.get('x-request-id') === 'trace-abc123',
        traced.response.headers.get('x-request-id'));
    check('X-Request-Id is exposed to browser clients',
        (traced.response.headers.get('access-control-expose-headers') || '').includes('X-Request-Id'),
        traced.response.headers.get('access-control-expose-headers'));
    const injected = await request('/health', { headers: { 'X-Request-Id': 'bad id with spaces' } });
    const injectedId = injected.response.headers.get('x-request-id') || '';
    check('an unusable client trace id is replaced by a generated one',
        injectedId.startsWith('gw-'), injectedId);

    // --- session lifecycle -------------------------------------------------------------------------------
    // One session is created and must be deleted per completion; a leak would grow the backend without bound
    const stubStats = await fetch(`${STUB_URL}/__sessions`).then((r) => r.json()).catch(() => null);
    check('every completion deletes the session it created',
        stubStats && stubStats.deleted > 0 && stubStats.live === 0, JSON.stringify(stubStats));

    // --- a backend URL with a trailing slash --------------------------------------------------------------
    // Every SDK call would be `//session` (404 on the backend), which used to look like "the backend cannot start"
    const slashPort = GATEWAY_PORT + 6;
    const slashUrl = `http://127.0.0.1:${slashPort}`;
    const slashGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(slashPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `${STUB_URL}/`,
            LOG_LEVEL: 'warn'
        }
    });
    children.push(slashGateway);
    slashGateway.stdout.on('data', () => {});
    slashGateway.stderr.on('data', () => {});
    await waitForOk(`${slashUrl}/health`);
    const slashHealth = await fetch(`${slashUrl}/health`).then((r) => r.json()).catch(() => null);
    check('a trailing slash in the backend URL is normalised',
        slashHealth?.backend === STUB_URL, JSON.stringify(slashHealth));
    const slashCompletion = await fetch(`${slashUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    }).then((r) => r.text());
    check('completions work with a trailing-slash backend URL',
        slashCompletion.includes(ANSWER), slashCompletion.slice(0, 160));

    // --- bounded queue -----------------------------------------------------------------------------------
    // OPENCODE_PROXY_MAX_QUEUE=0 removes every waiting slot: a completion is refused only when every slot is busy,
    // never when one is free (the cap counts waiting requests, not all requests)
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
    // A free slot means no waiting, so a queue of 0 must still serve this request (it used to answer 503 to every
    // completion, i.e. one setting silently switched the gateway off)
    const loneResponse = await fetch(`${cappedUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: cappedBody
    });
    await loneResponse.text();
    check('a queue of 0 still serves a completion when a slot is free', loneResponse.status === 200,
        `status ${loneResponse.status}`);

    // A busy gateway with no waiting room refuses instead of queueing. The slot is held by a streaming SLOW request
    // (the stub writes it over ~2 s; a non-streaming one returns as soon as the message is stored, which is far too
    // fast to hold anything), so the check does not depend on which of two simultaneous requests starts first.
    const cappedRequest = (content) => fetch(`${cappedUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content }] })
    }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));
    // The slot is released when the response is complete, not when the session cleanup round trip finishes: a client
    // that sends its next request straight after an answer must be served, never told the gateway is full.
    const sequentialStatuses = [];
    for (let i = 0; i < 4; i += 1) sequentialStatuses.push((await cappedRequest('hi')).status);
    check('consecutive completions are served on a queue of 0', sequentialStatuses.every((status) => status === 200),
        JSON.stringify(sequentialStatuses));

    const cappedHolder = fetch(`${cappedUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'SLOW holder' }], stream: true })
    }).then(async (response) => ({ status: response.status, text: await response.text() }));
    await sleep(300);
    const cappedRefused = await cappedRequest('SLOW queued behind');
    check('a busy queue of 0 is answered with 503', cappedRefused.status === 503, `status ${cappedRefused.status}`);
    check('503 uses the queue_full envelope', cappedRefused.json?.error?.type === 'queue_full',
        JSON.stringify(cappedRefused.json));
    const cappedHeld = await cappedHolder;
    check('the request that held the slot is still served', cappedHeld.status === 200, `status ${cappedHeld.status}`);
    const cappedHealth = await fetch(`${cappedUrl}/health`);
    check('rejected requests leave the gateway healthy', cappedHealth.status === 200, `status ${cappedHealth.status}`);
    await cappedHealth.text();

    // --- a configured limit is reported --------------------------------------------------------------------
    // A clamp or a typo used to be invisible: the gateway silently ran with a different limit than the one configured
    const limitPort = GATEWAY_PORT + 5;
    const limitUrl = `http://127.0.0.1:${limitPort}`;
    let limitOutput = '';
    const limitGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(limitPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            LOG_LEVEL: 'info',
            OPENCODE_PROXY_MAX_CONCURRENCY: '99'
        }
    });
    children.push(limitGateway);
    limitGateway.stdout.on('data', (chunk) => {
        limitOutput += chunk;
    });
    limitGateway.stderr.on('data', (chunk) => {
        limitOutput += chunk;
    });
    await waitForOk(`${limitUrl}/health`);
    check('the startup summary reports the concurrency actually used',
        limitOutput.includes('Concurrency: 32 completion(s)'), limitOutput.split('\n').filter((line) => line.includes('Concurrency')).join(' | '));
    check('a clamped limit is explained instead of applied silently',
        limitOutput.includes('OPENCODE_PROXY_MAX_CONCURRENCY=99 is above the maximum 32'),
        limitOutput.split('\n').filter((line) => line.includes('MAX_CONCURRENCY')).join(' | '));

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
    const stallErrorFrame = String(stallResponse)
        .split('\n\n')
        .map((frame) => {
            try {
                return JSON.parse(frame.replace(/^data: /, ''));
            } catch {
                return null;
            }
        })
        .find((frame) => frame?.error);
    check('a timeout is reported as a server_error', stallErrorFrame?.error?.type === 'server_error',
        JSON.stringify(stallErrorFrame || null).slice(0, 160));

    check('the closed stream ends with [DONE]',
        stallResponse !== 'timeout' && stallResponse.includes('data: [DONE]'), String(stallResponse).slice(0, 200));
    check('the client sees an error frame', stallResponse !== 'timeout' && stallResponse.includes('"error"'),
        String(stallResponse).slice(0, 200));

    // --- a tool-call block split across deltas -----------------------------------------------------------
    // With tools disabled, the markup has to be removed even when the backend cuts it in the middle of a tag:
    // the held-back fragment must not leak into the answer and the text after it must still arrive.
    const toolPort = GATEWAY_PORT + 3;
    const toolUrl = `http://127.0.0.1:${toolPort}`;
    const toolGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(toolPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            LOG_LEVEL: 'warn',
            DISABLE_TOOLS: 'true'
        }
    });
    children.push(toolGateway);
    toolGateway.stdout.on('data', () => {});
    toolGateway.stderr.on('data', () => {});
    await waitForOk(`${toolUrl}/health`);

    const toolResponse = await fetch(`${toolUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'TOOLTAG please' }], stream: true })
    }).then((response) => response.text());
    const toolFrames = toolResponse
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
        .map((frame) => {
            try {
                return JSON.parse(frame.slice(6));
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    const toolText = toolFrames.map((frame) => frame.choices?.[0]?.delta?.content || '').join('');
    check('a tag split across deltas never reaches the client',
        !toolText.includes('function_calls') && !toolText.includes('secret'), toolText);
    check('the text around a split tag is preserved',
        toolText.includes('hello') && toolText.trim().endsWith('world'), toolText);

    // The same filter holds back a trailing fragment that could still become a tag. When the stream ends that
    // fragment turns out to be plain text and must be delivered - it used to be dropped, truncating the answer.
    const tailResponse = await fetch(`${toolUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'TAILTAG please' }], stream: true })
    }).then((response) => response.text());
    const tailText = tailResponse
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
        .map((frame) => {
            try {
                return JSON.parse(frame.slice(6));
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .map((frame) => frame.choices?.[0]?.delta?.content || '')
        .join('');
    check('a held fragment that is not a tag is delivered at the end of the stream',
        tailText.trim() === 'hello world <function_call', JSON.stringify(tailText));

    // --- a non-ASCII key ----------------------------------------------------------------
    // The bearer check compares bytes: a key with accented characters matching in string length but not in byte
    // length used to make timingSafeEqual throw, answering 500 instead of 401 for a wrong key
    // Latin-1 range so the value is a legal header on the wire ('ậ' would be rejected by the client itself)
    const unicodeKey = 'khoá-bi-mât';
    const unicodePort = GATEWAY_PORT + 4;
    await assertPortFree(unicodePort, 'unicode gateway');
    const unicodeGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(unicodePort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            API_KEY: unicodeKey,
            LOG_LEVEL: 'error'
        }
    });
    children.push(unicodeGateway);
    unicodeGateway.stdout.on('data', () => {});
    unicodeGateway.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${unicodePort}/health`);
    // Same character count as the real key, different bytes (accented vs plain ASCII), so only the byte comparison
    // separates the two: this used to make timingSafeEqual throw and answer 500
    const lookalike = 'khoa-bi-mat';
    const mismatchStatus = await fetch(`http://127.0.0.1:${unicodePort}/v1/models`, {
        headers: { authorization: `Bearer ${lookalike}` }
    }).then((response) => { return response.text().then(() => response.status); });
    check('a lookalike non-ASCII key is rejected with 401, not 500', mismatchStatus === 401, `status ${mismatchStatus}`);
    const unicodeStatus = await fetch(`http://127.0.0.1:${unicodePort}/v1/models`, {
        headers: { authorization: `Bearer ${unicodeKey}` }
    }).then((response) => { return response.text().then(() => response.status); });
    check('a non-ASCII key authenticates when it matches exactly', unicodeStatus === 200, `status ${unicodeStatus}`);

    // --- shutdown keeps the backend until the answers are done -------------------------------------------
    // The gateway spawns its own backend here (a script that starts the stub on the requested port), because only a
    // backend the gateway owns is killed on shutdown - and that is the one an in-flight completion depends on.
    const spawnPort = GATEWAY_PORT + 7;
    const spawnUrl = `http://127.0.0.1:${spawnPort}`;
    const fakeBin = path.join(os.tmpdir(), `free-opencode-api-fake-opencode-${process.pid}.sh`);
    const fakePidFile = `${fakeBin}.pid`;
    fs.writeFileSync(fakeBin, [
        '#!/bin/sh',
        '# Test double for `opencode serve`: starts the stub on the port the gateway asked for',
        'port=4097',
        'prev=""',
        'for arg in "$@"; do',
        '    if [ "$prev" = "--port" ]; then port="$arg"; fi',
        '    prev="$arg"',
        'done',
        `echo $$ > "${fakePidFile}"`,
        `STUB_PORT="$port" exec "${process.execPath}" "${path.join(ROOT, 'test', 'stub-opencode.mjs')}"`,
        ''
    ].join('\n'), { mode: 0o755 });
    const spawnGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(spawnPort + 1),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: spawnUrl,
            OPENCODE_PATH: fakeBin,
            // Retry immediately after the backend died: the cooldown exists for a start that cannot succeed at all
            OPENCODE_PROXY_START_RETRY_MS: '0',
            LOG_LEVEL: 'warn'
        }
    });
    children.push(spawnGateway);
    spawnGateway.stdout.on('data', () => {});
    spawnGateway.stderr.on('data', () => {});
    const gatewayUrl = `http://127.0.0.1:${spawnPort + 1}`;
    await waitForOk(`${gatewayUrl}/health`);
    // The first completion is what starts the backend (`/v1/models` falls back to a static list instead)
    const spawnedCompletion = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    }).then((r) => r.text().then((body) => ({ status: r.status, body })));
    check('the gateway starts the backend it was pointed at',
        spawnedCompletion.status === 200 && spawnedCompletion.body.includes(ANSWER),
        `status ${spawnedCompletion.status} ${spawnedCompletion.body.slice(0, 120)}`);
    const backendUp = await fetch(`${spawnUrl}/health`).then((r) => r.status).catch(() => 0);
    check('the spawned backend is reachable', backendUp === 200, `status ${backendUp}`);

    // A backend that disappears in the middle of a request is an upstream failure (502), not a gateway bug (500),
    // and the next request must start it again instead of failing until the process is restarted
    const killInFlight = fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'HOLD while the backend dies' }] })
    }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));
    await sleep(250);
    try {
        process.kill(Number(fs.readFileSync(fakePidFile, 'utf8').trim()), 'SIGKILL');
    } catch { /* already gone */ }
    const killedAnswer = await killInFlight;
    check('a backend that dies mid request is reported as an upstream error',
        killedAnswer.status === 502 && killedAnswer.json?.error?.type === 'server_error',
        `status ${killedAnswer.status} ${JSON.stringify(killedAnswer.json)?.slice(0, 140)}`);
    const restartStartedAt = Date.now();
    const afterRestart = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi again' }] }),
        // A gateway that waits out its whole startup budget instead of noticing the dead child fails here quickly
        signal: AbortSignal.timeout(10000)
    }).then((r) => r.text().then((body) => ({ status: r.status, body })))
        .catch((error) => ({ status: 0, body: error.message }));
    check('the next request starts the backend again',
        afterRestart.status === 200 && afterRestart.body.includes(ANSWER),
        `status ${afterRestart.status} after ${Date.now() - restartStartedAt}ms ${afterRestart.body.slice(0, 140)}`);

    const heldInFlight = fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'HOLD in flight' }] })
    }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));
    await sleep(150);
    const spawnExit = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 15000);
        spawnGateway.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
        stopGateway(spawnGateway);
    });
    const heldAnswer = await heldInFlight;
    check('a completion in flight is answered while shutting down', heldAnswer.status === 200,
        `status ${heldAnswer.status} ${JSON.stringify(heldAnswer.json)?.slice(0, 120)}`);
    check('the answer served during shutdown is complete',
        heldAnswer.json?.choices?.[0]?.message?.content === ANSWER,
        JSON.stringify(heldAnswer.json?.choices?.[0]?.message));
    check('shutdown exits cleanly with a spawned backend', spawnExit === 0, `exit ${spawnExit}`);
    let backendGone = false;
    for (let i = 0; i < 20 && !backendGone; i += 1) {
        backendGone = await fetch(`${spawnUrl}/health`).then(() => false).catch(() => true);
        if (!backendGone) await sleep(100);
    }
    check('the spawned backend does not outlive the gateway', backendGone, 'still answering');
    try { fs.unlinkSync(fakeBin); } catch { /* best effort */ }
    try { fs.unlinkSync(fakePidFile); } catch { /* best effort */ }

    // --- graceful shutdown ------------------------------------------------------------------------------
    // The same property on the long-running gateway, whose backend is external and therefore untouched
    const heldLongLived = fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'HOLD in flight' }] })
    }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));
    await sleep(150);
    const longLivedExit = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 10000);
        gateway.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
        stopGateway(gateway);
    });
    const heldLongLivedAnswer = await heldLongLived;
    check('SIGINT shuts the gateway down cleanly', longLivedExit === 0, `exit ${longLivedExit}`);
    check('the shutdown leaves no truncated answer behind', heldLongLivedAnswer.status === 200,
        `status ${heldLongLivedAnswer.status}`);
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
    await Promise.all(children.map((child) => waitForExit(child)));
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
