import { fileURLToPath } from 'node:url';
import { createApp, type AppType } from './app.js';
import { loadConfig, type Config } from './config.js';
import { openPglite } from './db/pglite.js';
import { createSecretBox } from './lib/crypto.js';
import { Notifier } from './lib/notifier.js';
import { createServices, type Services } from './services.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef';
export const TEST_URL = 'http://api.test';

export const migrationsFolder = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

export interface TestOptions {
    env?: Record<string, string>;
    fetch?: typeof fetch;
    now?: () => Date;
}

export interface TestContext {
    app: AppType;
    services: Services;
    config: Config;
    /** A `fetch` that lands on the in-process app, for clients under test. */
    fetch: typeof fetch;
    /** An authenticated JSON request, answered with its status and parsed body. */
    // oxlint-disable-next-line typescript/no-explicit-any -- tests assert on arbitrary response shapes
    call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
    close(): Promise<void>;
}

/** A full API on a throwaway in-memory database, reachable without a network. */
export async function createTestContext(options: TestOptions = {}): Promise<TestContext> {
    const config = loadConfig({
        // Required by the config, never dialled: tests run on in-memory PGlite.
        DATABASE_URL: 'postgresql://pglite.invalid/test',
        API_TOKEN: TEST_TOKEN,
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        PUBLIC_URL: TEST_URL,
        ...options.env,
    });
    const database = await openPglite(migrationsFolder);
    const services = createServices({
        db: database.db,
        config,
        notifier: new Notifier(),
        secrets: createSecretBox(config.encryptionKey),
        fetch: options.fetch ?? (() => Promise.reject(new Error('Outbound fetch in a test'))),
        now: options.now ?? (() => new Date()),
    });
    const app = createApp(services);

    const appFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
        app.fetch(new Request(input, init))) as typeof fetch;

    async function call(method: string, path: string, body?: unknown) {
        const res = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        // oxlint-disable-next-line typescript/no-explicit-any -- matches TestContext.call
        const json = (text ? JSON.parse(text) : null) as any;
        return { status: res.status, body: json };
    }

    return {
        app,
        services,
        config,
        fetch: appFetch,
        call,
        close: () => database.close(),
    };
}
