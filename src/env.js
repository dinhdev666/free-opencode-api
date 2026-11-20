/**
 * Environment and filesystem resolution for the values an operator configures: `OPENCODE_PATH` (which binary to spawn)
 * and the addresses (`OPENCODE_SERVER_URL`, the bind hosts).
 *
 * Each rule here exists because the failure it prevents was silent: a configured path that does not exist falls back to
 * whatever `PATH` holds, a backend URL without a scheme turns every SDK call into a 404, a bind host with a trailing
 * space does not resolve at all. None of those may pass without a `[Config]` note naming the value that was corrected -
 * an operator reads the summary to copy the value out of it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger, maskBackendUrl } from './logger.js';
import { loggableConfigValue } from './text.js';

const OPENCODE_BASENAME = 'opencode';

/** Splits `PATH` into its entries (empty when the variable is unset). */
function splitPathEnv() {
    const raw = process.env.PATH || '';
    return raw.split(path.delimiter).filter(Boolean);
}

function pushDir(list, dir) {
    if (!dir) return;
    if (!list.includes(dir)) list.push(dir);
}

function pushExistingDir(list, dir) {
    if (!dir) return;
    if (!fs.existsSync(dir)) return;
    if (!list.includes(dir)) list.push(dir);
}

function addVersionedDirs(list, baseDir, subpath) {
    if (!baseDir || !fs.existsSync(baseDir)) return;
    let entries = [];
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (e) {
        return;
    }
    entries.forEach((entry) => {
        if (!entry.isDirectory()) return;
        const full = path.join(baseDir, entry.name, subpath || '');
        pushExistingDir(list, full);
    });
}

function prefixToBin(prefix) {
    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

function getOpencodeCandidateNames() {
    if (process.platform === 'win32') {
        return [`${OPENCODE_BASENAME}.cmd`, `${OPENCODE_BASENAME}.exe`, `${OPENCODE_BASENAME}.bat`, OPENCODE_BASENAME];
    }
    return [OPENCODE_BASENAME];
}

function findExecutableInDirs(dirs, names) {
    for (const dir of dirs) {
        for (const name of names) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) {
                return full;
            }
        }
    }
    return null;
}

// Resolving the value walks PATH and every known install location (`readdirSync` over the nvm/asdf/fnm trees), and it
// runs twice per start: the entry point's version probe asks, then the spawn asks. That printed the same "does not
// exist" warning twice and scanned twice, on a spawn that can also be retried. The answer is memoised per requested
// value for a minute - long enough to collapse one start and a restart loop, short enough that an installation made
// while the gateway is running is picked up without restarting it.
const RESOLVE_CACHE_TTL_MS = 60 * 1000;
let resolveCache = null;

/**
 * Resolves `OPENCODE_PATH` to the binary `spawnBackend()` will run (PATH, PATHEXT candidates, npm prefixes).
 *
 * Exported so the entry point's version probe asks the same question: probing the configured value answered "cannot
 * verify the installation" for a backend that had resolved perfectly well elsewhere, and the 2.x warning that names a
 * wrong major version never ran.
 * @param {string} requestedPath the configured value, or '' for a plain search
 * @returns {{path: string|null, source: 'config'|'PATH'|'known-locations'|'not-found'}}
 */
export function resolveOpencodePath(requestedPath) {
    const input = (requestedPath || '').trim();
    const now = Date.now();
    if (resolveCache && resolveCache.input === input && now - resolveCache.at < RESOLVE_CACHE_TTL_MS) {
        return resolveCache.value;
    }
    const value = searchOpencodePath(input);
    resolveCache = { input, at: now, value };
    return value;
}

/**
 * The search itself: the configured path when it names one, then `PATH`, then the package managers' and version
 * managers' install locations.
 * @param {string} input the trimmed configured value
 * @returns {{path: string|null, source: 'config'|'PATH'|'known-locations'|'not-found'}}
 */
function searchOpencodePath(input) {
    const names = getOpencodeCandidateNames();

    if (input) {
        const looksLikePath = path.isAbsolute(input) || input.includes('/') || input.includes('\\');
        if (looksLikePath) {
            if (fs.existsSync(input)) return { path: input, source: 'config' };
            const resolved = path.resolve(process.cwd(), input);
            if (fs.existsSync(resolved)) return { path: resolved, source: 'config' };
            // A configured path that does not exist is almost always a typo or a moved installation. Say so: the
            // PATH search below would otherwise hide it behind a binary the operator did not choose
            logger.warn(`[Proxy] OPENCODE_PATH '${loggableConfigValue(input)}' does not exist; using the OpenCode found on PATH instead`);
        }
    }

    const fromPath = findExecutableInDirs(splitPathEnv(), names);
    if (fromPath) return { path: fromPath, source: 'PATH' };

    const extraDirs = [];
    if (process.env.OPENCODE_HOME) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_HOME, 'bin'));
    }
    if (process.env.OPENCODE_DIR) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_DIR, 'bin'));
    }
    pushDir(extraDirs, prefixToBin(process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX));
    pushDir(extraDirs, process.env.PNPM_HOME);
    if (process.env.YARN_GLOBAL_FOLDER) {
        pushDir(extraDirs, path.join(process.env.YARN_GLOBAL_FOLDER, 'bin'));
    }
    if (process.env.VOLTA_HOME) {
        pushDir(extraDirs, path.join(process.env.VOLTA_HOME, 'bin'));
    }
    pushDir(extraDirs, process.env.NVM_BIN);
    pushDir(extraDirs, path.dirname(process.execPath));

    const home = os.homedir();
    if (home) {
        pushDir(extraDirs, path.join(home, '.opencode', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm', 'bin'));
        pushDir(extraDirs, path.join(home, '.pnpm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'share', 'pnpm'));
        pushDir(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1', 'installations'));
        pushDir(extraDirs, path.join(home, '.asdf', 'shims'));
    }

    if (process.platform === 'win32') {
        pushDir(extraDirs, process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null);
        pushDir(extraDirs, process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : null);
        pushDir(extraDirs, process.env.NVM_HOME);
        pushDir(extraDirs, process.env.NVM_SYMLINK);
        pushDir(extraDirs, process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : null);
        pushDir(extraDirs, process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs') : null);
    } else {
        pushDir(extraDirs, '/usr/local/bin');
        pushDir(extraDirs, '/usr/bin');
        pushDir(extraDirs, '/bin');
        pushDir(extraDirs, '/opt/homebrew/bin');
        pushDir(extraDirs, '/snap/bin');
    }

    // nvm (unix) versions
    const nvmDir = process.env.NVM_DIR || (home ? path.join(home, '.nvm') : null);
    if (nvmDir) {
        addVersionedDirs(extraDirs, path.join(nvmDir, 'versions', 'node'), 'bin');
    }

    // asdf nodejs installs
    const asdfDir = process.env.ASDF_DATA_DIR || (home ? path.join(home, '.asdf') : null);
    if (asdfDir) {
        addVersionedDirs(extraDirs, path.join(asdfDir, 'installs', 'nodejs'), 'bin');
    }

    // fnm installs
    if (home) {
        addVersionedDirs(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1'), 'installation' + path.sep + 'bin');
    }

    const fromExtras = findExecutableInDirs(extraDirs, names);
    if (fromExtras) return { path: fromExtras, source: 'known-locations' };

    return { path: null, source: 'not-found' };
}

/**
 * A bind address is handed to `net` verbatim, and surrounding whitespace is not a host: a unit file, a Compose value or
 * a rendered template that leaves a trailing space answered `getaddrinfo ENOTFOUND " 127.0.0.1"` and the gateway refused
 * to start - with the padded value in the summary as the only clue. Trimmed, with a `[Config]` note naming the value
 * that changed, the same rule `normalizeBackendUrl()` follows. `OPENCODE_PATH` is deliberately not trimmed: a path can
 * contain a space.
 * @param {string} label the name the operator used, for the note (`BIND_HOST`, `config.json BIND_HOST`, …)
 * @param {string} value the configured value
 * @returns {string} the trimmed value (empty when the value was blank, so the caller's default applies)
 */
export function normalizeBindHost(label, value) {
    const raw = value === undefined || value === null ? '' : String(value);
    const trimmed = raw.trim();
    if (trimmed && trimmed !== raw) {
        logger.warn(`[Config] ${label}='${loggableConfigValue(raw)}' has surrounding whitespace; using '${loggableConfigValue(trimmed)}'`);
    }
    return trimmed;
}

// True for the addresses whose traffic never leaves the host: `localhost`, the IPv4 loopback block, `::1` and the IPv6
// forms a URL parser produces for them (`[::1]` arrives without brackets from `new URL().hostname`).
export const isLoopbackHost = (host) => {
    const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!value) return false;
    if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
    if (value === '::ffff:127.0.0.1') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
};

/**
 * Normalise a configured backend URL: trim it, read a missing scheme as `http://`, and drop trailing slashes.
 *
 * A backend URL that ends in a slash makes every SDK call a path with a double slash (`//session`), which an OpenCode
 * server answers with 404: the gateway then looks like it cannot start its backend at all. Normalising the value once at
 * startup is cheaper than wondering why nothing works. Exported so the entry point can normalise before it prints the
 * startup summary: the summary is where an operator copies the value from, and it used to show the raw form - a trailing
 * slash or a trailing space the gateway never used - right beside a note saying it was corrected.
 * @param {*} raw the configured `OPENCODE_SERVER_URL`
 * @returns {{url: string, notes: string[]}} the usable URL and the `[Config]` notes for what was corrected
 */
export function normalizeBackendUrl(raw) {
    let url = String(raw || '').trim();
    const notes = [];
    if (url === '') return { url: 'http://127.0.0.1:4097', notes };
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
        notes.push(`OPENCODE_SERVER_URL='${maskBackendUrl(url)}' has no scheme, assuming http://`);
        url = `http://${url}`;
    }
    // Only trailing slashes: `http://host:4097//` is one mistake repeated, and stripping them all is the same repair.
    const stripped = url.replace(/\/+$/, '');
    if (stripped !== url) {
        notes.push(`OPENCODE_SERVER_URL had a trailing slash, using '${maskBackendUrl(stripped)}'`);
        url = stripped;
    }
    return { url, notes };
}