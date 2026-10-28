import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migratePglite, openPglite } from '../src/db/pglite.js';
import { migrationsFolder } from '../src/testing.js';

let dir: string | undefined;
afterEach(async () => {
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
});

/** A copy of the migrations with CRLF line endings, as a Windows checkout may have them. */
async function crlfMigrations() {
    dir = await mkdtemp(join(tmpdir(), 'lyfestyle-migrations-'));
    const entries = await readdir(migrationsFolder, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isDirectory())) {
        const sql = await readFile(join(migrationsFolder, entry.name, 'migration.sql'), 'utf8');
        await mkdir(join(dir, entry.name));
        await writeFile(
            join(dir, entry.name, 'migration.sql'),
            sql.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'),
        );
    }
    return dir;
}

/** A PGlite data directory holding the schema Drizzle created, with no Prisma history. */
async function drizzleEraDatabase(sql: (baseline: string) => string = (s) => s) {
    dir = await mkdtemp(join(tmpdir(), 'lyfestyle-migrate-'));
    const baseline = await readFile(join(migrationsFolder, '0_init', 'migration.sql'), 'utf8');
    const pglite = new PGlite(dir);
    await pglite.exec(sql(baseline));
    await pglite.exec(`insert into pages (title) values ('Kept')`);
    await pglite.exec(
        `insert into jobs (name, prompt, schedule) values ('Briefing', 'Say "hi"', '0 7 * * *')`,
    );
    await pglite.close();
    return dir;
}

// Each case boots on-disk PGlite more than once, which is slow next to the in-memory suites.
describe('migrations', { timeout: 30_000 }, () => {
    it('adopts a database Drizzle created without re-running the baseline', async () => {
        const dataDir = await drizzleEraDatabase();
        for (let open = 0; open < 2; open++) {
            const { db, close } = await openPglite(migrationsFolder, new PGlite(dataDir));
            expect(await db.page.findMany({ select: { title: true } })).toEqual([
                { title: 'Kept' },
            ]);
            const applied = await db.$queryRaw<{ name: string }[]>`
                select migration_name as name from _prisma_migrations order by migration_name`;
            expect(applied.map((m) => m.name)).toEqual([
                '0_init',
                '20261027194110_automations',
                '20261028143912_review_fixes',
            ]);
            // Jobs carry over as automations that hand their prompt to the agent.
            expect(await db.automation.findMany({ select: { name: true, code: true } })).toEqual([
                { name: 'Briefing', code: 'export default (ctx) => ctx.agent("Say \\"hi\\"");' },
            ]);
            await close();
        }
    });

    it('refuses a Drizzle database that is missing its last migration', async () => {
        const dataDir = await drizzleEraDatabase((s) =>
            s.slice(0, s.indexOf('CREATE TABLE "page_views"')),
        );
        await expect(openPglite(migrationsFolder, new PGlite(dataDir))).rejects.toThrow(
            'predates the last Drizzle migration',
        );
    });

    it('warns, but still migrates, when applied migrations and the folder disagree', async () => {
        const pglite = new PGlite();
        try {
            await migratePglite(pglite, migrationsFolder);
            await pglite.query(
                `update _prisma_migrations set checksum = 'edited' where migration_name = '0_init'`,
            );
            await pglite.query(
                `insert into _prisma_migrations
                    (id, checksum, migration_name, finished_at, applied_steps_count)
                 values ($1, 'newer', '29990101000000_from_newer_code', now(), 1)`,
                [randomUUID()],
            );
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            await migratePglite(pglite, migrationsFolder);
            expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
                expect.stringContaining(
                    'applied migrations this build does not have: 29990101000000_from_newer_code',
                ),
                expect.stringContaining('migrations changed after they were applied: 0_init.'),
            ]);
        } finally {
            await pglite.close();
        }
    });

    it('does not warn about a checkout with CRLF line endings', async () => {
        const crlf = await crlfMigrations();
        const pglite = new PGlite();
        try {
            await migratePglite(pglite, migrationsFolder);
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            await migratePglite(pglite, crlf);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            await pglite.close();
        }
    });
});
