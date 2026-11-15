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
// Directories that never hold project source: dependencies, VCS metadata and build output
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);

const files = [];
const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            walk(fullPath);
        } else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) {
            files.push(fullPath);
        }
    }
};

walk(ROOT);
files.sort();

for (const file of files) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`[check] syntax OK in ${files.length} files`);
