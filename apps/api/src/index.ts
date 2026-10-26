import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startScheduler } from './agent/scheduler.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { createSecretBox } from './lib/crypto.js';
import { Notifier } from './lib/notifier.js';
import { createServices } from './services.js';

const config = loadConfig();
// Resolves to apps/api/drizzle from both src/index.ts and the bundled dist/index.js.
const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

if (!config.databaseUrl && process.env.RAILWAY_ENVIRONMENT) {
    console.warn(
        'No DATABASE_URL: data lives in the container and is lost on redeploy. Attach Postgres.',
    );
}

const database = await openDatabase({
    url: config.databaseUrl,
    dataDir: join(config.dataDir, 'pglite'),
    migrationsFolder,
});

const services = createServices({
    db: database.db,
    config,
    notifier: new Notifier(),
    secrets: createSecretBox(config.encryptionKey),
    fetch: globalThis.fetch,
    now: () => new Date(),
});

const app = createApp(services);
const stopScheduler = startScheduler(services, config.schedulerTickMs);

const server = serve({ fetch: app.fetch, port: config.port, hostname: '::' }, (info) => {
    const store = config.databaseUrl ? 'Postgres' : `embedded PGlite in ${config.dataDir}`;
    console.log(`Lyfestyle API on :${info.port} (${store}), public URL ${config.publicUrl}`);
});

let closing = false;
async function shutdown(signal: string) {
    if (closing) return;
    closing = true;
    console.log(`${signal}: shutting down`);
    stopScheduler();
    server.close();
    await database.close();
    process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
