import fs from 'fs';

/**
 * Reads a `config.json` file for the entry point.
 *
 * Returns `{ config, error }`. A missing file is normal (`config` is empty and `error` is null), but a file that
 * exists and cannot be used is an error: continuing with defaults would silently ignore the port and the API key the
 * operator wrote, leaving the gateway running with the built-in dummy key instead of theirs.
 */
export function readConfigFile(configPath) {
    if (!fs.existsSync(configPath)) return { config: {}, error: null };

    let raw;
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    } catch (e) {
        return { config: {}, error: `cannot be read: ${e.message}` };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { config: {}, error: `is not valid JSON: ${e.message}` };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const found = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`;
        return { config: {}, error: `must contain a JSON object, found ${found}` };
    }

    return { config: parsed, error: null };
}
