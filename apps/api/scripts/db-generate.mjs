// `pnpm db:generate [name]`: writes a migration for whatever prisma/schema.prisma changed since the
// last one, then regenerates the client. Prisma diffs against a shadow database; this serves a
// throwaway in-memory PGlite as that database, so no Postgres is needed and DATABASE_URL (which may
// be production) is never touched.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const EMPTY = '-- This is an empty migration.';

const name = (process.argv[2] ?? 'migration').toLowerCase().replace(/[^a-z0-9]+/g, '_');

function prisma(args, env = {}) {
    return new Promise((resolve, reject) => {
        // Async on purpose: the shadow database is served from this process's event loop.
        const child = spawn('pnpm', ['exec', 'prisma', ...args], {
            shell: process.platform === 'win32',
            stdio: ['ignore', 'pipe', 'inherit'],
            env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1', ...env },
        });
        let out = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        child.on('error', reject);
        child.on('exit', (code) =>
            code === 0 ? resolve(out) : reject(new Error(`prisma ${args[0]} exited ${code}`)),
        );
    });
}

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 100 });
await server.start();
const shadow = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?sslmode=disable`;

try {
    const diff = await prisma(
        [
            'migrate',
            'diff',
            '--from-migrations',
            'prisma/migrations',
            '--to-schema',
            'prisma/schema.prisma',
            '--script',
        ],
        // `migrate diff` never connects to DATABASE_URL, but Prisma refuses one equal to the shadow.
        { DATABASE_URL: shadow.replace('/postgres?', '/unused?'), SHADOW_DATABASE_URL: shadow },
    );
    if (diff.trim() && diff.trim() !== EMPTY) {
        const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
        const dir = `prisma/migrations/${stamp}_${name}`;
        await mkdir(dir, { recursive: true });
        await writeFile(`${dir}/migration.sql`, diff);
        console.log(`Wrote ${dir}/migration.sql`);
    } else {
        console.log('Schema matches the migrations; nothing to write.');
    }
} finally {
    await server.stop();
    await db.close();
}

process.stdout.write(await prisma(['generate']));
