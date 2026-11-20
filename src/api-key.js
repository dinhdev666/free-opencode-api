/**
 * The key a client must present.
 *
 * Authentication is mandatory by design: when `API_KEY` is missing or blank the gateway falls back to a built-in key
 * instead of running without authentication. There is deliberately no "disable auth" switch, and an empty key never
 * means "no auth" - `index.js` logs a `[Security]` warning while the built-in key is in force.
 */

// The built-in key: authentication stays enforced with it, and `index.js` warns that it is public knowledge.
export const DEFAULT_API_KEY = 'sk-dummy-123';

/**
 * The key the gateway enforces: the configured one, or the built-in default when it is absent or blank.
 * @param {*} value the configured `API_KEY`
 * @returns {string} a non-empty key, so authentication can never be switched off by configuration
 */
export const resolveApiKey = (value) => {
    const key = value === undefined || value === null ? '' : String(value).trim();
    return key || DEFAULT_API_KEY;
};