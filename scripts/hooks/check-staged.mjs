// Pre-commit guard: refuses env files, foreign lockfiles, oversized files and obvious secrets.
//   node scripts/hooks/check-staged.mjs <file>...
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const SECRET_PATTERNS = [
    ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
    ['AWS access key', /AKIA[0-9A-Z]{16}/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['Google OAuth secret', /GOCSPX-[A-Za-z0-9_-]{20,}/],
    ['Resend API key', /re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
    ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36,}/],
];

const problems = [];
for (const file of process.argv.slice(2)) {
    const name = basename(file);
    if (/^\.env(\..*)?$/.test(name) && name !== '.env.example') {
        problems.push(
            `${file}: env files hold secrets; keep them local (.env.example is the template)`,
        );
        continue;
    }
    if (name === 'package-lock.json' || name === 'yarn.lock') {
        problems.push(`${file}: this repo uses pnpm only; delete it and run pnpm install`);
        continue;
    }
    // Read the staged blob, not the working tree, so a later unstaged edit cannot hide a secret.
    let blob;
    try {
        blob = execFileSync('git', ['show', `:${file}`], { maxBuffer: 64 * MAX_BYTES });
    } catch {
        continue; // deleted or renamed away
    }
    if (blob.length > MAX_BYTES && !file.startsWith('apps/desktop/src-tauri/icons/')) {
        problems.push(
            `${file}: ${(blob.length / 1024 / 1024).toFixed(1)} MB is over the 1 MB limit`,
        );
        continue;
    }
    if (blob.includes(0)) continue; // binary
    const text = blob.toString('utf8');
    for (const [label, pattern] of SECRET_PATTERNS) {
        if (pattern.test(text)) problems.push(`${file}: looks like it contains a ${label}`);
    }
}

if (problems.length) {
    console.error(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
}
