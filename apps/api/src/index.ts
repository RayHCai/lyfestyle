import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { createSecretBox } from './lib/crypto.js';
import { Notifier } from './lib/notifier.js';
import { startScheduler } from './scheduler.js';
import { createServices } from './services.js';

/** How long open requests get to finish once shutdown starts before their sockets are closed. */
const DRAIN_MS = 10_000;
/** How long running automations get to stop once aborted. */
const STOP_AUTOMATIONS_MS = 15_000;

// A stray rejection is a bug, but not one worth dropping every open request and run over.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection', reason);
});
// After an uncaught exception the process state is unknown; log it and let the platform restart.
process.on('uncaughtException', (err, origin) => {
    console.error(`Uncaught exception (${origin})`, err);
    process.exit(1);
});

const config = loadConfig();
// Resolves to apps/api/prisma/migrations from both src/index.ts and the bundled dist/index.js.
const migrationsFolder = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

const database = await openDatabase({ url: config.databaseUrl, migrationsFolder });

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
    const host = new URL(config.databaseUrl).host;
    console.log(
        `Lyfestyle API on :${info.port} (Postgres at ${host}), public URL ${config.publicUrl}`,
    );
});

/**
 * Stops accepting connections and resolves once the open ones end. Claim long-polls and run event
 * streams would hold the server open indefinitely, so whatever is still open after `DRAIN_MS` is cut.
 */
function closeServer(): Promise<void> {
    return new Promise((resolve) => {
        let cutoff: NodeJS.Timeout | undefined;
        server.close((err) => {
            clearTimeout(cutoff);
            if (err) console.error('Closing the HTTP server failed', err);
            resolve();
        });
        if ('closeAllConnections' in server) {
            server.closeIdleConnections();
            cutoff = setTimeout(() => server.closeAllConnections(), DRAIN_MS);
        }
    });
}

/** Waits for `work`, but no longer than `ms`: shutdown must finish before the platform kills us. */
async function within(work: Promise<unknown>, ms: number, what: string) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            console.error(`${what} did not finish within ${ms} ms; shutting down anyway`);
            resolve();
        }, ms);
    });
    try {
        await Promise.race([work, timeout]);
    } catch (err) {
        console.error(`${what} failed`, err);
    } finally {
        clearTimeout(timer);
    }
}

let closing = false;
async function shutdown(signal: string) {
    if (closing) return;
    closing = true;
    console.log(`${signal}: shutting down`);
    const closed = closeServer();
    // A tick in flight may still start automations; let it finish before stopping them.
    await within(stopScheduler(), STOP_AUTOMATIONS_MS, 'The scheduler tick');
    await Promise.all([
        closed,
        within(
            services.automations.stopAll('The API shut down during this run'),
            STOP_AUTOMATIONS_MS,
            'Stopping automations',
        ),
    ]);
    await within(database.close(), 5_000, 'Closing the database');
    process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
