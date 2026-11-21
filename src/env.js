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

/**
 * Splits `PATH` into its entries.
 *
 * **Absolute entries only.** A relative entry (`PATH=bin:/usr/bin`, or a stray `.`) made `path.join(dir, name)` a
 * relative string, and `spawnBackend()` spawns with `cwd` set to the 0700 jail: libuv resolves a slash-less program
 * *after* that `chdir`, so the entry now pointed inside the jail and a perfectly installed CLI was reported as a
 * backend that "exited during startup". Empty entries are dropped too - an empty one is an implicit cwd entry, which is
 * the same hazard in a different spelling.
 * @returns {string[]} the absolute directories to search, in order
 */
function splitPathEnv() {
    const raw = process.env.PATH || '';
    return raw.split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));
}

/**
 * Whether a configured program path can be handed to a shell.
 *
 * `spawn()` joins `[file, ...args]` with spaces when `shell: true`, so quoting the program only protects spaces - an
 * embedded `"` ends the quoted run and whatever follows is parsed as more commands. That is why the spawn refuses
 * these paths outright instead of quoting them, and the entry point's version probe has to apply the same rule: it
 * builds the same kind of command line, and a probe that ran `x" ; id ; echo "` executed `id`.
 *
 * On Windows, `cmd.exe` expands `%VAR%` even inside double quotes, so a `%` in the path is a variable expansion that
 * can change the command line. `^` and `!` are the escape and delayed-expansion characters respectively. A trailing
 * backslash is the escape for the closing quote, leaving the string unterminated. All three are refused on `win32`
 * only, because POSIX shells do not expand `%` or treat `\` specially inside quotes.
 * @param {string} value the program path
 * @param {string} [platform] the platform whose shell rules apply; defaults to this process's, and exists so the
 *   `win32`-only rules are asserted from a POSIX runner (CI is Linux-only, so without it that branch ran in no run)
 * @returns {boolean} true when the value must not be passed through a shell
 */
export function isShellUnsafePath(value, platform = process.platform) {
    const text = String(value);
    if (/["$`\u0000-\u001f\u007f]/.test(text)) return true;
    if (platform === 'win32') {
        // `%VAR%` expansion, `^` escape, `!` delayed expansion, and a trailing backslash (escapes the closing quote).
        if (/[%^!]/.test(text)) return true;
        if (text.endsWith('\\')) return true;
    }
    return false;
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

/**
 * The first candidate that is a **regular file**.
 *
 * `existsSync` alone accepted a directory named `opencode` (and any non-executable file), which then reached `spawn()`
 * and failed as an opaque `EACCES`/`EISDIR`. `statSync` follows a symlink on purpose: an install that is a symlink
 * into a version manager's tree is the normal shape, and `lstat` would reject it.
 * @param {string[]} dirs absolute directories to search
 * @param {string[]} names candidate file names
 * @returns {string|null} the absolute path, or null
 */
function findExecutableInDirs(dirs, names) {
    for (const dir of dirs) {
        for (const name of names) {
            const full = path.join(dir, name);
            if (!fs.existsSync(full)) continue;
            try {
                if (fs.statSync(full).isFile()) return full;
            } catch (e) {
                // Unreadable or raced away: keep looking rather than reporting a binary that cannot be run
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

// A configured path has to name a file, not merely something that exists. `statSync` follows a symlink, which is the
// normal shape for an install into a version manager's tree (`lstat` would reject it), and a throw (unreadable, raced
// away) is "not a usable path" rather than a crash on the startup path.
function isFile(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    } catch (e) {
        return false;
    }
}

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
            // The configured value is **resolved** against this process's working directory before it is handed back,
            // and the resolution is what is returned - never the raw value. `spawn()` looks the executable up relative to
            // the child's own `cwd`, which is the 0700 workspace jail (`spawnBackend()`), so a relative
            // `OPENCODE_PATH: "./bin/opencode"` that exists and was announced at startup as resolved failed one layer
            // later as a backend that "exited during startup" - the same hazard already recorded for a relative `PATH`
            // entry, where the configured branch was the one that was missed. The value is a process we start as this
            // uid, so an absolute path is also what the operator's configuration is read as.
            // A *file*, not merely something that exists: a configured directory (`OPENCODE_PATH=/opt/opencode`)
            // passed `existsSync()` and was reported at startup as the resolved binary, so the failure surfaced one
            // layer later as `spawn /opt/opencode EACCES` inside a `502 backend_unreachable` - about a path the
            // operator had just been told was correct. `findExecutableInDirs()` has always required a regular file
            // for the PATH search; the configured branch is the one that did not.
            const resolved = path.resolve(process.cwd(), input);
            if (isFile(resolved)) return { path: resolved, source: 'config' };
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

// A bind address is a host name, an IPv4 address or an IPv6 literal (optionally bracketed, with a `%zone` id). The
// gateway's own `BIND_HOST` is handed to `listen()`, but `OPENCODE_BIND_HOST` is an argument of a child that may be
// started through a shell (`spawn(..., {shell: true})`, which concatenates the arguments into one command line instead
// of quoting them), so anything outside this set is either a typo or an argument-injection attempt: a value such as
// `0.0.0.0 & curl …` would run as a second command, as the gateway's user. `OPENCODE_PATH` has the same rule
// (`isShellUnsafePath()`), because the same shell parses it.
const USABLE_BIND_HOST_RE = /^[A-Za-z0-9.\-:\[\]%]{1,253}$/;

/**
 * Whether a configured value is a bind address the gateway can pass to a child verbatim.
 * @param {*} value the configured value
 * @returns {boolean} true for a host name, an IPv4 address or an IPv6 literal
 */
export function isUsableBindHost(value) {
    if (typeof value !== 'string' || value === '') return false;
    return USABLE_BIND_HOST_RE.test(value);
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
    // No port: the gateway starts `opencode serve` on 4097 while every probe uses this URL verbatim, so a port-less
    // value is a backend that can never answer (see `spawnBackend()`, which refuses to spawn one). Said at startup,
    // where the operator reads the summary, rather than only in the 502 of the first completion.
    try {
        if (new URL(url).port === '') {
            notes.push(`OPENCODE_SERVER_URL='${maskBackendUrl(url)}' names no port: the backend is started on 4097 but this URL is probed as-is (port 80), so completions cannot succeed`);
        }
    } catch (e) {
        // Unparseable: `spawnBackend()` refuses it before the spawn, with a sentence naming the value and the shape it
        // must have. Said here too, because this is the line an operator reads at startup - the 502 of the first
        // completion is a worse place to learn that the configured URL is not a URL.
        notes.push(`OPENCODE_SERVER_URL='${maskBackendUrl(url)}' cannot be parsed as a URL: it must be http(s)://host:port, for example http://127.0.0.1:4097`);
    }
    return { url, notes };
}