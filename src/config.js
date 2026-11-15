import fs from 'fs';

// A config.json is a handful of scalars. Reading an arbitrarily large "config" into memory at startup is one
// misplaced file away from an out-of-memory crash, and a FIFO blocks the read forever, so the file is bounded and has
// to be a regular file.
const MAX_CONFIG_BYTES = 1024 * 1024;

// Keys the entry point reads. A value of the wrong type is refused instead of coerced: `resolveApiKey()` on a boolean
// `true` turns the gateway's credential into the literal string "true" (guessable by every client, while the startup
// summary still reports "custom - authentication always enforced"), and a nested object becomes "[object Object]".
// So a mis-typed key has to stop the start, exactly like a file that is not valid JSON.
const STRING_OR_NUMBER_KEYS = [
    'API_KEY',
    'PORT',
    'BIND_HOST',
    'OPENCODE_BIND_HOST',
    'OPENCODE_SERVER_URL',
    'OPENCODE_PATH',
    'LOG_LEVEL',
    'OPENCODE_PROXY_MAX_CONCURRENCY',
    'OPENCODE_PROXY_MAX_QUEUE',
    'OPENCODE_PROXY_MAX_BODY_MB',
    'OPENCODE_PROXY_REQUEST_TIMEOUT_MS',
    'OPENCODE_PROXY_HEALTH_CACHE_MS',
    'OPENCODE_PROXY_START_RETRY_MS'
];
// Flags are parsed by parseBoolean(), which accepts booleans as well as their string/number spellings
const FLAG_KEYS = ['DISABLE_TOOLS', 'USE_ISOLATED_HOME', 'DEBUG', 'OPENCODE_PROXY_DEBUG'];

// Every key the entry point reads. A key outside this list is reported and ignored: a typo (`APIKEY`,
// `OPENCODE_PROXY_MAX_CONCURENCY`) used to change nothing at all, and the gateway then ran the default while the
// operator was sure the value in the file was in force - the same silent fallback the `[Config]` warnings for an
// unusable limit exist to prevent. Nothing is merged generically, so an unknown key cannot reach the running config.
const KNOWN_KEYS = new Set([...STRING_OR_NUMBER_KEYS, ...FLAG_KEYS]);

// Case and separators are what a typo usually gets wrong (`APIKEY`, `api-key`, `openCodePath`), so the suggestion
// compares the names with everything but the letters and digits removed
const keyShape = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The keys of a parsed config.json that the gateway does not read, with the known key each one most likely meant. Only
 * a case/separator difference is suggested: `OPENCODE_PROXY_MAX_CONCURENCY` is a misspelling the code cannot recognise
 * without guessing, and a wrong guess sends the reader to the wrong key.
 * @param {object} parsed parsed config.json value
 * @returns {{ key: string, suggestion: string | null }[]}
 */
export function findUnknownKeys(parsed) {
    const known = [...KNOWN_KEYS];
    return Object.keys(parsed || {})
        .filter((key) => !KNOWN_KEYS.has(key))
        .map((key) => {
            const shape = keyShape(key);
            const match = known.find((candidate) => keyShape(candidate) === shape);
            return { key, suggestion: match || null };
        });
}

function describeType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    return `a ${typeof value}`;
}

function describeFileType(stat) {
    if (stat.isDirectory()) return 'a directory';
    if (stat.isFIFO()) return 'a FIFO';
    if (stat.isSocket()) return 'a socket';
    if (stat.isCharacterDevice()) return 'a character device';
    if (stat.isBlockDevice()) return 'a block device';
    return 'not a regular file';
}

/**
 * Reads a `config.json` file for the entry point.
 *
 * Returns `{ config, error }`. A missing file is normal (`config` is empty and `error` is null), but a file that
 * exists and cannot be used is an error: continuing with defaults would silently ignore the port and the API key the
 * operator wrote, leaving the gateway running with the built-in dummy key instead of theirs.
 */
export function readConfigFile(configPath) {
    let raw;
    try {
        // statSync first, so a directory/FIFO/socket is named instead of surfacing as EISDIR or a read that never
        // returns. A file removed between the stat and the read reports ENOENT from readFileSync below, which is the
        // same "no config.json" answer as a missing file - not a startup failure.
        const stat = fs.statSync(configPath);
        if (!stat.isFile()) return { config: {}, error: `must be a regular file, found ${describeFileType(stat)}` };
        if (stat.size > MAX_CONFIG_BYTES) {
            return { config: {}, error: `is ${stat.size} bytes, the maximum is ${MAX_CONFIG_BYTES}` };
        }
        raw = fs.readFileSync(configPath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return { config: {}, error: null };
        return { config: {}, error: `cannot be read: ${e.message}` };
    }

    // A UTF-8 BOM is what a Windows editor or PowerShell 5.1 writes: JSON.parse rejects the first character of a file
    // that is otherwise valid, and the reported error ("Unexpected token '﻿'") shows the operator nothing to fix.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return { config: {}, error: `is not valid JSON: ${e.message}` };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { config: {}, error: `must contain a JSON object, found ${describeType(parsed)}` };
    }

    for (const key of STRING_OR_NUMBER_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
        const value = parsed[key];
        if (typeof value === 'string' || typeof value === 'number') continue;
        return { config: {}, error: `${key} must be a string or a number, found ${describeType(value)}` };
    }
    for (const key of FLAG_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
        const value = parsed[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') continue;
        return { config: {}, error: `${key} must be a string, a number or a boolean, found ${describeType(value)}` };
    }

    return { config: parsed, error: null };
}

// An environment variable that is present but blank means "not configured", the way an unset variable does: a unit
// file's `Environment=API_KEY=`, an empty Helm value or `API_KEY= npm start` in a shell. `PORT` and `API_KEY` were the
// two keys read with `??`, so a blank value shadowed config.json - the gateway listened on the default port and
// authenticated with the built-in public key while the file named a different port and a real secret (it warned about
// the key, but it had already stopped honouring the file). Every other key reads the environment with `||` or through
// a parser that ignores blanks; this is the one helper for the two that cannot.
export function envOrFile(env, name, fileValue) {
    const fromEnv = env?.[name];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
    if (typeof fromEnv === 'number') return fromEnv;
    return fileValue === undefined || fileValue === null ? undefined : fileValue;
}
