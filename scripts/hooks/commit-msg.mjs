// commit-msg hook: strips AI attribution, then enforces Conventional Commits,
// e.g. `feat(api): add page backlinks`.
//   node scripts/hooks/commit-msg.mjs <path to COMMIT_EDITMSG>
import { readFileSync, writeFileSync } from 'node:fs';

// Claude is never credited as a co-author; keep in sync with the CI check in ci.yml.
const ATTRIBUTION = /^\s*(co-authored-by:.*(claude|anthropic)|.*generated with \[?claude)/i;
const original = readFileSync(process.argv[2], 'utf8');
const cleaned = original
    .split('\n')
    .filter((line) => !ATTRIBUTION.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '\n');
if (cleaned !== original) writeFileSync(process.argv[2], cleaned);

const TYPES = [
    'feat',
    'fix',
    'docs',
    'style',
    'refactor',
    'perf',
    'test',
    'build',
    'ci',
    'chore',
    'revert',
];
// `deps-dev` is what Dependabot's `include: scope` writes for dev dependencies.
const SCOPES = [
    'api',
    'runner',
    'desktop',
    'client',
    'shared',
    'deps',
    'deps-dev',
    'ci',
    'docs',
    'repo',
];

const subject = cleaned.split('\n').find((line) => line.trim() && !line.startsWith('#'));

// Commits git writes for you, like merges and reverts, pass through unchanged.
if (!subject || /^(Merge|Revert|fixup!|squash!|amend!) /.test(subject)) process.exit(0);

const match = /^(\w+)(?:\(([\w-]+)\))?!?: (.+)$/.exec(subject);
const errors = [];
if (!match) {
    errors.push('subject must look like `type(scope): summary` or `type: summary`');
} else {
    const [, type, scope, summary] = match;
    if (!TYPES.includes(type)) errors.push(`type \`${type}\` is not one of: ${TYPES.join(', ')}`);
    if (scope && !SCOPES.includes(scope)) {
        errors.push(`scope \`${scope}\` is not one of: ${SCOPES.join(', ')}`);
    }
    if (/[.]$/.test(summary)) errors.push('summary must not end with a period');
}
if (subject.length > 72) errors.push(`subject is ${subject.length} characters; keep it to 72`);

if (errors.length) {
    console.error(`✗ ${subject}\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
}
