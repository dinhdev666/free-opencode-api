#!/usr/bin/env node
/**
 * End-to-end smoke test: boots the stub OpenCode backend, boots the gateway against it, and asserts the
 * OpenAI-compatible contract documented in AGENTS.md.
 *
 * Run with `pnpm test`. No external dependency and no real OpenCode CLI is required, so the same command works
 * locally and in CI.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { parseBoolean } from '../src/proxy.js';
import { readConfigFile, findUnknownKeys } from '../src/config.js';
import {
    createLogger, maskBackendUrl, maskHeaders, maskSecret, maskUrlQuery, serializeDetail, SENSITIVE_NAME_ALTERNATIVES
} from '../src/logger.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// The gateway answers the client before deleting the session: the delete is a backend round trip that has nothing to
// do with the answer, and making the client wait for it held the completion slot. A single read of the stub's counters
// therefore races with it - on a slow runner the session was still alive a few milliseconds after the response and the
// "still deletes its session" checks failed with `live: 1`. Wait for the deletion to land instead of sampling one
// instant, and keep the whole window bounded so a real leak still fails.
async function sessionsAfterCleanup(url, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let stats = null;
    for (;;) {
        stats = await fetch(`${url}/__sessions`).then((r) => r.json()).catch(() => null);
        if (!stats || stats.live === 0 || Date.now() >= deadline) return stats;
        await sleep(50);
    }
}

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

    // --- log hygiene ---------------------------------------------------------------------------------------
    // A credential sent in the query string (`?api_key=…`, an OpenAI-compatible convention some clients still use)
    // used to reach `docker logs` verbatim at the default level; the URL is kept, only credential values are masked
    const urlMaskingCases = [
        ['/v1/models?api_key=secret', '/v1/models?api_key=***', true],
        ['/v1/models?a=1&token=secret&b=2', '/v1/models?a=1&token=***&b=2', true],
        ['/v1/models?Authorization=secret', '/v1/models?Authorization=***', true],
        ['/v1/models?%61pi_key=secret', '/v1/models?%61pi_key=***', true],
        ['/v1/models?model=opencode/big-pickle', '/v1/models?model=opencode/big-pickle', true],
        ['/v1/models?author=someone', '/v1/models?author=someone', true],
        // The spellings other clients use for the same secret: Google's `?key=`, an OAuth `?code=`, an Azure SAS
        // `?sig=`/`?signature=`. Each of them was logged verbatim, because the pattern only knew the OpenAI names.
        ['/v1/models?key=AIzaSySECRET', '/v1/models?key=***', true],
        ['/v1/models?code=oauth-code-123', '/v1/models?code=***', true],
        ['/v1/models?sig=azure-signature', '/v1/models?sig=***', true],
        ['/v1/models?X-Amz-Signature=azure-signature', '/v1/models?X-Amz-Signature=***', true],
        ['/v1/models?bearer=secret', '/v1/models?bearer=***', true],
        ['/v1/models?credential=secret', '/v1/models?credential=***', true],
        ['/v1/models?model=codex', '/v1/models?model=codex', true],
        ['/v1/models?scope=code', '/v1/models?scope=code', true]
    ];
    const urlMaskingResults = urlMaskingCases.map(([input, expected]) => [input, maskUrlQuery(input), expected]);
    check('credential query values are masked in a logged URL',
        urlMaskingResults.every(([, actual, expected]) => actual === expected), JSON.stringify(urlMaskingResults));

    // docker/docker-entrypoint.sh prints the first-boot config from `docker logs` and cannot import this module, so it
    // repeats the name list. A name added to one copy only leaves the secret in one of the two dumps, which is exactly
    // how three hand-copied CORS lists drifted once already.
    const entrypointSource = fs.readFileSync(path.join(ROOT, 'docker', 'docker-entrypoint.sh'), 'utf8');
    check('the entrypoint masks the same credential names as the logger',
        entrypointSource.includes(`(${SENSITIVE_NAME_ALTERNATIVES})`),
        JSON.stringify(SENSITIVE_NAME_ALTERNATIVES));

    // A credential can also sit in the configured backend URL (`http://user:secret@host:4097`, a proxy in front of
    // the backend). That value is printed in the startup summary and returned by `/health`, which needs no key, so it
    // published the secret to every caller and to `docker logs` - while the scheme, host and path, the parts an
    // operator reads those two places for, stayed useful.
    const backendUrlCases = [
        ['http://127.0.0.1:4097', 'http://127.0.0.1:4097'],
        ['http://user:secret@10.0.0.5:4097', 'http://***@10.0.0.5:4097'],
        ['https://user:p%40ss@backend.internal/proxy', 'https://***@backend.internal/proxy'],
        ['http://10.0.0.5:4097/v1?token=abc&model=x', 'http://10.0.0.5:4097/v1?token=***&model=x'],
        ['http://user:secret@10.0.0.5:4097/v1?api_key=k', 'http://***@10.0.0.5:4097/v1?api_key=***'],
        ['10.0.0.5:4097', '10.0.0.5:4097'],
        ['', '']
    ];
    const backendUrlResults = backendUrlCases.map(([input, expected]) => [input, maskBackendUrl(input), expected]);
    check('a credential in the backend URL is masked', backendUrlResults.every(([, actual, expected]) => actual === expected),
        JSON.stringify(backendUrlResults.filter(([, actual, expected]) => actual !== expected)));
    check('a credential-free backend URL is left exactly as configured',
        maskBackendUrl('http://127.0.0.1:4097/proxy?model=x') === 'http://127.0.0.1:4097/proxy?model=x',
        maskBackendUrl('http://127.0.0.1:4097/proxy?model=x'));

    // Header masking used to be a name denylist, so a credential forwarded under any other name was logged raw
    const forwardedHeaders = {
        authorization: 'Bearer sk-dummy-1234567890',
        'x-goog-api-key': 'AIzaSySECRETSECRETSECRET',
        'x-auth-token': 'token-1234567890123456',
        'openai-api-key': 'sk-openai-1234567890123',
        authentication: 'very-secret-value-12345',
        'x-forwarded-authorization': 'Bearer forwarded-value-123',
        'content-type': 'application/json',
        'user-agent': 'curl/8.7.1'
    };
    const maskedHeaders = maskHeaders(forwardedHeaders);
    const leakedHeaders = Object.keys(forwardedHeaders)
        .filter((name) => !['content-type', 'user-agent'].includes(name))
        .filter((name) => maskedHeaders[name] === forwardedHeaders[name]);
    check('a credential forwarded under another header name is still masked', leakedHeaders.length === 0,
        `unmasked: ${leakedHeaders.join(', ')}`);
    check('masking a header leaves the request headers untouched',
        forwardedHeaders.authorization === 'Bearer sk-dummy-1234567890' &&
        maskedHeaders['content-type'] === 'application/json' && maskedHeaders['user-agent'] === 'curl/8.7.1',
        JSON.stringify(maskedHeaders));
    check('a short key reveals nothing but its length',
        maskSecret('sk-dummy-123') === '***(12 chars)' && maskSecret('short') === '***(5 chars)',
        `${maskSecret('sk-dummy-123')} / ${maskSecret('short')}`);
    check('a long key reveals only its prefix',
        maskSecret('sk-abcdefghijklmnopqrstuvwxyz') === 'sk-a***(29 chars)', maskSecret('sk-abcdefghijklmnopqrstuvwxyz'));

    // The 32 KiB cap must be applied before the payload is cloned and stringified: a 50 MB detail used to allocate
    // roughly twice that and block the event loop for tens of milliseconds on one debug line
    const bigDetailStarted = Date.now();
    const bigDetailText = serializeDetail({ body: 'x'.repeat(50 * 1024 * 1024) });
    const bigDetailMs = Date.now() - bigDetailStarted;
    check('an oversized debug detail is truncated cheaply',
        bigDetailText.length <= 33 * 1024 && bigDetailMs < 500, `${bigDetailText.length} bytes in ${bigDetailMs} ms`);
    check('the truncation is annotated for the reader', /truncated/i.test(bigDetailText),
        bigDetailText.slice(-80));
    // A client writes both of these names: a body key and a header name are whatever the request carries, and a plain
    // `copy[key] = value` assignment runs the `__proto__` setter, which dropped the key from the dump instead of showing
    // it - the dump is what an operator reads to see what was actually sent, so losing a key there is the worst place
    // to lose one. The prototype of the copy is left alone either way.
    const protoBody = JSON.parse('{"messages":[],"__proto__":{"injected":true}}');
    const protoHeaders = JSON.parse('{"__proto__":"header-value","authorization":"Bearer sk-proto-1234567890"}');
    const protoDetail = serializeDetail(protoBody);
    const protoMasked = maskHeaders(protoHeaders);
    check('a __proto__ key survives into the debug detail instead of vanishing',
        protoDetail.includes('"__proto__"') && protoDetail.includes('injected') && ({}).injected === undefined,
        protoDetail);
    check('a __proto__ header name survives the masked header dump',
        Object.keys(protoMasked).includes('__proto__') && protoMasked.authorization === 'Bear***(26 chars)' &&
        ({}).injected === undefined,
        Object.keys(protoMasked).join(','));

    // The logger writes to the process's own streams, so the level filter, the prefix and the stamp are observed
    // through a child process. A detail that cannot be serialised (a cycle, a BigInt, a function) and a non-string
    // message must never throw out of a logging call.
    const loggerProbe = await new Promise((resolve) => {
        const loggerScript = `
            import { createLogger } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'logger.js')).href)};
            const log = createLogger({ level: 'warn' });
            log.debug('debug-line');
            log.info('info-line');
            log.warn('warn-line', { status: 500 });
            log.error('error-line', new Error('boom'));
            const circular = { name: 'circular' };
            circular.self = circular;
            log.warn('hostile-line', { circular, big: 10n, fn: () => 1 });
            log.warn(Symbol('symbol-message'));
        `;
        const child = spawn(process.execPath, ['--input-type=module', '-e', loggerScript], { cwd: ROOT });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    check('the configured level filters the quieter lines',
        loggerProbe.code === 0 && loggerProbe.stdout === '' && /warn-line/.test(loggerProbe.stderr) &&
        /error-line/.test(loggerProbe.stderr) && !/info-line|debug-line/.test(loggerProbe.stdout + loggerProbe.stderr),
        `stdout ${JSON.stringify(loggerProbe.stdout.slice(0, 120))} stderr ${JSON.stringify(loggerProbe.stderr.slice(0, 160))}`);
    const loggerLines = loggerProbe.stderr.split('\n').filter(Boolean);
    check('every line carries the [gateway] prefix and a millisecond stamp',
        loggerLines.length >= 4 && loggerLines.every((line) =>
            /^\[gateway\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[(WARN|ERROR|INFO|DEBUG)\] /.test(line)),
        JSON.stringify(loggerLines.slice(0, 2)));
    check('a hostile detail is rendered instead of thrown',
        loggerProbe.code === 0 && /\[Circular\]/.test(loggerProbe.stderr) && /"10n"|10n/.test(loggerProbe.stderr),
        JSON.stringify(loggerProbe.stderr.split('\n').find((line) => line.includes('hostile-line')) || '').slice(0, 200));
    check('a non-string message is logged instead of crashing the caller',
        loggerProbe.code === 0 && /Symbol\(symbol-message\)/.test(loggerProbe.stderr),
        JSON.stringify(loggerProbe.stderr.split('\n').pop() || '').slice(0, 160));

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

        // A UTF-8 BOM is what a Windows editor or PowerShell 5.1 writes, and JSON.parse rejects the first character of
        // an otherwise valid file: the gateway refused to start over an invisible character
        const bomPath = path.join(configDir, 'bom.json');
        fs.writeFileSync(bomPath, `\uFEFF${JSON.stringify({ API_KEY: 'sk-bom' })}`);
        const bom = readConfigFile(bomPath);
        check('readConfigFile accepts a UTF-8 BOM', bom.error === null && bom.config.API_KEY === 'sk-bom', String(bom.error));

        // A known key with the wrong type is refused rather than coerced: `resolveApiKey()` on a boolean `true` makes
        // the literal string "true" the gateway's credential - guessable by every client - while the startup summary
        // still claims a custom key is in force
        const boolKeyPath = path.join(configDir, 'bool-key.json');
        fs.writeFileSync(boolKeyPath, JSON.stringify({ API_KEY: true }));
        const boolKey = readConfigFile(boolKeyPath);
        check('readConfigFile refuses a non-string API_KEY', Boolean(boolKey.error) && /API_KEY/.test(boolKey.error),
            String(boolKey.error));
        const objectKeyPath = path.join(configDir, 'object-key.json');
        fs.writeFileSync(objectKeyPath, JSON.stringify({ LOG_LEVEL: { level: 'debug' } }));
        check('readConfigFile refuses an object value for a known key',
            /LOG_LEVEL/.test(String(readConfigFile(objectKeyPath).error)), String(readConfigFile(objectKeyPath).error));
        const flagKeyPath = path.join(configDir, 'flag-key.json');
        fs.writeFileSync(flagKeyPath, JSON.stringify({ DISABLE_TOOLS: 'yes', USE_ISOLATED_HOME: false }));
        check('readConfigFile accepts the documented flag values',
            readConfigFile(flagKeyPath).error === null, String(readConfigFile(flagKeyPath).error));
        const unknownKeyPath = path.join(configDir, 'unknown-key.json');
        fs.writeFileSync(unknownKeyPath, JSON.stringify({ FUTURE_KEY: { nested: true } }));
        check('readConfigFile keeps keys it does not know',
            readConfigFile(unknownKeyPath).config.FUTURE_KEY?.nested === true, 'unknown keys are dropped');

        // A directory at the config path used to surface as a bare EISDIR, and a FIFO blocked the read forever
        const dirPath = path.join(configDir, 'as-directory');
        fs.mkdirSync(dirPath);
        check('readConfigFile refuses a directory', /regular file/.test(String(readConfigFile(dirPath).error)),
            String(readConfigFile(dirPath).error));
        if (process.platform !== 'win32') {
            const fifoPath = path.join(configDir, 'as-fifo');
            execFileSync('mkfifo', [fifoPath]);
            const fifoStarted = Date.now();
            const fifo = readConfigFile(fifoPath);
            check('readConfigFile refuses a FIFO instead of blocking',
                /regular file/.test(String(fifo.error)) && Date.now() - fifoStarted < 1000,
                `${Date.now() - fifoStarted} ms, ${String(fifo.error)}`);
        }
        const hugePath = path.join(configDir, 'huge.json');
        fs.writeFileSync(hugePath, `{"PAD":"${'x'.repeat(1024 * 1024)}"}`);
        check('readConfigFile refuses a file over the size cap', /maximum is/.test(String(readConfigFile(hugePath).error)),
            String(readConfigFile(hugePath).error));
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

    // The auth scheme is case-insensitive (RFC 7235) and whitespace-padded values are common; none of that is a
    // reason to reject a correct key, and none of it may accept a wrong one
    const authVariants = [
        ['bearer ' + API_KEY, 200, 'lowercase scheme'],
        ['BEARER ' + API_KEY, 200, 'uppercase scheme'],
        ['Bearer   ' + API_KEY, 200, 'extra whitespace'],
        ['Bearer ' + API_KEY + ' ', 200, 'trailing whitespace'],
        [API_KEY, 401, 'token without a scheme'],
        ['Bearer ' + API_KEY + '4', 401, 'wrong token']
    ];
    const variantStatuses = [];
    for (const [value, expected, label] of authVariants) {
        const attempt = await fetch(`${BASE}/v1/models`, { headers: { authorization: value } });
        variantStatuses.push([label, attempt.status, expected]);
    }
    check('the bearer scheme is read case-insensitively and tolerates whitespace',
        variantStatuses.every(([, actual, expected]) => actual === expected), JSON.stringify(variantStatuses));

    // `X-Api-Key` is advertised in Access-Control-Allow-Headers, so it has to be accepted as an alias; an
    // Authorization header that is present still wins, so a wrong one cannot be rescued by the alias
    const viaHeader = await fetch(`${BASE}/v1/models`, { headers: { 'x-api-key': API_KEY } });
    check('X-Api-Key is accepted as an alias for the bearer token', viaHeader.status === 200, `status ${viaHeader.status}`);
    const viaHeaderWrong = await fetch(`${BASE}/v1/models`, { headers: { 'x-api-key': 'sk-wrong' } });
    check('a wrong X-Api-Key is rejected', viaHeaderWrong.status === 401, `status ${viaHeaderWrong.status}`);
    const bothHeaders = await fetch(`${BASE}/v1/models`, {
        headers: { authorization: 'Bearer sk-wrong', 'x-api-key': API_KEY }
    });
    check('a wrong Authorization header is not rescued by a correct X-Api-Key',
        bothHeaders.status === 401, `status ${bothHeaders.status}`);
    // Presence decides, not the parsed token: a proxy that injects `Authorization: Basic ...` (or a client that sends a
    // bare `Bearer`) presented an Authorization header, and the alias used to rescue it because the token was empty
    const otherScheme = await fetch(`${BASE}/v1/models`, {
        headers: { authorization: 'Basic dXNlcjpwYXNz', 'x-api-key': API_KEY }
    });
    check('a non-Bearer Authorization header is not rescued by a correct X-Api-Key',
        otherScheme.status === 401, `status ${otherScheme.status}`);
    const bareBearer = await fetch(`${BASE}/v1/models`, {
        headers: { authorization: 'Bearer', 'x-api-key': API_KEY }
    });
    check('a bare Bearer scheme is not rescued by a correct X-Api-Key',
        bareBearer.status === 401, `status ${bareBearer.status}`);

    // --- preflight --------------------------------------------------------------------------------------
    const preflight = await fetch(`${BASE}/v1/chat/completions`, { method: 'OPTIONS' });
    check('OPTIONS preflight returns 204', preflight.status === 204, `status ${preflight.status}`);
    check('CORS headers are present on preflight', preflight.headers.get('access-control-allow-origin') === '*');
    // The allow-list has to advertise every header the gateway reads and every one a client may send: `X-Request-Id`
    // is echoed as the trace id (log line + response header, asserted below), so a browser client that sets its own
    // uploaded a preflight the gateway never granted and the browser refused to send the request at all.
    const allowHeaders = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase();
    check('the preflight advertises every header the gateway reads, including X-Request-Id',
        ['content-type', 'authorization', 'x-api-key', 'x-request-id', 'x-requested-with']
            .every((name) => allowHeaders.split(',').map((part) => part.trim()).includes(name)),
        allowHeaders);

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

    // The static model is the id a request without `model` is sent to, so it answers with its own name rather than the
    // id-derived `big-pickle` even though the stub backend lists only kimi and gpt-5-mini.
    const defaultModel = await request('/v1/models/opencode%2Fbig-pickle');
    check('the default model is described by id when the backend lists other models',
        defaultModel.response.status === 200 && defaultModel.json?.id === 'opencode/big-pickle' &&
        defaultModel.json?.name === 'Big Pickle' && defaultModel.json?.owned_by === 'opencode',
        defaultModel.text.slice(0, 160));

    // A doubled slash is read as a trailing slash, so `/v1/models//` reaches the by-id route with an empty id.
    // Describing "" answered 200 with {"id":"","name":""} - not a model at all - so it is a missing route instead.
    const blankList = await fetch(`${BASE}/v1/models//`, { headers: { authorization: `Bearer ${API_KEY}` } })
        .then(async (r) => ({ status: r.status, json: await r.json() }));
    check('a blank model id is a missing route',
        blankList.status === 404 && blankList.json?.error?.type === 'not_found',
        `status ${blankList.status} ${JSON.stringify(blankList.json)?.slice(0, 120)}`);
    const blankEncoded = await fetch(`${BASE}/v1/models/%20`, { headers: { authorization: `Bearer ${API_KEY}` } })
        .then(async (r) => ({ status: r.status, json: await r.json() }));
    check('a whitespace model id is a missing route',
        blankEncoded.status === 404 && blankEncoded.json?.error?.type === 'not_found',
        `status ${blankEncoded.status} ${JSON.stringify(blankEncoded.json)?.slice(0, 120)}`);
    // An id whose last segment is empty addresses no model either: `/v1/models/%2F` is "/" and
    // `/v1/models/opencode%2F` is "opencode/", both described as a model with an empty name
    const separatorOnly = await fetch(`${BASE}/v1/models/%2F`, { headers: { authorization: `Bearer ${API_KEY}` } })
        .then(async (r) => ({ status: r.status, json: await r.json() }));
    check('a separator-only model id is a missing route',
        separatorOnly.status === 404 && separatorOnly.json?.error?.type === 'not_found',
        `status ${separatorOnly.status} ${JSON.stringify(separatorOnly.json)?.slice(0, 120)}`);
    const emptyName = await fetch(`${BASE}/v1/models/opencode%2F`, { headers: { authorization: `Bearer ${API_KEY}` } })
        .then(async (r) => ({ status: r.status, json: await r.json() }));
    check('a model id with an empty trailing segment is a missing route',
        emptyName.status === 404 && emptyName.json?.error?.type === 'not_found',
        `status ${emptyName.status} ${JSON.stringify(emptyName.json)?.slice(0, 120)}`);
    const trailingSlash = await request('/v1/models/');
    check('the trailing-slash listing still answers', trailingSlash.response.status === 200 &&
        trailingSlash.json?.object === 'list', trailingSlash.text.slice(0, 120));

    // A URL the router cannot decode (a percent escape that is not valid UTF-8) never reaches a hook, so Fastify's own
    // handler answered `{"error":"Bad Request","code":"FST_ERR_BAD_URL",…}`: no `type`, no CORS headers, no request
    // id. Every rejected request keeps the same envelope, whichever layer rejects it.
    const badUrl = await fetch(`${BASE}/v1/models/%E0%A4%A`, { headers: { authorization: `Bearer ${API_KEY}` } })
        .then(async (r) => ({ status: r.status, headers: r.headers, json: await r.json().catch(() => null) }));
    check('an undecodable URL keeps the OpenAI error envelope',
        badUrl.status === 400 && badUrl.json?.error?.type === 'invalid_request_error' &&
        badUrl.json?.error?.code === 'FST_ERR_BAD_URL' && typeof badUrl.json?.error?.message === 'string',
        `status ${badUrl.status} ${JSON.stringify(badUrl.json)?.slice(0, 120)}`);
    check('an undecodable URL still carries CORS headers and a request id',
        badUrl.headers.get('access-control-allow-origin') === '*' &&
        /^gw-[a-z0-9]+$/.test(badUrl.headers.get('x-request-id') || ''),
        `${badUrl.headers.get('access-control-allow-origin')} ${badUrl.headers.get('x-request-id')}`);

    // --- validation -------------------------------------------------------------------------------------
    const invalid = await request('/v1/chat/completions', { method: 'POST', body: {} });
    check('missing messages array returns 400', invalid.response.status === 400, `status ${invalid.response.status}`);
    check('400 uses the OpenAI error envelope', typeof invalid.json?.error?.message === 'string', invalid.text.slice(0, 120));
    check('400 carries the invalid_request_error type', invalid.json?.error?.type === 'invalid_request_error',
        invalid.text.slice(0, 120));
    // Three different client mistakes, three different messages: "messages array is required" for a body that sent the
    // field is a wrong diagnosis, and the reader goes looking for a missing key.
    const notAnArray = await request('/v1/chat/completions', { method: 'POST', body: { messages: 'hi' } });
    check('a messages field that is not an array is named by the type it arrived as',
        notAnArray.response.status === 400 &&
        /messages must be an array of message objects, found a string/.test(notAnArray.json?.error?.message || ''),
        notAnArray.text.slice(0, 120));
    const emptyMessages = await request('/v1/chat/completions', { method: 'POST', body: { messages: [] } });
    check('an empty messages array is reported as empty, not as missing',
        emptyMessages.response.status === 400 && emptyMessages.json?.error?.message === 'messages must contain at least one message',
        emptyMessages.text.slice(0, 120));
    check('a body with no messages at all still says the array is required',
        /messages array is required/.test(invalid.json?.error?.message || ''), invalid.text.slice(0, 120));

    // A model id whose provider or model half is empty is not a model: `/v1/models` answers 404 for the same ids, and
    // sending one to the backend only produced an upstream error the client could not act on
    for (const badModel of ['opencode/', '/big-pickle']) {
        const badModelResponse = await request('/v1/chat/completions', {
            method: 'POST',
            body: { model: badModel, messages: [{ role: 'user', content: 'hi' }] }
        });
        check(`a model id with an empty half is rejected: ${badModel}`,
            badModelResponse.response.status === 400 &&
            badModelResponse.json?.error?.type === 'invalid_request_error' &&
            String(badModelResponse.json?.error?.message).includes(badModel),
            `status ${badModelResponse.response.status} ${badModelResponse.text.slice(0, 120)}`);
    }

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

    // Fastify refuses a body carrying `__proto__`/`constructor` through its prototype-poisoning guard, and it reports
    // that the same way it reports a syntax error - so a body that parses perfectly was answered "Body is not valid
    // JSON", which sends the reader looking for a missing comma. Both causes are named instead.
    const protoPoisoned = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: '{"messages":[{"role":"user","content":"hi"}],"__proto__":{"injected":true}}'
    });
    const protoPoisonedPayload = await protoPoisoned.json().catch(() => null);
    check('a body with a forbidden property name is refused in the usual envelope',
        protoPoisoned.status === 400 && protoPoisonedPayload?.error?.code === 'FST_ERR_CTP_INVALID_JSON_BODY' &&
        /forbidden property name/.test(String(protoPoisonedPayload?.error?.message)),
        `${protoPoisoned.status} ${JSON.stringify(protoPoisonedPayload).slice(0, 160)}`);
    check('the refusal names both causes instead of blaming valid JSON',
        /not valid JSON/.test(String(badJsonPayload?.error?.message)) &&
        /forbidden property name/.test(String(badJsonPayload?.error?.message)),
        JSON.stringify(badJsonPayload?.error?.message));

    const nullBody = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: 'null'
    });
    const nullBodyJson = await nullBody.json().catch(() => null);
    check('a JSON null body returns 400', nullBody.status === 400, `status ${nullBody.status}`);
    check('400 for a null body keeps the envelope', typeof nullBodyJson?.error?.message === 'string', JSON.stringify(nullBodyJson));

    // `curl -d '{...}'` without the header (or a client that sends text/plain) hands the gateway an unparsed string
    // body. Rejecting it with "messages array is required" blames the body for a header problem, though the body is
    // valid; the gateway parses it instead.
    const textPlain = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'text/plain' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false })
    });
    const textPlainJson = await textPlain.json().catch(() => null);
    check('a JSON body sent as text/plain is still served',
        textPlain.status === 200 && textPlainJson?.choices?.[0]?.message?.content === ANSWER,
        `status ${textPlain.status} ${JSON.stringify(textPlainJson).slice(0, 120)}`);
    const textPlainBad = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'text/plain' },
        body: 'not json at all'
    });
    const textPlainBadJson = await textPlainBad.json().catch(() => null);
    check('an unparsable text/plain body names the real problem',
        textPlainBad.status === 400 && /Content-Type: application\/json/.test(textPlainBadJson?.error?.message || ''),
        `${textPlainBad.status} ${JSON.stringify(textPlainBadJson).slice(0, 160)}`);

    // `curl -d '{...}'` without `-H 'content-type: application/json'` sends the body as
    // `application/x-www-form-urlencoded`, which Fastify answers with a bare 415: the documented "the content-type
    // header is optional" path failed for the most common hand-written client. The form type is handed to the handler
    // as the same unparsed string instead.
    const formBody = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false })
    });
    const formJson = await formBody.json().catch(() => null);
    check('a JSON body sent as a form body (curl -d without the header) is still served',
        formBody.status === 200 && formJson?.choices?.[0]?.message?.content === ANSWER,
        `status ${formBody.status} ${JSON.stringify(formJson).slice(0, 120)}`);
    const formBad = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'not json at all'
    });
    const formBadJson = await formBad.json().catch(() => null);
    check('an unparsable form body keeps the 400 envelope',
        formBad.status === 400 && formBadJson?.error?.type === 'invalid_request_error',
        `${formBad.status} ${JSON.stringify(formBadJson).slice(0, 160)}`);
    const xmlBody = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/xml' },
        body: '<a/>'
    });
    const xmlJson = await xmlBody.json().catch(() => null);
    // "Unsupported Media Type" named neither the type that arrived nor what to send, so the client had nothing to act
    // on: the 415 keeps its status and Fastify's code, and the message names both.
    check('an unrelated content type names the type it refused',
        xmlBody.status === 415 && xmlJson?.error?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' &&
        /application\/xml/.test(String(xmlJson?.error?.message)) &&
        /Content-Type: application\/json/.test(String(xmlJson?.error?.message)),
        `${xmlBody.status} ${JSON.stringify(xmlJson).slice(0, 160)}`);
    // A body with no Content-Type header at all is the likeliest hand-written mistake, and it took the same message
    // path - so the answer named neither the missing header nor the fix. `fetch` always labels a string body
    // (`text/plain;charset=UTF-8`), so the header-free request is written on a socket by hand.
    const rawNoTypeReply = await new Promise((resolve) => {
        let data = '';
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve(data);
        };
        const payload = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
        const socket = net.connect(GATEWAY_PORT, '127.0.0.1', () => {
            socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\n'
                + `Authorization: Bearer ${API_KEY}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`
                + `Connection: close\r\n\r\n${payload}`);
        });
        socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
        socket.on('close', done);
        socket.on('error', done);
        setTimeout(() => {
            socket.destroy();
            done();
        }, 4000);
    });
    const rawNoTypeBody = rawNoTypeReply.slice((rawNoTypeReply.split('\r\n\r\n')[0] || '').length + 4);
    let rawNoTypeJson = null;
    try {
        rawNoTypeJson = JSON.parse(rawNoTypeBody);
    } catch {
        rawNoTypeJson = null;
    }
    check('a body sent without a Content-Type header is told to send one',
        /^HTTP\/1\.1 415/.test(rawNoTypeReply) &&
        /no Content-Type header/.test(String(rawNoTypeJson?.error?.message)) &&
        /Content-Type: application\/json/.test(String(rawNoTypeJson?.error?.message)),
        `${rawNoTypeReply.split('\r\n')[0]} ${JSON.stringify(rawNoTypeJson).slice(0, 160)}`);
    // The gateway does not decompress request bodies, so a gzipped one used to reach the JSON parser and be reported
    // as "body is not valid JSON" - blaming the payload for an unsupported encoding.
    const gzipped = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
            'content-encoding': 'gzip'
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    const gzippedJson = await gzipped.json().catch(() => null);
    check('a Content-Encoding the gateway cannot read is named in the 415',
        gzipped.status === 415 && /Content-Encoding: gzip/.test(gzippedJson?.error?.message || ''),
        `${gzipped.status} ${JSON.stringify(gzippedJson).slice(0, 160)}`);

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
    // Clients that drive a chat state machine create the message from `delta.role`; OpenAI sends it in the first frame
    const withRole = chunks.filter((chunk) => chunk?.choices?.[0]?.delta?.role !== undefined);
    check('the first delta frame names the assistant role',
        withRole.length === 1 && withRole[0] === chunks[0] && withRole[0].choices[0].delta.role === 'assistant',
        JSON.stringify(withRole.map((chunk) => chunk.choices[0].delta)));
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
    // The request above omits `model`, so this frame is the first place the default model id shows up: compare it with
    // the sibling chunks of the same stream instead of a literal, which the later default model would break.
    const streamModel = usageChunks.find((chunk) => !chunk?.usage)?.model;
    check('the usage chunk carries the same envelope as the other chunks',
        usageChunk?.object === 'chat.completion.chunk' && typeof streamModel === 'string' &&
        usageChunk?.model === streamModel &&
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

    // --- a finished message in the prompt response is used as-is -----------------------------------------
    // The backend answers POST /session/:id/message with the message it produced, so a finished one is the answer and
    // the follow-up GET is pure overhead. The stub stores nothing for this marker: answering 200 at all proves the
    // prompt response was used, and the poll counter proves no round trip was spent on it.
    const pollsBeforeFastPath = (await fetch(`${STUB_URL}/__sessions`).then((r) => r.json())).messagePolls;
    const fastPath = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'PROMPTDONE' }], stream: false }
    });
    const pollsAfterFastPath = (await fetch(`${STUB_URL}/__sessions`).then((r) => r.json())).messagePolls;
    check('a finished message in the prompt response answers without polling',
        fastPath.response.status === 200 && fastPath.json?.choices?.[0]?.message?.content === ANSWER,
        `status ${fastPath.response.status} ${JSON.stringify(fastPath.json?.choices?.[0]?.message?.content)}`);
    check('the fast path spends no message poll',
        pollsAfterFastPath === pollsBeforeFastPath,
        `message polls ${pollsBeforeFastPath} -> ${pollsAfterFastPath}`);

    // --- the newer `developer` role is an instruction, not a chat turn -----------------------------------
    // OpenAI renamed the system role to `developer`; a client that sends it means the instructions. Prefixing it with
    // "DEVELOPER: …" and pushing it into the conversation changed how a model reads it.
    const developerRole = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'developer', content: 'answer in one word' }, { role: 'user', content: 'hi' }] }
    });
    const developerStats = await fetch(`${STUB_URL}/__sessions`).then((r) => r.json()).catch(() => null);
    check('a developer message reaches the backend as its system prompt',
        developerRole.response.status === 200 && /answer in one word/.test(String(developerStats?.lastSystemPrompt)),
        `status ${developerRole.response.status} system ${JSON.stringify(developerStats?.lastSystemPrompt)}`);
    check('a developer message is not turned into a conversation part',
        !/DEVELOPER/i.test(String(developerStats?.lastSystemPrompt)) && developerRole.response.status === 200,
        JSON.stringify(developerStats?.lastSystemPrompt));

    // --- a rejected prompt is an upstream failure ---------------------------------------------------------
    // The SDK resolves with { error, response } on a non-2xx answer instead of throwing, so a rejected prompt used to
    // look like a slow answer: no message ever existed and the request burned its whole budget to answer 504.
    const promptRejectedAt = Date.now();
    const promptRejected = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'REJECTPROMPT' }], stream: false }
    });
    const promptRejectedMs = Date.now() - promptRejectedAt;
    check('a rejected prompt answers 502, not a timeout',
        promptRejected.response.status === 502, `status ${promptRejected.response.status}`);
    check('the rejected prompt reports the upstream status and reason',
        typeof promptRejected.json?.error?.message === 'string' &&
        promptRejected.json.error.message.includes('status 500') &&
        promptRejected.json.error.message.includes('provider refused the prompt'),
        String(promptRejected.json?.error?.message));
    check('a rejected prompt fails fast instead of waiting for the budget', promptRejectedMs < 5000,
        `${promptRejectedMs} ms`);
    const promptRejectedStream = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'REJECTPROMPT' }], stream: true },
        stream: true
    });
    check('a rejected prompt in streaming mode answers the same 502',
        promptRejectedStream.response.status === 502, `status ${promptRejectedStream.response.status}`);
    const afterRejection = await sessionsAfterCleanup(STUB_URL);
    check('a rejected prompt still deletes its session',
        afterRejection && afterRejection.live === 0, JSON.stringify(afterRejection));

    // --- a provider failure in non-streaming mode ---------------------------------------------------------
    const failed = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'FAIL' }], stream: false }
    });
    check('a non-streaming provider error answers 502', failed.response.status === 502, `status ${failed.response.status}`);
    check('a 502 carries the server_error envelope with the provider error code',
        failed.json?.error?.type === 'server_error' && failed.json?.error?.code === 'ProviderError',
        failed.text.slice(0, 160));
    const afterFailure = await sessionsAfterCleanup(STUB_URL);
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
    const stubStats = await sessionsAfterCleanup(STUB_URL);
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
            // info (not warn): the startup summary is what this gateway is started for below
            LOG_LEVEL: 'info'
        }
    });
    children.push(slashGateway);
    let slashOutput = '';
    slashGateway.stdout.on('data', (chunk) => { slashOutput += chunk; });
    slashGateway.stderr.on('data', (chunk) => { slashOutput += chunk; });
    await waitForOk(`${slashUrl}/health`);
    // The summary is where an operator copies the backend value from, so it must show the value the gateway uses and
    // not the raw one: it printed `http://host:port/` while a note two lines later said the slash was stripped, and a
    // trailing space was printed verbatim. The correction now comes first, and the summary contradicts nothing.
    const slashSummaryIndex = slashOutput.indexOf(`  - Backend: ${STUB_URL}`);
    const slashNoteIndex = slashOutput.indexOf('OPENCODE_SERVER_URL had a trailing slash');
    check('the startup summary prints the normalised backend URL, below its correction',
        slashSummaryIndex !== -1 && slashNoteIndex !== -1 && slashNoteIndex < slashSummaryIndex,
        JSON.stringify(slashOutput.split('\n').filter((line) => /Backend:|trailing slash/.test(line))).slice(0, 240));
    check('the startup summary never prints a backend URL with a trailing slash',
        !/  - Backend: \S*\/\s*$/m.test(slashOutput),
        JSON.stringify(slashOutput.split('\n').find((line) => line.includes('  - Backend:')) || '').slice(0, 160));
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

    // --- an unusable boolean value -------------------------------------------------------------------------
    // The numeric tuning keys already name a value they could not use; the flags fell back to the default in silence,
    // so `DISABLE_TOOLS: "maybe"` (a typo, or a service file written by hand) left the tool-call markup in the answer
    // while the operator believed it was filtered out.
    // An offset nothing else uses: +8 is the port the spawned-backend gateway listens on, and two gateways racing
    // for one port turn every assertion below into a confusing failure
    const flagPort = GATEWAY_PORT + 40;
    const flagUrl = `http://127.0.0.1:${flagPort}`;
    const flagGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(flagPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            LOG_LEVEL: 'warn',
            DISABLE_TOOLS: 'maybe'
        }
    });
    children.push(flagGateway);
    let flagOutput = '';
    flagGateway.stdout.on('data', (chunk) => { flagOutput += chunk; });
    flagGateway.stderr.on('data', (chunk) => { flagOutput += chunk; });
    await waitForOk(`${flagUrl}/health`);
    check('a boolean flag that cannot be read is named with the value it used',
        /\[Config\] DISABLE_TOOLS='maybe' is not a boolean .*using false/.test(flagOutput),
        JSON.stringify(flagOutput.slice(0, 240)));
    // index.js resolves the flag and startProxy() takes that resolved value as given, so the same typo must not be
    // reported twice: two lines for one value read like two different settings.
    check('the flag warning is written once, not by both layers',
        flagOutput.split('\n').filter((line) => line.includes('DISABLE_TOOLS=')).length === 1,
        JSON.stringify(flagOutput.split('\n').filter((line) => line.includes('DISABLE_TOOLS='))));
    // A module embedder calls startProxy() directly, with no entry point to resolve the option first: the environment
    // fallback has to report the value too, or the tool guard is off with nothing in the log about it.
    const embedDriver = [
        `import { startProxy } from ${JSON.stringify(path.join(ROOT, 'src', 'proxy.js'))};`,
        `process.env.DISABLE_TOOLS = 'definitely';`,
        `await startProxy({ PORT: 0, BIND_HOST: '127.0.0.1', OPENCODE_SERVER_URL: ${JSON.stringify(STUB_URL)}, API_KEY: 'sk-embedded' });`,
        `process.exit(0);`
    ].join('\n');
    const embedOutput = await new Promise((resolve) => {
        const embedChild = spawn(process.execPath, ['--input-type=module', '-e', embedDriver], {
            cwd: ROOT,
            env: { ...process.env, LOG_LEVEL: 'warn' }
        });
        let output = '';
        embedChild.stdout.on('data', (chunk) => { output += chunk; });
        embedChild.stderr.on('data', (chunk) => { output += chunk; });
        embedChild.on('exit', () => resolve(output));
    });
    check('a direct startProxy() caller is told about an unusable flag too',
        /\[Config\] DISABLE_TOOLS='definitely' is not a boolean .*using false/.test(embedOutput),
        JSON.stringify(embedOutput.slice(0, 240)));

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
    }).then(async (response) => ({
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        json: await response.json().catch(() => null)
    }));
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
    // The refusal is read by a human as often as by an SDK: with the queue configured to hold nothing, "0 completions
    // are already waiting" described the setting as if it were the bug.
    check('a refused completion names the disabled queue instead of reporting "0 waiting"',
        /OPENCODE_PROXY_MAX_QUEUE=0/.test(cappedRefused.json?.error?.message || ''),
        JSON.stringify(cappedRefused.json));
    // A retryable refusal has to say how long to wait, or an OpenAI SDK gives up instead of retrying
    check('a full queue tells the client when to retry', cappedRefused.retryAfter === '1',
        `retry-after ${cappedRefused.retryAfter}`);
    const cappedHeld = await cappedHolder;
    check('the request that held the slot is still served', cappedHeld.status === 200, `status ${cappedHeld.status}`);
    const cappedHealth = await fetch(`${cappedUrl}/health`);
    check('rejected requests leave the gateway healthy', cappedHealth.status === 200, `status ${cappedHealth.status}`);
    await cappedHealth.text();

    // A client that gives up on a non-streaming completion used to keep its slot until the backend finished: at the
    // default concurrency of 1 that blocks every other request for an answer nobody will read.
    const abandonedPort = GATEWAY_PORT + 20;
    const abandonedGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(abandonedPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            OPENCODE_PROXY_MAX_CONCURRENCY: '1',
            OPENCODE_PROXY_MAX_QUEUE: '0',
            REQUEST_TIMEOUT_MS: '20000',
            LOG_LEVEL: 'error'
        }
    });
    children.push(abandonedGateway);
    const abandonedUrl = `http://127.0.0.1:${abandonedPort}`;
    await waitForOk(`${abandonedUrl}/health`);
    const abandonedCompletion = (content) => fetch(`${abandonedUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content }] })
    }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));

    // A raw request that is destroyed mid-flight is a client that closed the tab: the stub still needs ~2 s for the
    // SLOW answer, which is longer than this check waits
    const abandonedRequest = new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1',
            port: abandonedPort,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }
        }, (response) => {
            response.resume();
            resolve(response.statusCode);
        });
        req.on('error', () => resolve('disconnected'));
        req.end(JSON.stringify({ messages: [{ role: 'user', content: 'SLOWFINISH abandoned' }] }));
        setTimeout(() => req.destroy(), 300);
    });
    check('a non-streaming client can disconnect mid-request', (await abandonedRequest) === 'disconnected',
        'the request was not interrupted');
    // The abandoned completion is still running in the backend; its slot must already be free again
    await sleep(700);
    const afterAbandon = await abandonedCompletion('hi');
    check('a disconnected non-streaming client frees its slot at once', afterAbandon.status === 200,
        `status ${afterAbandon.status} ${JSON.stringify(afterAbandon.json)}`);
    stopGateway(abandonedGateway);
    await waitForExit(abandonedGateway);

    // --- concurrent completions get distinct ids -----------------------------------------------------------
    // The id was `chatcmpl-<epoch>`, so two answers that finished in the same millisecond carried the very same id and
    // a client that keys its messages by id merged them. Twenty parallel completions land inside a couple of
    // milliseconds, which is what makes the collision reproducible.
    const idPort = GATEWAY_PORT + 21;
    const idGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(idPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            OPENCODE_PROXY_MAX_CONCURRENCY: '20',
            OPENCODE_PROXY_MAX_QUEUE: '64',
            LOG_LEVEL: 'error'
        }
    });
    children.push(idGateway);
    const idUrl = `http://127.0.0.1:${idPort}`;
    await waitForOk(`${idUrl}/health`);
    const completions = await Promise.all(Array.from({ length: 20 }, () => fetch(`${idUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    }).then((response) => response.json())));
    const ids = completions.map((body) => body?.id);
    check('parallel completions all answer', completions.every((body) => body?.object === 'chat.completion'),
        JSON.stringify(completions.filter((body) => body?.object !== 'chat.completion').slice(0, 2)));
    check('every parallel completion carries a distinct id', new Set(ids).size === ids.length,
        `${new Set(ids).size} distinct ids for ${ids.length} completions`);
    check('completion ids keep the OpenAI prefix', ids.every((id) => typeof id === 'string' && id.startsWith('chatcmpl-')),
        JSON.stringify(ids.slice(0, 3)));
    stopGateway(idGateway);
    await waitForExit(idGateway);

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

    // --- the accepted body size is configurable -----------------------------------------------------------
    // Every waiting completion pins its parsed body, so the memory a burst can hold is the body limit times the queue
    // length: the 50 MiB and 64-entry defaults allow 3.2 GiB. A gateway facing clients it does not trust lowers it, and
    // a limit that is configured but not applied is worse than none.
    stopGateway(limitGateway);
    await waitForExit(limitGateway);
    const bodyPort = GATEWAY_PORT + 7;
    const bodyUrl = `http://127.0.0.1:${bodyPort}`;
    const bodyGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(bodyPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            LOG_LEVEL: 'warn',
            OPENCODE_PROXY_MAX_BODY_MB: '1'
        }
    });
    children.push(bodyGateway);
    bodyGateway.stdout.on('data', () => {});
    bodyGateway.stderr.on('data', () => {});
    await waitForOk(`${bodyUrl}/health`);
    const oversized = await fetch(`${bodyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] })
    });
    const oversizedJson = await oversized.json().catch(() => null);
    check('a body over the configured limit answers 413', oversized.status === 413, `status ${oversized.status}`);
    check('the 413 keeps the OpenAI envelope', oversizedJson?.error?.type === 'invalid_request_error',
        JSON.stringify(oversizedJson)?.slice(0, 160));
    const withinLimit = await fetch(`${bodyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    check('a body under the configured limit is served', withinLimit.status === 200, `status ${withinLimit.status}`);

    // The refusal is decided while the client is still uploading. Node ends the socket when a response finishes with
    // the request body unread, and the kernel resets whatever the client is still writing: CI on Node 24 lost the 413
    // here and the suite aborted with "fetch failed". `fetch` cannot express "still uploading", so this uploads over a
    // raw socket and keeps writing until the answer arrives.
    const oversizedUpload = await new Promise((resolve) => {
        const total = 3 * 1024 * 1024;
        const head = '{"messages":[{"role":"user","content":"';
        const tail = '"}]}';
        const declared = Buffer.byteLength(head) + total + Buffer.byteLength(tail);
        const socket = net.connect(bodyPort, '127.0.0.1');
        let answer = '';
        let writeError = null;
        socket.on('error', (error) => { writeError = error.code || error.message; });
        socket.on('data', (chunk) => { answer += chunk.toString('latin1'); });
        socket.on('close', () => resolve({ answer, writeError }));
        socket.on('connect', async () => {
            socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n'
                + `Authorization: Bearer ${API_KEY}\r\nContent-Type: application/json\r\n`
                + `Content-Length: ${declared}\r\n\r\n` + head);
            let sent = 0;
            while (sent < total) {
                const piece = 'x'.repeat(Math.min(65536, total - sent));
                if (!socket.write(piece)) {
                    await new Promise((next) => { socket.once('drain', next); setTimeout(next, 20); });
                }
                sent += piece.length;
                await new Promise((next) => setTimeout(next, 2));
            }
            socket.end(tail);
        });
    });
    check('an oversized body that is still uploading still gets its 413',
        /^HTTP\/1\.1 413/.test(oversizedUpload.answer) && oversizedUpload.writeError === null,
        `${oversizedUpload.answer.split('\r\n')[0] || 'no answer'}, write error ${oversizedUpload.writeError}`);

    stopGateway(bodyGateway);
    await waitForExit(bodyGateway);

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

    // --- a backend that closes its event stream in the middle of the answer -----------------------------
    // The stream ends without a finish event (a backend restart, a proxy dropping an idle SSE connection) while the
    // stored message is already the complete answer. The collector used to stay silent until the whole request budget
    // was spent and then answer an in-band error, although the finished answer had been pollable the entire time.
    // This reuses the 3 s budget of the gateway above, so a regression fails fast instead of hanging the suite.
    const cutStartedAt = Date.now();
    const cutResponse = await fetch(`${stallUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'CUTSTREAM please' }], stream: true })
    }).then((response) => response.text());
    const cutMs = Date.now() - cutStartedAt;
    const cutFrames = parseSseFrames(cutResponse);
    const cutChunks = cutFrames
        .filter((frame) => frame !== '[DONE]')
        .map((frame) => {
            try {
                return JSON.parse(frame);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    const cutContent = cutChunks.map((chunk) => chunk.choices?.[0]?.delta?.content || '').join('');
    const cutErrors = cutChunks.filter((chunk) => chunk.error);
    check('a stream closed mid-answer recovers through polling',
        cutContent === ANSWER && cutErrors.length === 0,
        `content ${JSON.stringify(cutContent)} errors ${JSON.stringify(cutErrors.slice(0, 1))}`);
    check('the recovered answer is neither duplicated nor truncated',
        cutContent === ANSWER && cutChunks.filter((chunk) => chunk.choices?.[0]?.finish_reason).length === 1,
        `${cutContent.length} chars, frames ${cutFrames.length}`);
    check('the recovered stream is terminated like any other',
        cutFrames[cutFrames.length - 1] === '[DONE]' &&
        cutChunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'stop'),
        JSON.stringify(cutFrames.slice(-2)));
    check('the recovery does not wait out the request budget', cutMs < 2500, `${cutMs} ms`);

    // --- a silent gap longer than the idle timeout ---------------------------------------------------------
    // The stub goes quiet for 12.5 s - longer than the 8 s idle timeout - and only then finishes writing. The gateway
    // falls back to polling on that silence, and giving up 1.5 s into it ended the stream with `finish_reason: "stop"`
    // for text that stopped mid-sentence.
    const pauseStartedAt = Date.now();
    const pauseResponse = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'PAUSE please' }], stream: true })
    }).then((response) => response.text());
    const pauseMs = Date.now() - pauseStartedAt;
    const pauseContent = parseSseFrames(pauseResponse)
        .filter((frame) => frame !== '[DONE]')
        .map((frame) => {
            try {
                return JSON.parse(frame);
            } catch {
                return null;
            }
        })
        .map((chunk) => chunk?.choices?.[0]?.delta?.content || '')
        .join('');
    check('a silent gap longer than the idle timeout still delivers the whole answer', pauseContent === ANSWER,
        `${JSON.stringify(pauseContent)} after ${pauseMs} ms`);
    check('the recovered stream still ends with [DONE]', pauseResponse.includes('data: [DONE]'),
        pauseResponse.slice(-120));
    check('the recovery waited for the answer instead of trusting the silence', pauseMs >= 12000, `${pauseMs} ms`);

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
    // `/health` needs no key, so a credential in the backend URL must not come back out of it (nor out of the
    // startup summary, which is written from the same helper). The stub is not reached by the probe, so the values
    // never have to work as a transport.
    const maskedHealthPort = GATEWAY_PORT + 33;
    const maskedHealthGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(maskedHealthPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: 'http://ops:s3cr3t-value@127.0.0.1:4199/proxy?token=abc123',
            LOG_LEVEL: 'error'
        }
    });
    children.push(maskedHealthGateway);
    let maskedHealthOut = '';
    maskedHealthGateway.stdout.on('data', (chunk) => { maskedHealthOut += chunk.toString(); });
    const maskedHealthUrl = `http://127.0.0.1:${maskedHealthPort}`;
    const maskedHealth = await waitForOk(`${maskedHealthUrl}/health`)
        .then(() => fetch(`${maskedHealthUrl}/health`).then((r) => r.json()))
        .catch(() => null);
    check('GET /health masks a credential in the backend URL',
        maskedHealth?.status === 'ok' && maskedHealth?.backend === 'http://***@127.0.0.1:4199/proxy?token=***',
        JSON.stringify(maskedHealth));
    check('the startup summary masks the backend URL too', !maskedHealthOut.includes('s3cr3t-value'),
        maskedHealthOut.slice(0, 160));
    stopGateway(maskedHealthGateway);
    await waitForExit(maskedHealthGateway);

    const backendUp = await fetch(`${spawnUrl}/health`).then((r) => r.status).catch(() => 0);
    check('the spawned backend is reachable', backendUp === 200, `status ${backendUp}`);

    // A backend that disappears in the middle of a request is an upstream failure (502), not a gateway bug (500),
    // and the next request must start it again instead of failing until the process is restarted
    // The stub kills itself as soon as it has accepted the prompt, so this needs no timer of its own: a SIGKILL from
    // the test after a sleep raced the gateway's "three identical polls is an answer" rule, and a loaded runner let
    // the kill land after a partial answer had been accepted (the test then read a 200 for a dead backend).
    const killedAnswer = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'SUICIDE while the backend dies' }] })
    }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));
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

    // --- a backend that rejects session creation --------------------------------------------------------
    // An incompatible backend (a version whose API moved, a proxy in front of it) answers /health but refuses
    // POST /session. That is an upstream failure, so it answers 502 with the upstream status and reason instead of a
    // bare 500 that blames the gateway and explains nothing.
    const rejectStubPort = GATEWAY_PORT + 13;
    const rejectStub = spawn(process.execPath, ['test/stub-opencode.mjs'], {
        cwd: ROOT,
        env: { ...process.env, STUB_PORT: String(rejectStubPort), STUB_FAIL_SESSION: '1' }
    });
    children.push(rejectStub);
    rejectStub.stdout.on('data', () => {});
    rejectStub.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${rejectStubPort}/health`);
    const rejectGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(rejectStubPort + 1),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `http://127.0.0.1:${rejectStubPort}`,
            LOG_LEVEL: 'error'
        }
    });
    children.push(rejectGateway);
    rejectGateway.stdout.on('data', () => {});
    rejectGateway.stderr.on('data', () => {});
    const rejectUrl = `http://127.0.0.1:${rejectStubPort + 1}`;
    await waitForOk(`${rejectUrl}/health`);
    const rejected = await fetch(`${rejectUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15000)
    }).then((r) => r.json().then((json) => ({ status: r.status, json })))
        .catch((error) => ({ status: 0, json: { error: error.message } }));
    check('a backend that rejects session creation is an upstream error',
        rejected.status === 502 && rejected.json?.error?.type === 'server_error',
        `status ${rejected.status} ${JSON.stringify(rejected.json)?.slice(0, 160)}`);
    check('the rejection names the upstream status and reason',
        /status 405/.test(String(rejected.json?.error?.message)) && /not supported by this build/.test(String(rejected.json?.error?.message)),
        JSON.stringify(rejected.json?.error?.message)?.slice(0, 160));
    stopGateway(rejectGateway);
    await waitForExit(rejectGateway);
    stop(rejectStub);
    await waitForExit(rejectStub);

    // --- a backend that rejects the event stream ---------------------------------------------------------
    // A build whose SSE endpoint moved, or a proxy in front of it, answers /health and the session calls but refuses
    // GET /event. The SDK reports that as an error tuple with no stream, so the gateway must fall back to polling and
    // still answer: a streaming client that gets a 502 (or a hang) because of a missing event stream is a broken
    // gateway, not a broken model.
    const noEventsStubPort = GATEWAY_PORT + 15;
    const noEventsStub = spawn(process.execPath, ['test/stub-opencode.mjs'], {
        cwd: ROOT,
        env: { ...process.env, STUB_PORT: String(noEventsStubPort), STUB_FAIL_EVENTS: '1' }
    });
    children.push(noEventsStub);
    noEventsStub.stdout.on('data', () => {});
    noEventsStub.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${noEventsStubPort}/health`);
    const noEventsGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(noEventsStubPort + 1),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `http://127.0.0.1:${noEventsStubPort}`,
            LOG_LEVEL: 'error'
        }
    });
    children.push(noEventsGateway);
    noEventsGateway.stdout.on('data', () => {});
    noEventsGateway.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${noEventsStubPort + 1}/health`);
    const noEventsUrl = `http://127.0.0.1:${noEventsStubPort + 1}`;
    const noEventsResponse = await fetch(`${noEventsUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
        signal: AbortSignal.timeout(20000)
    }).then(async (r) => ({ status: r.status, text: await r.text() }))
        .catch((error) => ({ status: 0, text: String(error) }));
    const noEventsFrames = parseSseFrames(noEventsResponse.text);
    const noEventsText = noEventsFrames
        .filter((frame) => frame !== '[DONE]')
        .map((frame) => { try { return JSON.parse(frame); } catch { return null; } })
        .filter(Boolean)
        .map((chunk) => chunk.choices?.[0]?.delta?.content || '')
        .join('');
    check('a rejected event stream still answers the streaming request',
        noEventsResponse.status === 200 && noEventsText === ANSWER,
        `status ${noEventsResponse.status} content ${JSON.stringify(noEventsText)}`);
    check('the polling fallback still terminates the stream',
        noEventsFrames[noEventsFrames.length - 1] === '[DONE]',
        JSON.stringify(noEventsFrames.slice(-2)));
    stopGateway(noEventsGateway);
    await waitForExit(noEventsGateway);
    stop(noEventsStub);
    await waitForExit(noEventsStub);

    // --- a backend that reports no models ---------------------------------------------------------------
    // A provider payload the gateway cannot read (a changed shape, a version that reports nothing) answers 200 with an
    // empty list. Serving {"data":[]} leaves a client with no model to choose, so the gateway falls back to its single
    // static model - exactly as it does when the call fails - and does not cache the empty answer.
    const emptyStubPort = GATEWAY_PORT + 11;
    const emptyStub = spawn(process.execPath, ['test/stub-opencode.mjs'], {
        cwd: ROOT,
        env: { ...process.env, STUB_PORT: String(emptyStubPort), STUB_EMPTY_PROVIDERS: '1' }
    });
    children.push(emptyStub);
    emptyStub.stdout.on('data', () => {});
    emptyStub.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${emptyStubPort}/health`);
    const emptyGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(emptyStubPort + 1),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `http://127.0.0.1:${emptyStubPort}`,
            LOG_LEVEL: 'error'
        }
    });
    children.push(emptyGateway);
    emptyGateway.stdout.on('data', () => {});
    emptyGateway.stderr.on('data', () => {});
    const emptyUrl = `http://127.0.0.1:${emptyStubPort + 1}`;
    await waitForOk(`${emptyUrl}/health`);
    const emptyList = await fetch(`${emptyUrl}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } })
        .then((r) => r.json()).catch(() => null);
    // The second call reports a provider whose model map the gateway cannot read, so both shapes of an unreadable
    // payload take the fallback path
    check('an empty or model-less provider list falls back to the static model',
        emptyList?.object === 'list' && emptyList.data?.length === 1 && emptyList.data[0].id === 'opencode/big-pickle' &&
        emptyList.data[0].name === 'Big Pickle' && emptyList.data[0].owned_by === 'opencode',
        JSON.stringify(emptyList)?.slice(0, 140));
    const emptyListAgain = await fetch(`${emptyUrl}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } })
        .then((r) => r.json()).catch(() => null);
    check('the fallback answer is not cached',
        emptyListAgain?.data?.length === 1 && emptyListAgain.data[0].id === 'opencode/big-pickle',
        JSON.stringify(emptyListAgain)?.slice(0, 140));
    stopGateway(emptyGateway);
    await waitForExit(emptyGateway);
    stop(emptyStub);
    await waitForExit(emptyStub);

    // --- a backend that refuses the provider listing -----------------------------------------------------
    // The SDK resolves a non-2xx answer with `{ error, response }` instead of throwing, so a gateway that reads only
    // `.data` reports the refusal as "the backend reported no models" - a wrong diagnosis for an upstream failure, and
    // the one SDK call in the gateway that did not inspect its error tuple.
    const failProvidersStubPort = GATEWAY_PORT + 29;
    const failProvidersStub = spawn(process.execPath, ['test/stub-opencode.mjs'], {
        cwd: ROOT,
        env: { ...process.env, STUB_PORT: String(failProvidersStubPort), STUB_FAIL_PROVIDERS: '1' }
    });
    children.push(failProvidersStub);
    failProvidersStub.stdout.on('data', () => {});
    failProvidersStub.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${failProvidersStubPort}/health`);
    let failProvidersOutput = '';
    const failProvidersGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(failProvidersStubPort + 1),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `http://127.0.0.1:${failProvidersStubPort}`,
            LOG_LEVEL: 'info'
        }
    });
    children.push(failProvidersGateway);
    failProvidersGateway.stdout.on('data', (chunk) => { failProvidersOutput += chunk; });
    failProvidersGateway.stderr.on('data', (chunk) => { failProvidersOutput += chunk; });
    await waitForOk(`http://127.0.0.1:${failProvidersStubPort + 1}/health`);
    const failProvidersList = await fetch(`http://127.0.0.1:${failProvidersStubPort + 1}/v1/models`, {
        headers: { authorization: `Bearer ${API_KEY}` }
    }).then((r) => r.json()).catch(() => null);
    check('a refused provider listing falls back to the static model',
        failProvidersList?.data?.length === 1 && failProvidersList.data[0].id === 'opencode/big-pickle',
        JSON.stringify(failProvidersList)?.slice(0, 140));
    check('a refused provider listing is reported as a refused call, not as an empty one',
        /rejected the provider listing \(status 500\)/.test(failProvidersOutput) &&
        !/reported no models/.test(failProvidersOutput),
        JSON.stringify(failProvidersOutput.split('\n').find((line) => line.includes('provider listing')) || '').slice(0, 200));
    stopGateway(failProvidersGateway);
    await waitForExit(failProvidersGateway);
    stop(failProvidersStub);
    await waitForExit(failProvidersStub);

    // --- a config.json next to the working directory ------------------------------------------------
    // config.json is read from the application directory, not from the cwd. A file written next to the shell's cwd used
    // to be ignored in complete silence, which looks exactly like a broken configuration.
    const cwdWarnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-cwd-'));
    fs.writeFileSync(path.join(cwdWarnDir, 'config.json'), JSON.stringify({ PORT: 1 }));
    const cwdWarnPort = GATEWAY_PORT + 19;
    const cwdWarnGateway = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
        cwd: cwdWarnDir,
        env: {
            ...process.env,
            PORT: String(cwdWarnPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            LOG_LEVEL: 'info'
        }
    });
    children.push(cwdWarnGateway);
    let cwdWarnOutput = '';
    cwdWarnGateway.stdout.on('data', (chunk) => { cwdWarnOutput += chunk.toString(); });
    cwdWarnGateway.stderr.on('data', (chunk) => { cwdWarnOutput += chunk.toString(); });
    await waitForOk(`http://127.0.0.1:${cwdWarnPort}/health`);
    check('a config.json ignored because it is not next to the app is reported',
        /config\.json is read from .*the file at .* is ignored/.test(cwdWarnOutput),
        cwdWarnOutput.split('\n').find((line) => line.includes('is ignored')) || cwdWarnOutput.slice(0, 160));
    stopGateway(cwdWarnGateway);
    await waitForExit(cwdWarnGateway);
    fs.rmSync(cwdWarnDir, { recursive: true, force: true });

    // --- a poll that fails while the answer is being written ---------------------------------------------
    // One failed poll used to end the completion: a 5xx was silently skipped and a dropped connection threw out of the
    // loop, although the answer was one poll away. Polls are retried now, and only a run of consecutive failures is
    // reported - as an upstream error, in bounded time.
    const retryStubPort = GATEWAY_PORT + 15;
    const retryStub = spawn(process.execPath, ['test/stub-opencode.mjs'], {
        cwd: ROOT,
        env: { ...process.env, STUB_PORT: String(retryStubPort), STUB_FAIL_MESSAGES: '1', STUB_DROP_MESSAGES: '1' }
    });
    children.push(retryStub);
    retryStub.stdout.on('data', () => {});
    retryStub.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${retryStubPort}/health`);
    const retryGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(retryStubPort + 1),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `http://127.0.0.1:${retryStubPort}`,
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '8000',
            LOG_LEVEL: 'error'
        }
    });
    children.push(retryGateway);
    retryGateway.stdout.on('data', () => {});
    retryGateway.stderr.on('data', () => {});
    const retryUrl = `http://127.0.0.1:${retryStubPort + 1}`;
    await waitForOk(`${retryUrl}/health`);
    const retried = await fetch(`${retryUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(20000)
    }).then((r) => r.json().then((json) => ({ status: r.status, json })))
        .catch((error) => ({ status: 0, json: { error: error.message } }));
    check('a dropped or failed poll is retried instead of ending the completion',
        retried.status === 200 && /smoke test stub/.test(String(retried.json?.choices?.[0]?.message?.content)),
        `status ${retried.status} ${JSON.stringify(retried.json)?.slice(0, 140)}`);
    stopGateway(retryGateway);
    await waitForExit(retryGateway);
    stop(retryStub);
    await waitForExit(retryStub);

    const failPollStubPort = GATEWAY_PORT + 17;
    const failPollStub = spawn(process.execPath, ['test/stub-opencode.mjs'], {
        cwd: ROOT,
        env: { ...process.env, STUB_PORT: String(failPollStubPort), STUB_ALWAYS_FAIL_MESSAGES: '1' }
    });
    children.push(failPollStub);
    failPollStub.stdout.on('data', () => {});
    failPollStub.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${failPollStubPort}/health`);
    const failPollGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(failPollStubPort + 1),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `http://127.0.0.1:${failPollStubPort}`,
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '8000',
            LOG_LEVEL: 'error'
        }
    });
    children.push(failPollGateway);
    failPollGateway.stdout.on('data', () => {});
    failPollGateway.stderr.on('data', () => {});
    const failPollUrl = `http://127.0.0.1:${failPollStubPort + 1}`;
    await waitForOk(`${failPollUrl}/health`);
    const failPollStart = Date.now();
    const failPolled = await fetch(`${failPollUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(30000)
    }).then((r) => r.json().then((json) => ({ status: r.status, json })))
        .catch((error) => ({ status: 0, json: { error: error.message } }));
    const failPollMs = Date.now() - failPollStart;
    check('a backend that keeps failing the poll is an upstream error',
        failPolled.status === 502 && failPolled.json?.error?.type === 'server_error' &&
        /status 500/.test(String(failPolled.json?.error?.message)),
        `status ${failPolled.status} ${JSON.stringify(failPolled.json)?.slice(0, 160)}`);
    check('the failed poll gives up well before the request timeout', failPollMs < 7000, `${failPollMs}ms`);
    const failPollSessions = await sessionsAfterCleanup(`http://127.0.0.1:${failPollStubPort}`);
    check('the failed poll still deletes its session', failPollSessions?.live === 0,
        JSON.stringify(failPollSessions)?.slice(0, 120));
    stopGateway(failPollGateway);
    await waitForExit(failPollGateway);
    stop(failPollStub);
    await waitForExit(failPollStub);

    // A poll that answers 2xx with something that is not a message list is an unreadable upstream, not the backend
    // saying "200: failed": the message has to name the shape, because `failed ... (status 200)` sends the reader
    // looking for a gateway bug instead of an envelope change (or a proxy in front of the backend).
    const oddPollStubPort = GATEWAY_PORT + 19;
    const oddPollStub = spawn(process.execPath, ['test/stub-opencode.mjs'], {
        cwd: ROOT,
        env: { ...process.env, STUB_PORT: String(oddPollStubPort), STUB_UNREADABLE_MESSAGES: '1' }
    });
    children.push(oddPollStub);
    oddPollStub.stdout.on('data', () => {});
    oddPollStub.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${oddPollStubPort}/health`);
    const oddPollGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(oddPollStubPort + 1),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `http://127.0.0.1:${oddPollStubPort}`,
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '8000',
            LOG_LEVEL: 'error'
        }
    });
    children.push(oddPollGateway);
    oddPollGateway.stdout.on('data', () => {});
    oddPollGateway.stderr.on('data', () => {});
    const oddPollUrl = `http://127.0.0.1:${oddPollStubPort + 1}`;
    await waitForOk(`${oddPollUrl}/health`);
    const oddPolled = await fetch(`${oddPollUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(30000)
    }).then((r) => r.json().then((json) => ({ status: r.status, json })))
        .catch((error) => ({ status: 0, json: { error: error.message } }));
    const oddPollMessage = String(oddPolled.json?.error?.message || '');
    check('a poll answer that is not a message list is reported as unreadable',
        oddPolled.status === 502 && /payload that is not a message list/.test(oddPollMessage),
        `status ${oddPolled.status} ${oddPollMessage.slice(0, 160)}`);
    check('the unreadable poll message does not read like a failed request that succeeded',
        !/failed while polling the answer \(status 200\)/.test(oddPollMessage), oddPollMessage.slice(0, 160));
    stopGateway(oddPollGateway);
    await waitForExit(oddPollGateway);
    stop(oddPollStub);
    await waitForExit(oddPollStub);

    // --- a backend that answers /health but nothing else -------------------------------------------------
    // A wedged opencode process (health OK, /session silent) used to hang the request handler forever: fetch has no
    // default timeout, so the promise never settled, the client got no answer at all and the queue slot was never
    // freed - at the default concurrency of 1 that stops the whole gateway. The wedged backend never answers, so the
    // request can only end if the gateway itself sets a deadline.
    const wedgedPort = GATEWAY_PORT + 9;
    const wedgedBackend = http.createServer((request, response) => {
        if (request.url === '/health') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{"status":"ok"}');
            return;
        }
        // Every other path is accepted and never answered
    });
    await new Promise((resolve) => wedgedBackend.listen(wedgedPort, '127.0.0.1', resolve));
    const wedgedGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(wedgedPort + 1),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `http://127.0.0.1:${wedgedPort}`,
            // Short budget: the assertion is that a deadline exists at all, not how large the default is
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '1500',
            LOG_LEVEL: 'error'
        }
    });
    children.push(wedgedGateway);
    wedgedGateway.stdout.on('data', () => {});
    wedgedGateway.stderr.on('data', () => {});
    const wedgedUrl = `http://127.0.0.1:${wedgedPort + 1}`;
    await waitForOk(`${wedgedUrl}/health`);
    const wedgedStartedAt = Date.now();
    const wedgedAnswer = await fetch(`${wedgedUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15000)
    }).then((r) => r.text().then((body) => ({ status: r.status, body })))
        .catch((error) => ({ status: 0, body: error.message }));
    const wedgedMs = Date.now() - wedgedStartedAt;
    check('a backend that never answers is reported as a gateway timeout',
        wedgedAnswer.status === 504 && /did not answer within/.test(wedgedAnswer.body),
        `status ${wedgedAnswer.status} after ${wedgedMs}ms ${wedgedAnswer.body.slice(0, 140)}`);
    // The slot has to be free again: a second request must reach its own timeout instead of queueing behind the
    // first one (the queue timeout would otherwise answer 504 only after the full request budget)
    const wedgedStartedAt2 = Date.now();
    const wedgedAgain = await fetch(`${wedgedUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi again' }] }),
        signal: AbortSignal.timeout(15000)
    }).then((r) => r.text().then((body) => ({ status: r.status, body })))
        .catch((error) => ({ status: 0, body: error.message }));
    check('the gateway keeps serving after an upstream timeout',
        wedgedAgain.status === 504 && Date.now() - wedgedStartedAt2 < 10000,
        `status ${wedgedAgain.status} after ${Date.now() - wedgedStartedAt2}ms ${wedgedAgain.body.slice(0, 140)}`);
    // A metadata call has no completion to time out, so it needs its own deadline: the model list used to wait for the
    // provider round trip forever, and a client listing models before chatting never got an answer at all
    const wedgedModelsStartedAt = Date.now();
    const wedgedModels = await fetch(`${wedgedUrl}/v1/models`, {
        headers: { authorization: `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(15000)
    }).then((r) => r.json().then((json) => ({ status: r.status, json })))
        .catch((error) => ({ status: 0, json: { error: error.message } }));
    check('the model list answers from its fallback when the backend is silent',
        wedgedModels.status === 200 && wedgedModels.json?.object === 'list' && wedgedModels.json.data?.length === 1,
        `status ${wedgedModels.status} after ${Date.now() - wedgedModelsStartedAt}ms ${JSON.stringify(wedgedModels.json).slice(0, 140)}`);
    // A timeout must not leave a rejected promise behind: an unhandled rejection ends the process by default, so the
    // gateway answering again is the assertion that the late rejection was handled
    const wedgedAlive = await fetch(`${wedgedUrl}/health`).then((r) => r.status).catch(() => 0);
    check('the gateway survives an upstream timeout', wedgedAlive === 200, `health ${wedgedAlive}`);
    stopGateway(wedgedGateway);
    await waitForExit(wedgedGateway);
    await new Promise((resolve) => wedgedBackend.close(resolve));
    if (typeof wedgedBackend.closeAllConnections === 'function') wedgedBackend.closeAllConnections();

    // --- client input that must not become a 500, a forged log line, or a bare parser error --------------
    // A role is client input: a truthy non-string threw inside the prompt builder and answered 500 with the internal
    // expression in the message (`((intermediate value) || "user").toLowerCase is not a function`).
    const badRole = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 5, content: 'hi' }] }
    });
    check('a non-string message role is a client error, not a gateway crash',
        badRole.response.status === 400 && badRole.json?.error?.type === 'invalid_request_error',
        `${badRole.response.status} ${badRole.text.slice(0, 160)}`);
    check('the rejected role names the field and leaks nothing internal',
        /messages\[0\]\.role must be a string/.test(badRole.json?.error?.message || '') && !/toLowerCase/.test(badRole.text),
        badRole.text.slice(0, 160));

    // A content part the gateway cannot forward used to be dropped in silence: a multimodal request was answered from
    // the text alone, and one that carried only an image was answered with "messages must include at least one
    // non-system text message", which blames the client's text instead of the part it actually sent.
    const imageOnly = await request('/v1/chat/completions', {
        method: 'POST',
        body: {
            messages: [{
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }]
            }]
        }
    });
    check('a request whose only content part is an image is refused by name',
        imageOnly.response.status === 400 &&
        /messages\[0\]\.content\[0\] uses an unsupported content part type "image_url"/.test(imageOnly.json?.error?.message || ''),
        `${imageOnly.response.status} ${imageOnly.text.slice(0, 200)}`);
    check('the refused part is not reported as missing text',
        !/non-system text message/.test(imageOnly.text), imageOnly.text.slice(0, 200));
    const textPlusImage = await request('/v1/chat/completions', {
        method: 'POST',
        body: {
            messages: [
                { role: 'system', content: 'be brief' },
                { role: 'user', content: [{ type: 'text', text: 'describe this' }, { type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }] }
            ]
        }
    });
    check('a mixed request is refused instead of answered from its text alone',
        textPlusImage.response.status === 400 &&
        /messages\[1\]\.content\[1\] uses an unsupported content part type "input_audio"/.test(textPlusImage.json?.error?.message || ''),
        `${textPlusImage.response.status} ${textPlusImage.text.slice(0, 200)}`);
    // The Responses-API spelling of a text part carries the same field, and a plain string part is still text
    const textParts = await request('/v1/chat/completions', {
        method: 'POST',
        body: { messages: [{ role: 'user', content: [{ type: 'input_text', text: 'plain' }, ' '] }, { role: 'user', content: 'string part' }] }
    });
    check('text parts of either spelling still reach the backend', textParts.response.status === 200,
        `${textParts.response.status} ${textParts.text.slice(0, 160)}`);

    // The model id is client input that lands in the request log line: a newline in it used to start a second,
    // attacker-written line (`FORGED [INFO] …`), and an unbounded id turned one request body into that many bytes of
    // log. The backend still receives the id verbatim; only the logged copy is normalised.
    const forgedModel = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'opencode/big-pickle\n[Security] FORGED', messages: [{ role: 'user', content: 'hi' }] }
    });
    const longModelAnswer = await request('/v1/chat/completions', {
        method: 'POST',
        body: { model: `opencode/${'x'.repeat(2000)}`, messages: [{ role: 'user', content: 'hi' }] }
    });
    await sleep(200);
    const forgedLines = gatewayOutput.split('\n').filter((line) => line.includes('FORGED'));
    check('a model id carrying a newline cannot start a second log line',
        forgedModel.response.status === 200 && forgedLines.length > 0 &&
        forgedLines.every((line) => /model=opencode\/big-pickle\?\[Security\] FORGED/.test(line)),
        JSON.stringify(forgedLines.slice(0, 2)));
    const longModelLine = gatewayOutput.split('\n').find((line) => line.includes('xxxxxxxxxx'));
    check('a very long model id is truncated in the request log line',
        longModelAnswer.response.status === 200 && Boolean(longModelLine) && longModelLine.length < 400,
        `${longModelLine ? longModelLine.length : 0} chars`);

    // The built-in key is always announced. Its value is public and stated in the docs; a *configured* key is never
    // printed (see the docker/README examples and the entrypoint's mask)
    const securityLine = gatewayOutput.split('\n').find((line) => line.includes('[Security]'));
    check('the built-in key is announced at startup',
        /\[Security\]/.test(gatewayOutput) && /built-in/.test(securityLine || ''),
        securityLine || 'no [Security] line');

    // The URL is part of the request log line, so a key sent in the query string used to be written into it verbatim
    const queryKeyAnswer = await request('/v1/models?api_key=sk-in-the-query-string-123456');
    await sleep(200);
    const queryKeyLine = gatewayOutput.split('\n').find((line) => line.includes('api_key='));
    check('a credential in the query string is masked in the request log',
        queryKeyAnswer.response.status === 200 && Boolean(queryKeyLine) &&
        /api_key=\*\*\*/.test(queryKeyLine) && !gatewayOutput.includes('sk-in-the-query-string-123456'),
        JSON.stringify(queryKeyLine || '').slice(0, 200));

    // A request the HTTP parser rejects never reaches a hook (hooks run after routing), so Fastify's own handler used
    // to answer `{"error":"Bad Request","message":"Client Error","statusCode":400}`: no type, no CORS headers, no
    // X-Request-Id and no log line, all four of which the contract documents as unconditional.
    const rawReply = await new Promise((resolve) => {
        let data = '';
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve(data);
        };
        const socket = net.connect(GATEWAY_PORT, '127.0.0.1', () => {
            // A space in a header name is not a valid token: the parser rejects the request with HPE_INVALID_HEADER_TOKEN
            socket.write('GET /v1/models HTTP/1.1\r\nHost: localhost\r\nBad Header: y\r\n\r\n');
        });
        socket.on('data', (chunk) => { data += chunk.toString('latin1'); });
        socket.on('close', done);
        socket.on('error', done);
        setTimeout(() => {
            socket.destroy();
            done();
        }, 4000);
    });
    const rawHeaderBlock = rawReply.split('\r\n\r\n')[0] || '';
    const rawBody = rawReply.slice(rawHeaderBlock.length + 4);
    let rawJson = null;
    try {
        rawJson = JSON.parse(rawBody);
    } catch {
        rawJson = null;
    }
    check('a request the HTTP parser rejects answers the documented error envelope',
        /^HTTP\/1\.1 400 /.test(rawReply) && rawJson?.error?.type === 'invalid_request_error' &&
        typeof rawJson?.error?.message === 'string',
        JSON.stringify(rawReply.slice(0, 200)));
    check('a parser-level rejection still carries CORS and a request id',
        /access-control-allow-origin: \*/i.test(rawHeaderBlock) && /x-request-id: gw-/i.test(rawHeaderBlock),
        rawHeaderBlock.slice(0, 240));
    // ...and the envelope has to arrive whole: the handler wrote it and called socket.destroy() on the next line, which
    // discards buffered writes, so under backpressure the client saw a reset instead of the error it was promised
    const declaredLength = Number((/content-length: (\d+)/i.exec(rawHeaderBlock) || [])[1]);
    check('a parser-level rejection delivers its whole body instead of a reset',
        Number.isFinite(declaredLength) && Buffer.byteLength(rawBody, 'latin1') === declaredLength,
        `declared ${declaredLength}, received ${Buffer.byteLength(rawBody, 'latin1')}`);

    // --- a body that never arrives must not hold a connection --------------------------------------------
    // Fastify sets `requestTimeout: 0`, so nothing bounded the wait for an announced body: a client that sent a
    // Content-Length and then stopped held the socket for as long as it liked - measured 20 s with no answer - and it
    // needed no credential, because the 401 is written from the headers while Node keeps the connection alive to drain
    // a body it will never read. The budget is what bounds the deadline, so a short one makes this cheap to assert.
    const deadlinePort = GATEWAY_PORT + 30;
    const deadlineGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(deadlinePort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '1200',
            LOG_LEVEL: 'warn'
        }
    });
    children.push(deadlineGateway);
    deadlineGateway.stdout.on('data', () => {});
    deadlineGateway.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${deadlinePort}/health`);
    const stalledBody = (headers) => new Promise((resolve) => {
        const startedAt = Date.now();
        let data = '';
        let settled = false;
        const finish = (closedBy) => {
            if (settled) return;
            settled = true;
            resolve({ closedBy, ms: Date.now() - startedAt, raw: data });
        };
        const socket = net.connect(deadlinePort, '127.0.0.1', () => {
            socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\n' +
                'Content-Type: application/json\r\nContent-Length: 4096\r\n' + headers + '\r\n{"messages":[');
        });
        socket.on('data', (chunk) => { data += chunk.toString('latin1'); });
        socket.on('close', () => finish('gateway'));
        socket.on('error', () => finish('gateway'));
        setTimeout(() => {
            socket.destroy();
            finish('client');
        }, 6000);
    });
    const stalledKeyed = await stalledBody(`Authorization: Bearer ${API_KEY}\r\n`);
    check('an unfinished request body is answered with a timeout instead of being held open',
        stalledKeyed.closedBy === 'gateway' && stalledKeyed.ms < 5000 && /^HTTP\/1\.1 408 /.test(stalledKeyed.raw) &&
        /Request body was not received within 1200ms/.test(stalledKeyed.raw),
        `${stalledKeyed.closedBy} after ${stalledKeyed.ms}ms ${JSON.stringify(stalledKeyed.raw.slice(0, 160))}`);
    const stalledAnon = await stalledBody('');
    check('the same deadline closes a body sent without a key',
        stalledAnon.closedBy === 'gateway' && stalledAnon.ms < 5000 && /^HTTP\/1\.1 401 /.test(stalledAnon.raw),
        `${stalledAnon.closedBy} after ${stalledAnon.ms}ms ${JSON.stringify(stalledAnon.raw.slice(0, 160))}`);
    stopGateway(deadlineGateway);
    await waitForExit(deadlineGateway);

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

    // --- a tuning value that cannot be used is named, not silently replaced -------------------------------
    // These three keys fell back to their default without a word, so an operator who typo'd the request budget ran a
    // gateway with 300000 ms while believing a shorter one was in force. The queue and body knobs already worked this
    // way; now all of them do.
    const invalidConfigPort = GATEWAY_PORT + 26;
    const invalidConfigGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(invalidConfigPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: STUB_URL,
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '0',
            OPENCODE_PROXY_HEALTH_CACHE_MS: 'abc',
            OPENCODE_PROXY_START_RETRY_MS: 'soon',
            LOG_LEVEL: 'info'
        }
    });
    children.push(invalidConfigGateway);
    let invalidConfigOutput = '';
    invalidConfigGateway.stdout.on('data', (chunk) => { invalidConfigOutput += chunk.toString(); });
    invalidConfigGateway.stderr.on('data', (chunk) => { invalidConfigOutput += chunk.toString(); });
    await waitForOk(`http://127.0.0.1:${invalidConfigPort}/health`);
    check('a malformed request timeout is reported with the value actually used',
        /OPENCODE_PROXY_REQUEST_TIMEOUT_MS='0' is not a positive number, using 300000/.test(invalidConfigOutput),
        invalidConfigOutput.split('\n').filter((line) => line.includes('REQUEST_TIMEOUT')).join(' | ').slice(0, 200));
    check('malformed backend timings are reported instead of silently ignored',
        /OPENCODE_PROXY_HEALTH_CACHE_MS='abc' is not a number, using 2000/.test(invalidConfigOutput) &&
        /OPENCODE_PROXY_START_RETRY_MS='soon' is not a number, using 15000/.test(invalidConfigOutput),
        invalidConfigOutput.split('\n').filter((line) => /HEALTH_CACHE|START_RETRY/.test(line)).join(' | ').slice(0, 240));
    stopGateway(invalidConfigGateway);
    await waitForExit(invalidConfigGateway);

    // --- a blank environment variable means "not configured" ---------------------------------------------
    // `PORT` and `API_KEY` were read with `??`, where an empty string is a value: `API_KEY= PORT=` (a unit file's
    // `Environment=API_KEY=`, an empty Helm value, a shell that exports unconditionally) shadowed config.json, so the
    // gateway listened on the default port and authenticated with the built-in public key while the file named a
    // different port and a real secret. Every other key falls through on a blank value; these two now do too.
    // The unknown-key report reads the file itself, so it is asserted without a gateway too: a known-only file reports
    // nothing (every legitimate config must stay silent), and the suggestion only fires for a case/separator typo.
    const unknownKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-opencode-api-unknown-keys-'));
    try {
        const writeConfig = (value) => {
            const file = path.join(unknownKeyDir, 'config.json');
            fs.writeFileSync(file, JSON.stringify(value));
            return readConfigFile(file);
        };
        const cleanConfig = writeConfig({ PORT: 8083, API_KEY: 'sk-clean' });
        check('a config.json with only known keys reports no unknown key',
            cleanConfig.error === null && findUnknownKeys(cleanConfig.config).length === 0,
            `${cleanConfig.error} ${JSON.stringify(findUnknownKeys(cleanConfig.config))}`);
        const typoConfig = writeConfig({ PORT: 8083, 'api-key': 'x', openCodePath: '/usr/bin/opencode', extra: 1 });
        const reported = findUnknownKeys(typoConfig.config);
        check('a misspelled config.json key is reported with its suggestion',
            reported.length === 3 &&
            reported[0].suggestion === 'API_KEY' && reported[1].suggestion === 'OPENCODE_PATH' &&
            reported[2].suggestion === null,
            JSON.stringify(reported));
    } finally {
        fs.rmSync(unknownKeyDir, { recursive: true, force: true });
    }

    const blankEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-opencode-api-blank-env-'));
    try {
        fs.copyFileSync(path.join(ROOT, 'index.js'), path.join(blankEnvDir, 'index.js'));
        fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(blankEnvDir, 'package.json'));
        fs.cpSync(path.join(ROOT, 'src'), path.join(blankEnvDir, 'src'), { recursive: true });
        // 'junction' on Windows: a plain directory symlink needs Developer Mode or elevation there
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(blankEnvDir, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir');
        const blankEnvPort = GATEWAY_PORT + 31;
        const blankEnvKey = 'sk-from-file-blank-env';
        // A misspelled key used to change nothing at all, in complete silence: the gateway ran the default while the
        // operator was sure the value in the file was in force. `__proto__` and a nested object are here for the same
        // reason a hostile file is: they must be reported, never merged. `__proto__` is spliced into the text because a
        // `__proto__` in a JavaScript object literal sets the prototype and never reaches JSON.stringify.
        const blankEnvConfig = JSON.stringify({
            PORT: blankEnvPort,
            BIND_HOST: '127.0.0.1',
            API_KEY: blankEnvKey,
            OPENCODE_SERVER_URL: STUB_URL,
            APIKEY: 'sk-typo',
            OPENCODE_PROXY_MAX_CONCURENCY: 4,
            deep: { x: 1 }
        });
        fs.writeFileSync(path.join(blankEnvDir, 'config.json'),
            `${blankEnvConfig.slice(0, -1)},"__proto__":{"polluted":true}}`);
        const blankEnvGateway = spawn(process.execPath, ['index.js'], {
            cwd: blankEnvDir,
            env: { ...process.env, PORT: '', API_KEY: '', LOG_LEVEL: 'warn' }
        });
        children.push(blankEnvGateway);
        let blankEnvOut = '';
        blankEnvGateway.stdout.on('data', (chunk) => { blankEnvOut += chunk.toString(); });
        blankEnvGateway.stderr.on('data', (chunk) => { blankEnvOut += chunk.toString(); });
        const blankEnvUp = await waitForOk(`http://127.0.0.1:${blankEnvPort}/health`, 10000).then(() => true).catch(() => false);
        const fileKeyStatus = blankEnvUp
            ? await fetch(`http://127.0.0.1:${blankEnvPort}/v1/models`, { headers: { authorization: `Bearer ${blankEnvKey}` } })
                .then((response) => response.status).catch(() => 0)
            : 0;
        const builtinKeyStatus = blankEnvUp
            ? await fetch(`http://127.0.0.1:${blankEnvPort}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } })
                .then((response) => response.status).catch(() => 0)
            : 0;
        check('a blank environment variable does not hide the port and key from config.json',
            blankEnvUp && fileKeyStatus === 200 && builtinKeyStatus === 401,
            `listening=${blankEnvUp} fileKey=${fileKeyStatus} builtinKey=${builtinKeyStatus}`);
        check('an unknown config.json key is reported with the key it probably meant',
            blankEnvOut.includes("unknown key 'APIKEY' (did you mean 'API_KEY'?)") &&
            blankEnvOut.includes("unknown key '__proto__'"),
            blankEnvOut.split('\n').filter((line) => line.includes('unknown key')).join(' | ').slice(0, 200));
        check('an unknown config.json key is never merged into a prototype',
            ({}).polluted === undefined && fileKeyStatus === 200, `polluted=${({}).polluted}`);
        stopGateway(blankEnvGateway);
        await waitForExit(blankEnvGateway);
    } finally {
        fs.rmSync(blankEnvDir, { recursive: true, force: true });
    }

    // --- the poll fallback shares the request budget instead of buying a second one -----------------------
    // A streaming request whose event stream stalls spent the whole budget waiting for events and then a fresh, full
    // budget polling for an answer nobody had written: the client waited about twice the advertised timeout.
    const budgetStubPort = GATEWAY_PORT + 24;
    const budgetStub = spawn(process.execPath, ['test/stub-opencode.mjs'], {
        cwd: ROOT,
        env: { ...process.env, STUB_PORT: String(budgetStubPort) }
    });
    children.push(budgetStub);
    budgetStub.stdout.on('data', () => {});
    budgetStub.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${budgetStubPort}/health`);
    const budgetGatewayPort = GATEWAY_PORT + 25;
    const budgetGateway = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(budgetGatewayPort),
            BIND_HOST: '127.0.0.1',
            OPENCODE_SERVER_URL: `http://127.0.0.1:${budgetStubPort}`,
            OPENCODE_PROXY_REQUEST_TIMEOUT_MS: '3000',
            LOG_LEVEL: 'error'
        }
    });
    children.push(budgetGateway);
    budgetGateway.stdout.on('data', () => {});
    budgetGateway.stderr.on('data', () => {});
    await waitForOk(`http://127.0.0.1:${budgetGatewayPort}/health`);
    const budgetStartedAt = Date.now();
    const budgetStream = await fetch(`http://127.0.0.1:${budgetGatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'STALL please' }], stream: true }),
        signal: AbortSignal.timeout(20000)
    }).then(async (response) => ({ status: response.status, text: await response.text() }))
        .catch((error) => ({ status: 0, text: error.message }));
    const budgetElapsed = Date.now() - budgetStartedAt;
    check('a stalled stream is closed within the request budget, not twice it',
        budgetStream.status === 200 && budgetElapsed < 5000,
        `${budgetElapsed}ms, status ${budgetStream.status}`);
    check('the exhausted budget is reported to the client instead of a truncated answer',
        /"error"/.test(budgetStream.text), budgetStream.text.slice(-160));
    stopGateway(budgetGateway);
    await waitForExit(budgetGateway);
    stop(budgetStub);
    await waitForExit(budgetStub);

    // --- the backend child does not inherit the gateway's key, and its jail is private --------------------
    // The child is an agent runtime that, with tools enabled, executes model-directed work: it must not receive the
    // credential that guards this gateway, and its working directory (its HOME with USE_ISOLATED_HOME) must not be
    // readable by other local users on a shared /tmp.
    if (process.platform !== 'win32') {
        const childEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-childenv-'));
        const childDumpFile = path.join(childEnvDir, 'dump.json');
        const childCli = path.join(childEnvDir, 'opencode');
        fs.writeFileSync(childCli, [
            '#!/usr/bin/env node',
            "if (process.argv.includes('--version')) { process.stdout.write('1.19.5\\n'); process.exit(0); }",
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(childDumpFile)}, JSON.stringify({` +
                ' apiKey: process.env.API_KEY ?? null,' +
                ' mode: (fs.statSync(process.cwd()).mode & 0o777).toString(8),' +
                ' cwd: process.cwd() }));',
            'setInterval(() => {}, 1000);',
            ''
        ].join('\n'));
        fs.chmodSync(childCli, 0o755);
        // Accepts the probe and never answers, so the gateway has to spawn the CLI to get a backend
        const silentBackend = http.createServer(() => { });
        await new Promise((resolve) => silentBackend.listen(GATEWAY_PORT + 28, '127.0.0.1', resolve));
        const childEnvDriverPort = GATEWAY_PORT + 27;
        const childEnvDriver = spawn(process.execPath, ['--input-type=module', '-e', [
            "import { startProxy } from './src/proxy.js';",
            `const proxy = startProxy({ PORT: ${childEnvDriverPort}, API_KEY: 'sk-inherited-only',` +
                ` OPENCODE_SERVER_URL: 'http://127.0.0.1:${GATEWAY_PORT + 28}',` +
                ` OPENCODE_PATH: ${JSON.stringify(childCli)}, LOG_LEVEL: 'error' });`,
            'const fs = await import(\'node:fs\');',
            // The CLI writes its dump as soon as it is spawned, which happens after the health probe gives up (2 s):
            // poll for it instead of guessing a delay
            `const dumpPath = ${JSON.stringify(childDumpFile)};`,
            "let dumped = 'missing';",
            'for (let i = 0; i < 100; i += 1) {',
            '    if (fs.existsSync(dumpPath)) { dumped = fs.readFileSync(dumpPath, \'utf8\'); break; }',
            '    await new Promise((r) => setTimeout(r, 100));',
            '}',
            "process.stdout.write('DUMP:' + dumped + '\\n');",
            'await proxy.killBackend();',
            'process.exit(0);',
            ''
        ].join('\n')], {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, API_KEY: 'sk-inherited-only' }
        });
        children.push(childEnvDriver);
        let childEnvOut = '';
        let childEnvErr = '';
        childEnvDriver.stdout.on('data', (chunk) => { childEnvOut += chunk; });
        childEnvDriver.stderr.on('data', (chunk) => { childEnvErr += chunk; });
        // Not waitForExit(): that helper SIGKILLs after 3 s, and this driver has to wait for a health probe to time out
        // (2 s) before the backend is spawned at all.
        const childEnvExit = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                childEnvDriver.kill('SIGKILL');
                resolve('timeout');
            }, 20000);
            childEnvDriver.once('exit', (code) => {
                clearTimeout(timer);
                resolve(code);
            });
        });
        await new Promise((resolve) => silentBackend.close(resolve));
        const dumpLine = childEnvOut.split('\n').find((line) => line.startsWith('DUMP:')) || '';
        let dump = null;
        try {
            dump = JSON.parse(dumpLine.slice('DUMP:'.length));
        } catch {
            dump = null;
        }
        check('the spawned backend does not inherit the gateway API key',
            dump !== null && dump.apiKey === null,
            `${dumpLine.slice(0, 160)} | exit ${childEnvExit} | ${childEnvErr.slice(0, 200)}`);
        check('the backend jail directory is not readable by other users',
            dump !== null && dump.mode === '700', `${dump ? dump.mode : 'no dump'} (${dump ? dump.cwd : ''})`);
        fs.rmSync(childEnvDir, { recursive: true, force: true });
    }
}

// --- a stop request leaves no backend behind ---------------------------------------------------------------
// killBackend() is what the entry point awaits before exiting, so it has to mean "no backend is running, and none
// will start": a start attempt that was still inside its health probe used to spawn `opencode serve` after
// killBackend() had already resolved, so the child outlived the gateway it belongs to and kept the backend port.
// The CLI here is a stand-in that records its pid, and the backend URL points at a server that accepts connections
// and never answers, which is exactly the window the shutdown lands in. The driver imports startProxy() so the stop
// can be observed without exiting the process, as a library embedder would do it.
if (process.platform !== 'win32') {
    const shutdownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-stop-'));
    const pidFile = path.join(shutdownDir, 'child.pid');
    const fakeCli = path.join(shutdownDir, 'opencode');
    fs.writeFileSync(fakeCli, [
        '#!/usr/bin/env node',
        "if (process.argv.includes('--version')) { process.stdout.write('1.19.5\\n'); process.exit(0); }",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        'setInterval(() => {}, 1000);',
        ''
    ].join('\n'));
    fs.chmodSync(fakeCli, 0o755);
    // Accepts the probe's connection and never answers, so checkHealth stays inside that connection for its timeout
    const silent = http.createServer(() => { });
    await new Promise((resolve) => silent.listen(GATEWAY_PORT + 8, '127.0.0.1', resolve));
    const driverPort = GATEWAY_PORT + 9;
    const driverSource = [
        "import { startProxy } from './src/proxy.js';",
        `const proxy = startProxy({ PORT: ${driverPort}, API_KEY: 'stop-key', OPENCODE_SERVER_URL: 'http://127.0.0.1:${GATEWAY_PORT + 8}', OPENCODE_PATH: ${JSON.stringify(fakeCli)}, LOG_LEVEL: 'error' });`,
        'await new Promise((r) => setTimeout(r, 300));',
        'await proxy.killBackend();',
        "process.stdout.write('stopped\\n');",
        'await new Promise((r) => setTimeout(r, 3000));',
        'process.exit(0);',
        ''
    ].join('\n');
    const driver = spawn(process.execPath, ['--input-type=module', '-e', driverSource], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let driverOut = '';
    driver.stdout.on('data', (chunk) => { driverOut += chunk; });
    driver.stderr.on('data', () => { });
    const driverExit = await new Promise((resolve) => driver.once('exit', (code) => resolve(code)));
    const spawnedPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;
    if (spawnedPid) {
        try { process.kill(spawnedPid, 'SIGKILL'); } catch (e) { }
    }
    check('killBackend() resolves after the stop', driverOut.includes('stopped') && driverExit === 0,
        `exit ${driverExit}, output ${JSON.stringify(driverOut.trim())}`);
    check('a start attempt in flight spawns no backend once the gateway is stopping', spawnedPid === null,
        `spawned pid ${spawnedPid}`);
    await new Promise((resolve) => silent.close(resolve));
    fs.rmSync(shutdownDir, { recursive: true, force: true });

// --- a closed log reader does not take the gateway down ---------------------------------------------------
// `node index.js | head -3`, a log shipper that restarts, `docker logs` closing mid-write: the next write emits EPIPE
// on stdout, an unhandled stream 'error' is thrown as an uncaught exception, and it killed a gateway that was still
// serving. Destroying the read end of the child's stdout is exactly that pipe closing.
// The main stub is long gone by this point, so this needs a backend of its own
const pipeStubPort = GATEWAY_PORT + 22;
const pipeStub = spawn(process.execPath, ['test/stub-opencode.mjs'], {
    cwd: ROOT,
    env: { ...process.env, STUB_PORT: String(pipeStubPort) }
});
children.push(pipeStub);
pipeStub.stdout.on('data', () => {});
pipeStub.stderr.on('data', () => {});
await waitForOk(`http://127.0.0.1:${pipeStubPort}/health`);
const pipePort = GATEWAY_PORT + 21;
const pipeGateway = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: {
        ...process.env,
        PORT: String(pipePort),
        BIND_HOST: '127.0.0.1',
        OPENCODE_SERVER_URL: `http://127.0.0.1:${pipeStubPort}`,
        LOG_LEVEL: 'info'
    }
});
children.push(pipeGateway);
pipeGateway.stdout.on('data', () => {});
pipeGateway.stderr.on('data', () => {});
await waitForOk(`http://127.0.0.1:${pipePort}/health`);
pipeGateway.stdout.destroy();
await sleep(400);
const afterClosedPipe = await fetch(`http://127.0.0.1:${pipePort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30000)
}).then((r) => r.text().then((body) => ({ status: r.status, body })))
    .catch((error) => ({ status: 0, body: error.message }));
check('a closed log pipe does not stop the gateway',
    afterClosedPipe.status === 200 && afterClosedPipe.body.includes(ANSWER),
    `status ${afterClosedPipe.status} ${afterClosedPipe.body.slice(0, 120)}`);

// Warnings and errors go to stderr, so a closed reader there is the same class of failure; the request below is a
// rejected body (400), which logs a warning on that stream before the gateway answers
pipeGateway.stderr.destroy();
await sleep(400);
const rejectedWhileSilent = await fetch(`http://127.0.0.1:${pipePort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 5, content: 'hi' }] }),
    signal: AbortSignal.timeout(30000)
}).then((r) => r.status).catch(() => 0);
const afterClosedErrorPipe = await fetch(`http://127.0.0.1:${pipePort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30000)
}).then((r) => r.text().then((body) => ({ status: r.status, body })))
    .catch((error) => ({ status: 0, body: error.message }));
check('a closed error pipe does not stop the gateway',
    rejectedWhileSilent === 400 && afterClosedErrorPipe.status === 200 && afterClosedErrorPipe.body.includes(ANSWER),
    `rejected ${rejectedWhileSilent}, next ${afterClosedErrorPipe.status} ${afterClosedErrorPipe.body.slice(0, 120)}`);
stopGateway(pipeGateway);
await waitForExit(pipeGateway);
stop(pipeStub);
await waitForExit(pipeStub);
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
