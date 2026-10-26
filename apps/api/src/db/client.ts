import { mkdir } from 'node:fs/promises';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
    db: Db;
    close(): Promise<void>;
}

export interface DatabaseOptions {
    /** A Postgres connection string; without one the API runs on embedded PGlite. */
    url?: string | undefined;
    /** PGlite's data directory, or `memory://` for a throwaway database. */
    dataDir?: string;
    migrationsFolder: string;
}

export async function openDatabase(options: DatabaseOptions): Promise<Database> {
    return options.url ? openPostgres(options.url, options) : openPglite(options);
}

async function openPostgres(url: string, { migrationsFolder }: DatabaseOptions): Promise<Database> {
    const { Pool } = (await import('pg')).default;
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({ connectionString: url, max: 10 });
    const db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => pool.end() };
}

async function openPglite({
    dataDir = 'memory://',
    migrationsFolder,
}: DatabaseOptions): Promise<Database> {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    if (!dataDir.startsWith('memory://')) await mkdir(dataDir, { recursive: true });
    const client = new PGlite(dataDir);
    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => client.close() };
}
