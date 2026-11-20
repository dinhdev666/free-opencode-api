/**
 * Boolean option parsing, shared by the entry point and `startProxy()`, so the two cannot disagree about what
 * `DISABLE_TOOLS=yes` means.
 *
 * `parseBoolean()` is the single parser in the project: two implementations of that rule drifted once
 * (`-e DISABLE_TOOLS=yes` meant "off" in the container), so no third one is added. It stays silent on purpose - it also
 * runs on request bodies, where an unreadable `stream` is a `400` the route handler builds and a warning would be wrong.
 * `readFlag()` is the reporting wrapper for configuration, where a value nobody could read must be named together with
 * the value actually used: a silent fallback is how a `DISABLE_TOOLS` typo left `<function_calls>` markup in the answer
 * while the operator believed it was filtered out.
 */
import { loggableConfigValue } from './text.js';
import { logger } from './logger.js';

// The accepted spellings, module scope so a call does not rebuild them: `parseBoolean()` runs several times per
// completion (a request body's `stream`, `stream_options.include_usage`, and the read that validates each one).
const TRUE_SPELLINGS = ['1', 'true', 'yes', 'y', 'on'];
const FALSE_SPELLINGS = ['0', 'false', 'no', 'n', 'off'];

/**
 * Parse a boolean option written as a boolean, a string or a number.
 *
 * A **number** is a switch only when it is exactly `1` or `0`. Returning `value === 1` for every number made `2`, `-1`
 * and `1.5` mean `false` instead of "unreadable", so the rule the string branch follows (report it, or refuse the
 * field) depended on the JSON type a client or a config file happened to use: `{"stream": 2}` was served as JSON for a
 * client parsing SSE, and a numeric `DISABLE_TOOLS: 2` in `config.json` left the tool filter off with no warning.
 * @param {*} value raw value
 * @param {boolean} [fallback] returned for anything that is not a spelling this function knows
 * @returns {boolean|undefined} the parsed value, or `fallback` when the value cannot be read
 */
export function parseBoolean(value, fallback = undefined) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
        return fallback;
    }
    if (typeof value === 'string') {
        // The longest accepted spelling is five characters, so a value over 64 characters is rejected before it is
        // trimmed or lowercased: a request body is bounded by `OPENCODE_PROXY_MAX_BODY_MB`, and `{"stream": "aaaa…"}`
        // (50 MiB) was copied and lowercased twice per completion - 10 ms per call on the single serving thread, ~100 MB
        // of garbage - to answer a question the length already answers. The handler parses each field **once** now and
        // derives both its validation answer and its value from that one call.
        const trimmed = value.length > 64 ? '' : value.trim();
        if (!trimmed) return fallback;
        const normalized = trimmed.toLowerCase();
        if (TRUE_SPELLINGS.includes(normalized)) return true;
        if (FALSE_SPELLINGS.includes(normalized)) return false;
    }
    return fallback;
}

/**
 * A boolean option read from the environment or `config.json`, with the rule the numeric tuning keys follow: a value
 * that is present but cannot be read is named together with the value actually used, instead of falling back in
 * silence. `DISABLE_TOOLS: "maybe"` (or `OPENCODE_PROXY_DEBUG=ture`) used to leave the feature off while the operator
 * believed it was on - and for `DISABLE_TOOLS` that means the model's `<function_calls>` markup reaches the client,
 * which is exactly what the switch exists to hide.
 * @param {string} label the name the operator used (`config.json DISABLE_TOOLS`, or the variable)
 * @param {*} value raw value
 * @param {boolean} fallback used when the value is absent or unreadable
 * @returns {boolean}
 */
export function readFlag(label, value, fallback) {
    const parsed = parseBoolean(value, undefined);
    if (parsed !== undefined) return parsed;
    if (value === undefined || value === null) return fallback;
    const shown = String(value).trim();
    if (shown === '') return fallback;
    // The value is operator input and the line is one log record: control characters out, length bounded
    logger.warn(
        `[Config] ${label}='${loggableConfigValue(shown)}' is not a boolean ` +
        `(use true/false, yes/no, on/off or 1/0), using ${fallback}`
    );
    return fallback;
}