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
 * @param {string} name the variable name, for a reader of the source
 * @param {number} fallback used when the value is absent or not a number
 * @param {*} fileValue the value read from `config.json`
 * @returns {number}
 */
export const readMilliseconds = (name, fallback, fileValue) => {
    const fromEnv = process.env[name];
    const raw = (fromEnv === undefined || String(fromEnv).trim() === '') ? fileValue : fromEnv;
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.min(Math.floor(parsed), MAX_TIMER_MS);
};

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
    if (Number.isFinite(parsed) && parsed > 0) {
        const floored = Math.floor(parsed);
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
 * Whether a configured millisecond value is present but unusable, so the caller can name it and the value it used.
 * @param {*} value the configured value
 * @returns {boolean}
 */
export const isUnusableMilliseconds = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') return false;
    const parsed = Number(value);
    return !Number.isFinite(parsed) || parsed < 0;
};

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