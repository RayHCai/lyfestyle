// Tests only. The API itself runs on Postgres through DATABASE_URL (db/client.ts); this opens the
// same migrated schema on PGlite, Postgres compiled to WebAssembly and run in-process, so the tests
// need no database server. Nothing reachable from src/index.ts may import this file.
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { closeOnFailure, createDb, type Database } from './client.js';
import { migrate } from './migrate.js';

/** Applies pending migrations to `pglite`, the way `openDatabase` does to Postgres. */
export function migratePglite(pglite: PGlite, migrationsFolder: string) {
    return migrate(
        (fn) =>
            pglite.transaction((t) =>
                fn({
                    exec: async (sql) => void (await t.exec(sql)),
                    query: async <R>(sql: string, params?: unknown[]) =>
                        (await t.query<R>(sql, params)).rows,
                }),
            ),
        migrationsFolder,
    );
}

/** Migrates `pglite` (by default a fresh in-memory database) and returns the API's client over it. */
export async function openPglite(
    migrationsFolder: string,
    pglite: PGlite = new PGlite(),
): Promise<Database> {
    await closeOnFailure(() => pglite.close(), migratePglite(pglite, migrationsFolder));
    const { db, disconnect } = createDb(new PrismaPGlite(pglite));
    return {
        db,
        close: async () => {
            await disconnect();
            await pglite.close();
        },
    };
}
