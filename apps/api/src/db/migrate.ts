import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Prisma Migrate's own lock key, so the API and `prisma migrate deploy` never interleave. */
const MIGRATE_LOCK = 72707369;

/** The migration every database starts from; Drizzle-era databases already have its schema. */
const BASELINE = '0_init';

/** One transaction on the raw driver; `exec` takes several statements, `query` takes parameters. */
export interface MigrationTx {
    exec(sql: string): Promise<void>;
    query<R>(sql: string, params?: unknown[]): Promise<R[]>;
}

export type RunInTransaction = <T>(fn: (tx: MigrationTx) => Promise<T>) => Promise<T>;

/**
 * Applies `prisma/migrations` in name order, all in one transaction. Prisma Client cannot run
 * multi-statement scripts and the Prisma CLI cannot reach an in-process PGlite, so the API does it
 * itself, recording each migration in `_prisma_migrations` exactly as `prisma migrate deploy`
 * would. `prisma migrate status` therefore works against any database the API has opened.
 */
export async function migrate(transaction: RunInTransaction, migrationsFolder: string) {
    const entries = await readdir(migrationsFolder, { withFileTypes: true });
    const names = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

    await transaction(async (tx) => {
        await tx.query('select pg_advisory_xact_lock($1::bigint)', [MIGRATE_LOCK]);
        await tx.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
            "id" VARCHAR(36) PRIMARY KEY NOT NULL,
            "checksum" VARCHAR(64) NOT NULL,
            "finished_at" TIMESTAMPTZ,
            "migration_name" VARCHAR(255) NOT NULL,
            "logs" TEXT,
            "rolled_back_at" TIMESTAMPTZ,
            "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
            "applied_steps_count" INTEGER NOT NULL DEFAULT 0
        )`);
        const rows = await tx.query<{ name: string; finished: boolean; checksum: string }>(
            `select migration_name as name, finished_at is not null as finished, checksum
             from "_prisma_migrations" where rolled_back_at is null`,
        );
        const failed = rows.find((r) => !r.finished);
        if (failed) {
            throw new Error(
                `Migration ${failed.name} failed earlier; fix it and run \`prisma migrate resolve\``,
            );
        }
        const applied = new Set(rows.map((r) => r.name));
        await warnOnDrift(rows, names, migrationsFolder);

        if (!applied.size && (await hasTable(tx, 'pages'))) {
            // Created by Drizzle before the move to Prisma: the baseline is that same schema.
            if (!(await hasTable(tx, 'page_views'))) {
                throw new Error(
                    'This database predates the last Drizzle migration; cannot adopt it',
                );
            }
            await record(tx, BASELINE, await readMigration(migrationsFolder, BASELINE));
            applied.add(BASELINE);
        }

        for (const name of names) {
            if (applied.has(name)) continue;
            const sql = await readMigration(migrationsFolder, name);
            await tx.exec(sql);
            await record(tx, name, sql);
        }
    });
}

async function hasTable(tx: MigrationTx, table: string) {
    const [row] = await tx.query<{ found: boolean }>(
        'select to_regclass($1) is not null as found',
        [`public.${table}`],
    );
    return row?.found ?? false;
}

/**
 * Warns when applied migrations and the folder disagree: a file edited after it was applied, or a
 * database migrated by newer code than this build. Either way the schema may not be the one this
 * code expects, but refusing to boot would take the API down over what may be a comment edit.
 */
async function warnOnDrift(
    rows: { name: string; checksum: string }[],
    names: string[],
    migrationsFolder: string,
) {
    const known = new Set(names);
    const unknown = rows.filter((r) => !known.has(r.name)).map((r) => r.name);
    if (unknown.length) {
        console.warn(
            `WARNING: the database has applied migrations this build does not have: ${unknown.join(', ')}. ` +
                'Newer code migrated it (was the API rolled back?), so its schema may not match this build.',
        );
    }
    const edited: string[] = [];
    for (const row of rows) {
        if (!known.has(row.name)) continue;
        const sql = await readMigration(migrationsFolder, row.name);
        // `prisma migrate deploy` hashes the file as it is; the API hashes it LF-normalised.
        if (row.checksum !== checksum(sql) && row.checksum !== sha256(sql)) edited.push(row.name);
    }
    if (edited.length) {
        console.warn(
            `WARNING: migrations changed after they were applied: ${edited.join(', ')}. ` +
                'The database keeps the schema it applied, not the edited file. Restore the file ' +
                'and put the change in a new migration (`pnpm db:generate`).',
        );
    }
}

function readMigration(folder: string, name: string) {
    return readFile(join(folder, name, 'migration.sql'), 'utf8');
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** LF-normalised, so a Windows checkout records the same checksum as the deployed image. */
const checksum = (sql: string) => sha256(sql.replaceAll('\r\n', '\n'));

function record(tx: MigrationTx, name: string, sql: string) {
    return tx.query(
        `insert into "_prisma_migrations"
            (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
         values ($1, $2, $3, now(), now(), 1)`,
        [randomUUID(), checksum(sql), name],
    );
}
