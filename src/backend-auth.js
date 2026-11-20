/**
 * The credential this gateway presents to the OpenCode backend.
 *
 * Two hops carry a secret, and neither is optional: an OpenCode 2.x server authenticates every `/api/*` route with its
 * own password (`Authorization: Basic base64("opencode:<password>")`), and a proxy sitting *in front of* the backend may
 * authenticate the userinfo a configured `OPENCODE_SERVER_URL` carries. Node's `fetch` refuses a URL with credentials
 * out loud, so the userinfo is lifted out of the URL and travels as a header instead - which is also what such a proxy
 * reads.
 */
import { randomBytes } from 'crypto';
import { registerSensitiveValue } from './logger.js';

// The username an OpenCode 2.x server expects its password under. The server issues a password and authenticates
// `Authorization: Basic base64("opencode:<password>")`; a bare token, `Bearer`, or the password alone as the username are
// all refused with `401 {"_tag":"UnauthorizedError"}`. One constant, so the spawned child and every call cannot disagree
// about it.
export const BACKEND_AUTH_USERNAME = 'opencode';

/**
 * Build the Basic credential an OpenCode 2.x server accepts.
 *
 * The username is the one constant in this module, so the spawned child and every call cannot disagree about it: the
 * server authenticates `Authorization: Basic base64("opencode:<password>")`, and a bare token, `Bearer`, or the password
 * alone as the username are all refused with `401 {"_tag":"UnauthorizedError"}`.
 * @param {string} password the server password
 * @returns {string} the value for an `Authorization` header
 */
export function backendAuthorizationHeader(password) {
    return `Basic ${Buffer.from(`${BACKEND_AUTH_USERNAME}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Split a configured backend URL into the URL the SDK is given and the header that carries its credentials.
 *
 * `http://user:secret@host:4097` - a proxy in front of the backend - was documented as supported but could not work:
 * every SDK call goes through Node's `fetch`, which refuses a URL with credentials ("Request cannot be constructed from
 * a URL that includes credentials: …"), so every completion answered `502` and the runtime's message carried the secret
 * into that response body and into the error log. The userinfo is therefore removed from the URL (which is what the
 * masking in `maskBackendUrl()` already assumed the gateway was doing) and sent as a Basic `Authorization` header
 * instead.
 * @param {string} serverUrl normalised backend URL
 * @returns {{url: string, authorization: string|null}}
 */
export function resolveBackendAuth(serverUrl) {
    const raw = String(serverUrl);
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        // Not a URL the gateway can parse: leave it exactly as configured and let the caller report the failure
        return { url: raw, authorization: null };
    }
    if (!parsed.username && !parsed.password) return { url: raw, authorization: null };
    let user = parsed.username;
    let password = parsed.password;
    try {
        user = decodeURIComponent(user);
        password = decodeURIComponent(password);
    } catch {
        // Keep the percent-encoded form when it is not valid encoding (the credential is still well defined)
    }
    const scheme = `${parsed.protocol}//`;
    const authority = raw.slice(scheme.length).split(/[/?#]/)[0];
    const withoutUserInfo = `${scheme}${authority.slice(authority.lastIndexOf('@') + 1)}${raw.slice(scheme.length + authority.length)}`;
    const authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
    // The credential this process holds is masked by value wherever text leaves it, because
    // `maskQuotedCredentials()` needs 16 characters to tell a token from prose and this one can be 8.
    registerSensitiveValue(authorization.slice(authorization.indexOf(' ') + 1));
    registerSensitiveValue(`${user}:${password}`);
    return { url: withoutUserInfo, authorization };
}

/**
 * Resolve the OpenCode 2.x server password.
 *
 * A v2 server authenticates every `/api/*` route, so the gateway cannot drive one without its password. Two sources:
 *
 * - `OPENCODE_SERVER_PASSWORD` (env, or `config.json`) pins it. When the gateway spawns the child it passes the same
 *   value through `OPENCODE_SERVER_PASSWORD` in the child's environment, which is what the server itself reads - so a
 *   spawned child always accepts this process's credential.
 * - When nothing is configured, a random password is generated for this process. An *external* server then cannot be
 *   authenticated against (the operator must configure its password), but a spawned child always matches, because the
 *   child is handed the generated value.
 *
 * @param {object} options
 * @param {string} [options.configured] value from the environment or `config.json`
 * @param {boolean} [options.generate] whether a missing value may be generated (a spawned child can be matched)
 * @returns {{password: string, generated: boolean}}
 */
export function resolveBackendPassword(options = {}) {
    const configured = options.configured;
    if (typeof configured === 'string' && configured.trim() !== '') {
        const password = configured.trim();
        registerSensitiveValue(password);
        return { password, generated: false };
    }
    if (options.generate === false) {
        return { password: '', generated: false };
    }
    // 32 bytes of entropy, base64url-encoded: a token that survives being pasted into a URL, a unit file or a
    // container env without quoting. Long enough that a guessed value is not the interesting attack.
    const password = randomBytes(32).toString('base64url');
    registerSensitiveValue(password);
    return { password, generated: true };
}