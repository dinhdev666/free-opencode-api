/**
 * Reading the gateway's tuning keys through the documented precedence: an explicit embedder option, then the
 * environment, then `config.json`, then the built-in default.
 *
 * The resolvers are pure reads with no state of their own - the values they produce are held by the modules that use
 * them (`src/proxy.js` for the queue, the body limit and the request budget) - which is what lets `startProxy()` resolve
 * them a second time from the merged configuration without two copies of the rule drifting apart.
 *
 * Every reader here returns the default for a value it cannot use, and the caller names the value it fell back from: a
 * silent fallback is the failure `readLimit()` was written to end for the queue knobs, where an operator who typo'd the
 * request budget had nothing to notice while the gateway kept using 300000 ms.
 */
import { loggableConfigValue } from './text.js';

// The default completion budget. It is a named constant because the timeout message quotes it: the sentence a client
// reads has to name the number that is actually in force.
export const DEFAULT_REQUEST_TIMEOUT_MS = 300000;

// The largest delay `setTimeout` (and `AbortSignal.timeout`, which arms one internally) accepts. A millisecond value
// above it does not wait longer: Node warns `TimeoutOverflowWarning` and fires the timer after 1 ms, so every completion
// answered `504` in ~13 ms with a budget the operator believed was in force. Values are clamped rather than dropped, so
// "as long as possible" stays expressible.
export const MAX_TIMER_MS = 2 ** 31 - 1;

// Metadata calls (the model list, the provider list) are cheap round trips, so their budget is capped well below the
// request budget: a client listing models should get the static fallback quickly instead of waiting for a whole
// completion to time out.
export const METADATA_TIMEOUT_CAP_MS = 10000;

/**
 * Read an integer limit through the precedence (environment, then `config.json`, then the default).
 *
 * A value that cannot be used must not look like it took effect: an operator who raises `OPENCODE_PROXY_MAX_CONCURRENCY`
 * (a throughput knob) and sees no change has no way to tell a typo from a clamp, so every adjustment is returned as a
 * note for the startup summary instead of being applied in silence.
 * @param {string} name the environment variable
 * @param {{min: number, max: number, fallback: number}} bounds and the default
 * @param {*} fileValue the value read from `config.json`
 * @returns {{value: number, note: string|null}} the value in force and the `[Config]` note, if it had to be adjusted
 */
export function readLimit(name, { min, max, fallback }, fileValue) {
    const fromEnv = process.env[name];
    const raw = (fromEnv === undefined || String(fromEnv).trim() === '') ? fileValue : fromEnv;
    if (raw === undefined || raw === null || String(raw).trim() === '') return { value: fallback, note: null };
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return { value: fallback, note: `${name}='${loggableConfigValue(raw)}' is not a number, using ${fallback}` };
    }
    const floored = Math.floor(parsed);
    if (floored < min) return { value: min, note: `${name}=${floored} is below the minimum ${min}, using ${min}` };
    if (floored > max) return { value: max, note: `${name}=${floored} is above the maximum ${max}, using ${max}` };
    return { value: floored, note: null };
}

/**
 * A millisecond budget written as a string or a number, clamped to what a timer can wait for.
 *
 * How long a successful health probe is trusted before the next one (0 disables the cache), and the start-retry
 * cooldown, are read through this. Both are resolved again by `startProxy()` from the merged configuration, so a value
 * in `config.json` is honoured and not silently ignored - the README documents every tuning key as
 * env > `config.json` > default.
 *
 * Returns a `{value, note}` pair rather than the bare number, for the reason `readLimit()` does: an unusable value has
 * to be named, and naming it at the call site meant re-implementing the precedence that this reader is the single copy
 * of - the warning compared `options.X ?? process.env.X` while the reader prefers the environment, so an invalid
 * environment variable was dropped without a note and a valid one was reported under the file's spelling.
 * @param {string} name the variable name, for a reader of the source and for the note
 * @param {number} fallback used when the value is absent, blank or unusable
 * @param {*} fileValue the value read from `config.json`
 * @param {{allowZero?: boolean}} [options] `allowZero` accepts `0` as a value in its own right. It exists for a window
 *   that is *disabled* by zero (`OPENCODE_PROXY_HEALTH_CACHE_MS=0` is documented as "probe on every request"), where
 *   rejecting it sent the operator the most trusting default instead of the least: a cache window of zero is a
 *   meaningful setting, while a timeout of zero is a typo and is still named and replaced.
 * @returns {{value: number, note: string|null}} the value in milliseconds and the `[Config]` note, if it had to be adjusted
 */
export function readMilliseconds(name, fallback, fileValue, options = {}) {
    const fromEnv = process.env[name];
    // The raw value that was actually used, so a note names the one that took effect rather than the other source.
    const raw = (fromEnv === undefined || String(fromEnv).trim() === '') ? fileValue : fromEnv;
    if (raw === undefined || raw === null || String(raw).trim() === '') return { value: fallback, note: null };
    const shown = loggableConfigValue(String(raw).trim());
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return { value: fallback, note: `${name}='${shown}' is not a number, using ${fallback}` };
    }
    // Floored before the sign test, like every other reader: a value below one millisecond is a typo (a budget written
    // as seconds), and flooring it after the test armed a 0 ms timer that fires after 1 ms - the failure this module
    // exists to name. Each unusable shape is named for what is wrong with it, because "not a number" sent a reader
    // looking for a letter in a value whose only sin was the decimal point.
    const floored = Math.floor(parsed);
    if (parsed < 0 || floored < 0) {
        return { value: fallback, note: `${name}='${shown}' is negative, using ${fallback}` };
    }
    if (floored === 0) {
        // A window that zero *disables* keeps it: see the `allowZero` note above. No note, because nothing was adjusted.
        if (options.allowZero) return { value: 0, note: null };
        return {
            value: fallback,
            note: `${name}='${shown}' is less than one millisecond, using ${fallback}`
        };
    }
    // Longer than a timer can wait: clamp, and say so. The clamp is silent in the safe direction (a shorter wait, never
    // a timer that fires early), but `resolveRequestTimeoutMs()` names its own clamp and this module's contract is that
    // an unusable value is named - a budget 100x the ceiling otherwise took effect as `MAX_TIMER_MS` with no `[Config]`
    // line at all, and the operator had no way to tell the value was read.
    if (floored > MAX_TIMER_MS) {
        return {
            value: MAX_TIMER_MS,
            note: `${name}='${shown}' is above the maximum ${MAX_TIMER_MS} (the largest timer), using ${MAX_TIMER_MS}`
        };
    }
    return { value: floored, note: null };
}

/**
 * The completion budget (`OPENCODE_PROXY_REQUEST_TIMEOUT_MS`), resolved through the documented precedence:
 * an explicit embedder option, then the environment, then `config.json`, then the default.
 *
 * A blank environment value counts as **unset**, the rule every other key follows (`envOrFile()` in `src/config.js`,
 * `readLimit()` and `readMilliseconds()` here): `??` treats `''` as a value, so a unit file's
 * `Environment=OPENCODE_PROXY_REQUEST_TIMEOUT_MS=`, a Helm value rendered empty or a shell that exports unconditionally
 * ended the chain at the empty string and the gateway ran the default while the value in `config.json` was never read -
 * silently, because the "unusable value" warning is skipped for a blank one too. A value that is present and unusable
 * is still named in `note`, so the operator sees what was used.
 * @param {object} options options handed to `startProxy()` (an explicit `REQUEST_TIMEOUT_MS` wins)
 * @param {object} env environment to read, injectable so the precedence can be tested without mutating `process.env`
 * @returns {{ value: number, note: string | null }} the budget in milliseconds and a `[Config]` note, if any
 */
export function resolveRequestTimeoutMs(options = {}, env = process.env) {
    const fromEnv = env?.OPENCODE_PROXY_REQUEST_TIMEOUT_MS;
    const fromFile = options.OPENCODE_PROXY_REQUEST_TIMEOUT_MS;
    const fileIsUsable = fromFile !== undefined && fromFile !== null && String(fromFile).trim() !== '';
    // Environment first, but only when it actually carries a value
    const requested = (fromEnv === undefined || String(fromEnv).trim() === '')
        ? (fileIsUsable ? fromFile : undefined)
        : fromEnv;
    const embedder = options.REQUEST_TIMEOUT_MS;
    const embedderIsUsable = embedder !== undefined && embedder !== null && String(embedder).trim() !== '';
    const chosen = embedderIsUsable ? embedder : requested;
    const parsed = Number(chosen);
    // Floor before the positivity test, not after: a fractional budget below one millisecond (`0.5` - a value written
    // as seconds, or a typo) floored to `0` after the test, which armed every deadline at 1 ms and answered every
    // completion `504` with no `[Config]` note. The test is on the floored value, so a sub-millisecond number takes
    // the "not a positive number" note and the documented default, like every other unusable value.
    const floored = Math.floor(parsed);
    if (Number.isFinite(parsed) && floored > 0) {
        if (floored <= MAX_TIMER_MS) return { value: floored, note: null };
        // Longer than a timer can wait: clamp instead of arming a timer that fires after 1 ms
        return {
            value: MAX_TIMER_MS,
            note: `OPENCODE_PROXY_REQUEST_TIMEOUT_MS=${floored} is above the maximum ${MAX_TIMER_MS} (the largest timer), using ${MAX_TIMER_MS}`
        };
    }
    const blank = chosen === undefined || chosen === null || String(chosen).trim() === '';
    if (blank) return { value: DEFAULT_REQUEST_TIMEOUT_MS, note: null };
    return {
        value: DEFAULT_REQUEST_TIMEOUT_MS,
        note: `OPENCODE_PROXY_REQUEST_TIMEOUT_MS='${loggableConfigValue(String(chosen).trim())}' is not a positive number, using ${DEFAULT_REQUEST_TIMEOUT_MS}`
    };
}

/**
 * A deadline for one SDK call, so no single phase can outlive the request it belongs to.
 *
 * A wedged backend - one that still answers `/health` but never answers `/session` - used to hang the request handler
 * forever: node's fetch has no default timeout, so the SDK promise never settled, the client waited with no answer and
 * the queue slot was never released (at the default concurrency of 1 that stops the whole gateway).
 * @param {number} timeoutMs
 * @returns {{signal: AbortSignal}}
 */
export const backendDeadline = (timeoutMs) => ({ signal: AbortSignal.timeout(timeoutMs) });