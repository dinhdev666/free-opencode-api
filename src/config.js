import fs from 'fs';
import { loggableConfigValue } from './text.js';

// A config.json is a handful of scalars. Reading an arbitrarily large "config" into memory at startup is one
// misplaced file away from an out-of-memory crash, and a FIFO blocks the read forever, so the file is bounded and has
// to be a regular file.
const MAX_CONFIG_BYTES = 1024 * 1024;

// Keys the entry point reads as **text**. A value of the wrong type is refused instead of coerced: `resolveApiKey()` on
// a boolean `true` turns the gateway's credential into the literal string "true" (guessable by every client, while the
// startup summary still reports "custom - authentication always enforced"), and a nested object becomes
// "[object Object]". So a mis-typed key has to stop the start, exactly like a file that is not valid JSON.
//
// A number is not text here. Accepting one let `{"OPENCODE_PATH": 5}` through validation and then threw
// `(requestedPath || "").trim is not a function` out of `resolveOpencodePath()` - after the port had been bound, as a
// fatal start error naming an internal expression instead of the key the operator wrote. `PORT` and the tuning keys are
// the ones a number legitimately spells, and they are listed separately below.
const STRING_KEYS = [
    'API_KEY',
    'BIND_HOST',
    'OPENCODE_BIND_HOST',
    'OPENCODE_SERVER_URL',
    'OPENCODE_SERVER_PASSWORD',
    'OPENCODE_PATH',
    'LOG_LEVEL'
];
const NUMBER_KEYS = [
    'PORT',
    'OPENCODE_PROXY_MAX_CONCURRENCY',
    'OPENCODE_PROXY_MAX_QUEUE',
    'OPENCODE_PROXY_MAX_BODY_MB',
    'OPENCODE_PROXY_REQUEST_TIMEOUT_MS',
    'OPENCODE_PROXY_HEALTH_CACHE_MS',
    'OPENCODE_PROXY_START_RETRY_MS'
];
const STRING_OR_NUMBER_KEYS = [...STRING_KEYS, ...NUMBER_KEYS];
// Flags are parsed by parseBoolean(), which accepts booleans as well as their string/number spellings.
// `OPENCODE_PROXY_DEBUG` is deliberately absent: it is an environment name (the file key is `DEBUG`) and nothing reads
// it from the file, so listing it here made a file entry a known key that did nothing at all - exactly the silent
// no-op the unknown-key check exists to prevent.
const FLAG_KEYS = ['DISABLE_TOOLS', 'USE_ISOLATED_HOME', 'DEBUG'];

// Every key the entry point reads. A key outside this list is reported and ignored: a typo (`APIKEY`,
// `OPENCODE_PROXY_MAX_CONCURENCY`) used to change nothing at all, and the gateway then ran the default while the
// operator was sure the value in the file was in force - the same silent fallback the `[Config]` warnings for an
// unusable limit exist to prevent. Nothing is merged generically, so an unknown key cannot reach the running config.
// Exported for the smoke suite and `config.json.example`: the same list is documented in the README and repeated by
// docker/docker-entrypoint.sh for the file it writes, and a key that reaches only one of those places is a setting the
// operator believes is in force while the gateway runs the default. Frozen so a reader cannot edit the running list.
export const CONFIG_FILE_KEYS = Object.freeze([...STRING_OR_NUMBER_KEYS, ...FLAG_KEYS]);
const KNOWN_KEYS = new Set(CONFIG_FILE_KEYS);

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

// The name of the file type a symlink has: one constant, because two places report it - `describeFileType()` for a
// link that somehow survives the open (a platform without O_NOFOLLOW, or a link to a link), and the ELOOP the
// O_NOFOLLOW open actually raises on every platform that has the flag.
const SYMLINK_TYPE = 'a symbolic link';

function describeFileType(stat) {
    if (stat.isDirectory()) return 'a directory';
    if (stat.isSymbolicLink()) return SYMLINK_TYPE;
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
    // O_NOFOLLOW makes a symlink a refusal instead of a read: `config.json -> /etc/shadow` used to be followed, and
    // the JSON-parse failure below quotes the file's own bytes into the message, so the gateway printed the contents of
    // whatever the link pointed at. It is absent on Windows (and on any runtime that does not define it), where the
    // fallback is 0 - plain O_RDONLY - so the flag list stays readable and the behaviour degrades to the previous one
    // rather than to a startup crash.
    //
    // O_NONBLOCK is the other half of the FIFO rule. A stat-then-read pair never opened a FIFO, so it was named
    // without ever being touched; an O_RDONLY open of a FIFO blocks until a writer appears, which at import time in
    // index.js is a hang no signal handler can reach. With O_NONBLOCK the open returns immediately, fstatSync sees the
    // FIFO, and the "not a regular file" refusal below is the answer. It has no effect on a regular file.
    const openFlags = fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW === undefined ? 0 : fs.constants.O_NOFOLLOW)
        | (fs.constants.O_NONBLOCK === undefined ? 0 : fs.constants.O_NONBLOCK);

    let fd;
    try {
        fd = fs.openSync(configPath, openFlags);
    } catch (e) {
        if (e.code === 'ENOENT') return { config: {}, error: null };
        // ELOOP is the O_NOFOLLOW open refusing a symlink; EISDIR is the one platform that refuses a directory at
        // open() instead of handing back a descriptor. Both are the "not a regular file" answer, not a startup crash.
        if (e.code === 'ELOOP') return { config: {}, error: `must be a regular file, found ${SYMLINK_TYPE}` };
        if (e.code === 'EISDIR') return { config: {}, error: 'must be a regular file, found a directory' };
        return { config: {}, error: `cannot be read: ${e.message}` };
    }

    let raw;
    try {
        // fstatSync on the descriptor just opened, so the object that is checked is the object that is read - there is
        // no path left to swap between the two syscalls.
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return { config: {}, error: `must be a regular file, found ${describeFileType(stat)}` };
        if (stat.size > MAX_CONFIG_BYTES) {
            return { config: {}, error: `is ${stat.size} bytes, the maximum is ${MAX_CONFIG_BYTES}` };
        }
        // Reading by descriptor is still unbounded - the file can have grown since fstatSync, and nothing about a
        // descriptor freezes its size - so the text is cut to one character past the limit and the refusal below is
        // repeated off the string length. The hot path this runs on is a single startup read, so the spare copy is
        // cheaper than a second stat that could be stale too.
        raw = fs.readFileSync(fd, 'utf8');
        if (raw.length > MAX_CONFIG_BYTES) raw = raw.slice(0, MAX_CONFIG_BYTES + 1);
        if (raw.length > MAX_CONFIG_BYTES) {
            return { config: {}, error: `is more than ${MAX_CONFIG_BYTES} bytes, the maximum is ${MAX_CONFIG_BYTES}` };
        }
    } catch (e) {
        // A file removed after it was opened cannot happen through this descriptor, but ENOENT from the read is still
        // the same "no config.json" answer as a missing file - not a startup failure.
        if (e.code === 'ENOENT') return { config: {}, error: null };
        return { config: {}, error: `cannot be read: ${e.message}` };
    } finally {
        // Every return above leaves through here, so no error path leaks the descriptor.
        fs.closeSync(fd);
    }

    // A UTF-8 BOM is what a Windows editor or PowerShell 5.1 writes: JSON.parse rejects the first character of a file
    // that is otherwise valid, and the reported error ("Unexpected token '﻿'") shows the operator nothing to fix.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        // V8 embeds a raw source snippet in its `JSON.parse` message (`Unexpected token 's', ..."API_KEY": sk-SECR...`),
        // so quoting the message verbatim printed the first ~18 characters of the offending line - including the
        // operator's own key or `OPENCODE_SERVER_PASSWORD` when it was written unquoted - and a snippet carrying a raw
        // newline split one `[Config]` record into several. The snippet always follows the parser's own clause and is
        // delimited by a double quote, so everything from the first `"` is dropped; the useful part (the wording and the
        // position) is kept, and it is bound and control-character cleaned like every other `[Config]` sentence.
        const snippetAt = String(e.message).indexOf('"');
        const withoutSnippet = (snippetAt === -1 ? String(e.message) : String(e.message).slice(0, snippetAt))
            .replace(/,?\s*\.\.\.\s*$/, '')
            .replace(/,\s*$/, '')
            .trim();
        return { config: {}, error: `is not valid JSON: ${loggableConfigValue(withoutSnippet)}` };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { config: {}, error: `must contain a JSON object, found ${describeType(parsed)}` };
    }

    for (const key of STRING_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
        const value = parsed[key];
        if (typeof value === 'string') continue;
        return { config: {}, error: `${key} must be a string, found ${describeType(value)}` };
    }
    for (const key of NUMBER_KEYS) {
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
    // An empty value in `config.json` is as unusable as an empty variable, and it must not shadow the default either:
    // the container's entrypoint writes `OPENCODE_PATH: ""` when the image sets no path, and returning that empty
    // string here ended the chain (`??` catches only nullish), so a container that had always started failed with
    // "OPENCODE_PATH is not set".
    if (typeof fileValue === 'string' && fileValue.trim() === '') return undefined;
    return fileValue === undefined || fileValue === null ? undefined : fileValue;
}
