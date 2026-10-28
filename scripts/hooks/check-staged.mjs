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
    ['fine-grained GitHub token', /github_pat_[A-Za-z0-9_]{50,}/],
    // The todo app's MCP URL is `https://<host>/mcp/<secret>`; the path is the credential.
    ['MCP URL with its secret path', /\/mcp\/(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/],
];

/** Stand-ins for a secret: a variable, `<...>`, a mask, or a stock word. */
const placeholder = (value) =>
    /^(\$|<|\{|\*|x{3,}|\.{3})/i.test(value) ||
    /^(changeme|password|pass|postgres|secret|token|example|placeholder)$/i.test(value);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Patterns that are secrets only when what they capture is real, so templates and docs pass. */
const VALUE_PATTERNS = [
    [
        'database URL with a password',
        /\b(?:postgres(?:ql)?|mysql):\/\/[^\s:@/]+:([^\s@/]+)@([^\s:/?#]+)/g,
        ([, password, host]) => !placeholder(password) && !LOCAL_HOSTS.has(host.toLowerCase()),
    ],
    [
        'secret from .env',
        /(?:^|[\s;'"`])(?:export\s+)?(?:API_TOKEN|ENCRYPTION_KEY|LYFESTYLE_API_TOKEN|RESEND_API_KEY)=["']?([^\s"'`#]+)/gm,
        ([, value]) => !placeholder(value),
    ],
];

/** Labels of the secrets `text` seems to contain. */
export function findSecrets(text) {
    const found = SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text));
    for (const [label, pattern, real] of VALUE_PATTERNS) {
        if ([...text.matchAll(pattern)].some(real)) found.push([label]);
    }
    return found.map(([label]) => label);
}

const problems = [];
for (const file of process.argv.slice(2)) {
    const name = basename(file);
    if ((/^\.env(\..*)?$/.test(name) && name !== '.env.example') || name === '.envrc') {
        problems.push(
            `${file}: env files hold secrets; keep them local (.env.example is the template)`,
        );
        continue;
    }
    if (name === 'package-lock.json' || name === 'yarn.lock') {
        problems.push(`${file}: this repo uses pnpm only; delete it and run pnpm install`);
        continue;
    }
    // Size first: reading a huge blob would overflow the buffer and look like a missing file.
    let size;
    try {
        size = Number(
            execFileSync('git', ['cat-file', '-s', `:${file}`], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }),
        );
    } catch {
        continue; // deleted or renamed away
    }
    if (size > MAX_BYTES && !file.startsWith('apps/desktop/src-tauri/icons/')) {
        problems.push(`${file}: ${(size / 1024 / 1024).toFixed(1)} MB is over the 1 MB limit`);
        continue;
    }
    // Read the staged blob, not the working tree, so a later unstaged edit cannot hide a secret.
    const blob = execFileSync('git', ['show', `:${file}`], { maxBuffer: size + 1024 });
    if (blob.includes(0)) continue; // binary
    for (const label of findSecrets(blob.toString('utf8'))) {
        problems.push(`${file}: looks like it contains a ${label}`);
    }
}

if (problems.length) {
    console.error(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
}
