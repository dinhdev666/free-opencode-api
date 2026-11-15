/**
 * Runs `node --check` on every JavaScript source file in the repository.
 *
 * The script list used to be maintained by hand in `package.json`, which means a new file could be added and never
 * checked - the documented promise is "syntax check for every JavaScript file". Walking the tree keeps that true.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Directories that never hold project source: dependencies, VCS metadata and build output. They are skipped anywhere,
// except the build-output names, which are only skipped at the repository root: a source directory that happens to be
// called `build` further down the tree is project source and must still be checked.
const ALWAYS_SKIPPED = new Set(['node_modules', '.git']);
const BUILD_OUTPUT = new Set(['coverage', 'dist', 'build']);

const files = [];
const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const { name } = entry;
        if (ALWAYS_SKIPPED.has(name)) continue;
        if (directory === ROOT && BUILD_OUTPUT.has(name)) continue;
        // A symlinked directory is not walked (its target may be outside the repository), but a symlinked *file* is
        // still a file the build could load, so `isFile()` is the condition rather than "not a directory"
        if (entry.isDirectory()) {
            walk(path.join(directory, name));
        } else if (entry.isSymbolicLink()) {
            const target = path.join(directory, name);
            let stat = null;
            try {
                stat = fs.statSync(target);
            } catch {
                stat = null;
            }
            if (stat?.isFile() && /\.(?:mjs|cjs|js)$/.test(name)) files.push(target);
        } else if (/\.(?:mjs|cjs|js)$/.test(name)) {
            files.push(path.join(directory, name));
        }
    }
};

walk(ROOT);
files.sort();

// A check that looked at nothing passes for the wrong reason: if the tree ever moves, CI must fail here instead of
// reporting "syntax OK in 0 files"
if (files.length === 0) {
    console.error('[check] no JavaScript files found: the walk is looking in the wrong place');
    process.exit(1);
}

let failures = 0;
for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    } catch {
        // The child's own message is on stderr already; the summary line names the file and the count
        console.error(`[check] syntax error in ${path.relative(ROOT, file)}`);
        failures += 1;
    }
}
if (failures > 0) {
    console.error(`[check] ${failures} of ${files.length} files failed the syntax check`);
    process.exit(1);
}

console.log(`[check] syntax OK in ${files.length} files`);
