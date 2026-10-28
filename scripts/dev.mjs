// Runs the whole stack in one terminal: the API, then the runner and the desktop app once the API
// answers. Ctrl+C, or any one of them exiting, stops the rest.
//   pnpm dev                 everything
//   pnpm dev --no-desktop    API and runner only
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseEnv, styleText } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = join(root, '.env');
if (!existsSync(envFile)) {
    console.error('No .env yet: copy .env.example to .env and fill it in with `pnpm secrets`.');
    process.exit(1);
}
// Variables already set in the shell win over .env, as with `node --env-file`.
const env = { ...parseEnv(readFileSync(envFile, 'utf8')), ...process.env };
const value = (name) => env[name]?.trim() || undefined;

/**
 * Only the API reads these. The runner and the desktop app get them as empty strings rather than
 * not at all: the runner's start script loads .env itself, and an env file never overwrites a
 * variable that is already set, even to nothing.
 */
const SERVER_SECRETS = ['API_TOKEN', 'ENCRYPTION_KEY', 'DATABASE_URL', 'RESEND_API_KEY'];

/** The shell's environment plus the .env keys `keep` matches, pointed at the API at `url`. */
function clientEnv(keep, url) {
    const out = { ...process.env };
    for (const [name, v] of Object.entries(env)) if (keep.test(name)) out[name] = v;
    for (const name of SERVER_SECRETS) out[name] = '';
    // Both URL and token set is what puts the desktop app in API mode without touching Settings.
    out.LYFESTYLE_API_URL = url;
    out.LYFESTYLE_API_TOKEN = value('LYFESTYLE_API_TOKEN') ?? value('API_TOKEN') ?? '';
    return out;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '']);
const hostOf = (url) => {
    try {
        return new URL(url).hostname;
    } catch {
        return undefined;
    }
};

const withDesktop = !process.argv.includes('--no-desktop');
const children = new Map();
let stopping = false;

const label = (name, color) => styleText(color, `[${name}]`.padEnd(10));

function start(name, color, script, childEnv) {
    const child = spawn('pnpm', [script], {
        cwd: root,
        env: childEnv,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
    });
    children.set(name, child);
    for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream }).on('line', (line) =>
            console.log(`${label(name, color)} ${line}`),
        );
    }
    child.on('exit', (code) => {
        children.delete(name);
        if (stopping) return;
        console.log(`${label(name, color)} exited with code ${code}; stopping the rest`);
        stop(code || 1);
    });
}

/** Ends a child and everything under it, before this process exits and the tree loses its root. */
function kill(child) {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch {
            // Already gone.
        }
    }
}

// The API reaps a run whose runner vanished mid-turn, so nothing here waits for a clean finish.
function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) kill(child);
    process.exit(code);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

async function healthy(url) {
    try {
        return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
        return false;
    }
}

const main = label('dev', 'gray');
const port = Number(value('PORT')) || 3000;
let apiUrl = (value('LYFESTYLE_API_URL') ?? `http://localhost:${port}`).replace(/\/+$/, '');

if (await healthy(apiUrl)) {
    console.log(`${main} An API is already answering at ${apiUrl}; using it`);
} else if (!LOCAL_HOSTS.has(hostOf(apiUrl) ?? 'remote')) {
    // Starting a local API would not help: the runner and the app would still use this URL.
    console.error(
        `${main} LYFESTYLE_API_URL is ${apiUrl}, which is not answering. pnpm dev only starts an API ` +
            `on this machine: start that one, or point LYFESTYLE_API_URL at http://localhost:${port}.`,
    );
    process.exit(1);
} else {
    const databaseUrl = value('DATABASE_URL');
    if (!databaseUrl) {
        console.error(
            `${main} DATABASE_URL is not set in .env. The API needs a Postgres database; see ` +
                'docs/development.md.',
        );
        process.exit(1);
    }
    const dbHost = hostOf(databaseUrl);
    if (!LOCAL_HOSTS.has(dbHost ?? '')) {
        console.warn(
            styleText(
                'yellow',
                `${main} DATABASE_URL points at ${dbHost}, not this machine. If that is ` +
                    'production, the local API will run its migrations and jobs against it.',
            ),
        );
    }
    // The API listens on PORT, so that is the URL to wait for and hand to the others.
    const started = `http://localhost:${port}`;
    if (started !== apiUrl) console.log(`${main} Starting the API on ${started}, not ${apiUrl}`);
    apiUrl = started;
    start('api', 'cyan', 'api:dev', env);
    const deadline = Date.now() + 90_000;
    while (!(await healthy(apiUrl))) {
        if (Date.now() > deadline) {
            console.error(`${main} The API did not come up at ${apiUrl} within 90s`);
            stop(1);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`${main} API is up at ${apiUrl}`);
}
start(
    'runner',
    'magenta',
    'runner',
    clientEnv(/^(LYFESTYLE_|AGENT_|RUNNER_|RUN_TIMEOUT_MINUTES$)/, apiUrl),
);
if (withDesktop) start('desktop', 'green', 'desktop', clientEnv(/^LYFESTYLE_/, apiUrl));
console.log(`${main} Ctrl+C stops everything`);
