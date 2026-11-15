/**
 * Checks that commit subjects follow the convention documented in CONTRIBUTING.md ("Commit messages").
 *
 * The convention was enforced by review alone, and review missed what a machine can see: a subject over the 72
 * character limit, a scope that is not in the documented list (`container`, `docker,ci`), two scopes in one commit,
 * and merge commits carrying GitHub's own `Merge pull request #112 from …` title. A message cannot be corrected
 * afterwards without rewriting published history, so the check has to fail before the commit lands.
 *
 * Usage:
 *   node test/check-commit-messages.mjs                 # the last commit (HEAD~1..HEAD)
 *   node test/check-commit-messages.mjs origin/main..HEAD
 *   COMMIT_RANGE=abc123..def456 node test/check-commit-messages.mjs
 *   node test/check-commit-messages.mjs --subject "fix(proxy): add the thing (#123)"
 *
 * The range is handed to `git rev-list`, so any revision syntax works. Merge commits are checked like every other
 * commit: a merge is where a PR's title lands in `main`, so it is the commit most likely to carry a message nobody
 * wrote by hand (`gh pr merge <n> --merge --subject "<type>(<scope>): …"`).
 */
import { execFileSync } from 'node:child_process';

// Mirrors the tables in CONTRIBUTING.md. They are two copies of one rule - the document is what a contributor reads,
// this is what CI enforces - so a type or scope added to one has to be added to the other.
const TYPES = new Set(['feat', 'fix', 'perf', 'refactor', 'docs', 'build', 'ci', 'test', 'chore', 'revert']);
const SCOPES = new Set([
    'proxy',
    'stream',
    'backend',
    'auth',
    'logger',
    'config',
    'docker',
    'deps',
    'docs',
    'release',
]);
const MAX_SUBJECT_LENGTH = 72;

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// `HEAD~1..HEAD` needs a parent, which the first commit of a repository does not have
const defaultRange = () => {
    try {
        git(['rev-parse', '--verify', '--quiet', 'HEAD~1']);
        return 'HEAD~1..HEAD';
    } catch {
        return 'HEAD';
    }
};

const subjectProblems = (subject) => {
    const problems = [];

    if (subject.length > MAX_SUBJECT_LENGTH) {
        problems.push(`${subject.length} characters, the limit is ${MAX_SUBJECT_LENGTH}`);
    }
    if (subject.endsWith('.')) problems.push('the subject ends with a period');

    const match = /^([a-z]+)(?:\(([^)]*)\))?(!)?: (.+)$/.exec(subject);
    if (!match) {
        // Named apart because they are fixed differently: a missing prefix is a reword, while a GitHub merge title is
        // avoided by merging with an explicit subject
        problems.push('no `<type>(<scope>): <subject>` prefix');
        if (/^Merge (pull request|branch|remote-tracking branch)/.test(subject)) {
            problems.push(
                'this is a generated merge title; merge with `gh pr merge <n> --merge --subject "<type>(<scope>): …"` ' +
                    'or squash the pull request instead',
            );
        }
    } else {
        const [, type, scope, , rest] = match;
        if (!TYPES.has(type)) problems.push(`type "${type}" is not in the documented list`);
        if (scope !== undefined) {
            const parts = scope.split(',');
            // One commit with two scopes hides which area changed; the convention has a single optional scope, and a
            // change that spans areas reads better with none at all
            if (parts.length > 1) problems.push(`scope "${scope}" carries several scopes; use one, or none`);
            for (const part of parts) {
                if (!SCOPES.has(part)) problems.push(`scope "${part}" is not in the documented list`);
            }
        }
        if (!/^[a-z0-9]/.test(rest)) problems.push('the subject does not start lowercase');
    }
    return problems;
};

// A merge subject only exists after the merge, and a protected branch cannot correct it: `gh pr merge --subject`
// appends `(#123)` after the 72 characters a writer counted, and the overflow lands in `main` permanently (the merge of
// #118 answered 76 characters and left a red check on the branch). `--subject` judges the string before it is used.
const subjectIndex = process.argv.indexOf('--subject');
if (subjectIndex !== -1) {
    const candidate = process.argv[subjectIndex + 1];
    if (!candidate) {
        console.error('[commits] --subject needs the message to check, for example: --subject "feat(proxy): add it (#1)"');
        process.exit(1);
    }
    const problems = subjectProblems(candidate);
    if (problems.length > 0) {
        console.error(`[commits] ${candidate}`);
        for (const problem of problems) console.error(`          - ${problem}`);
        console.error(`[commits] ${problems.length} problem(s) with this subject; shorten or reword it before it is published`);
        process.exit(1);
    }
    console.log(`[commits] "${candidate}" follows the convention (${candidate.length}/${MAX_SUBJECT_LENGTH} characters)`);
    process.exit(0);
}

const range = process.argv[2] || process.env.COMMIT_RANGE || defaultRange();

let commits;
try {
    const out = git(['rev-list', '--reverse', range]);
    commits = out.split('\n').filter(Boolean);
} catch (error) {
    // A shallow clone (actions/checkout defaults to depth 1) cannot resolve the base of a range: saying so is the
    // difference between a one-line CI fix (`fetch-depth: 0`, or fetch the base) and a search through the workflow
    const detail = String(error.stderr || error.message).trim().split('\n')[0];
    console.error(`[commits] cannot read the range "${range}": ${detail}`);
    console.error('[commits] a shallow clone has no commit for the start of the range; fetch that commit first');
    process.exit(1);
}

if (commits.length === 0) {
    // An empty range is a re-run, or a push that left the tip where it was: there is nothing to judge, and failing the
    // build over it would put a red check on a change that added no commit
    console.log(`[commits] the range "${range}" contains no commit, nothing to check`);
    process.exit(0);
}

const subjects = new Map();
for (const hash of commits) {
    const message = git(['show', '-s', '--format=%B', hash]);
    subjects.set(hash, message.split('\n')[0].replace(/\r$/, ''));
}

let failures = 0;
for (const [hash, subject] of subjects) {
    const problems = subjectProblems(subject);

    if (problems.length > 0) {
        failures += 1;
        console.error(`[commits] ${hash} ${subject}`);
        for (const problem of problems) console.error(`          - ${problem}`);
    }
}

if (failures > 0) {
    console.error(`[commits] ${failures} of ${commits.length} commit message(s) do not follow CONTRIBUTING.md`);
    console.error('[commits] reword with `git rebase -i <base>` before the commit is published, not after');
    process.exit(1);
}

console.log(`[commits] ${commits.length} commit message(s) follow the convention`);
