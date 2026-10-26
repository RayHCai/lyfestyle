// Runs the whole stack in one terminal: the API, then the runner and the desktop app once the API
// answers. Ctrl+C, or any one of them exiting, stops the rest.
//   pnpm dev                 everything
//   pnpm dev --no-desktop    API and runner only
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = join(root, '.env');
if (!existsSync(envFile)) {
    console.error('No .env yet: copy .env.example to .env and fill it in with `pnpm secrets`.');
    process.exit(1);
}
// Exported to every child, so the desktop app starts in API mode without touching Settings.
process.loadEnvFile(envFile);
const apiUrl = (
    process.env.LYFESTYLE_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
).replace(/\/+$/, '');
process.env.LYFESTYLE_API_URL = apiUrl;

const withDesktop = !process.argv.includes('--no-desktop');
const children = new Map();
let stopping = false;

const label = (name, color) => styleText(color, `[${name}]`.padEnd(10));

function start(name, color, script) {
    const child = spawn('pnpm', [script], {
        cwd: root,
        env: process.env,
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

async function healthy() {
    try {
        return (await fetch(`${apiUrl}/health`)).ok;
    } catch {
        return false;
    }
}

const main = label('dev', 'gray');
if (await healthy()) {
    console.log(`${main} An API is already answering at ${apiUrl}; using it`);
} else {
    start('api', 'cyan', 'api:dev');
    const deadline = Date.now() + 90_000;
    while (!(await healthy())) {
        if (Date.now() > deadline) {
            console.error(`${main} The API did not come up at ${apiUrl} within 90s`);
            stop(1);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`${main} API is up at ${apiUrl}`);
}
start('runner', 'magenta', 'runner');
if (withDesktop) start('desktop', 'green', 'desktop');
console.log(`${main} Ctrl+C stops everything`);
