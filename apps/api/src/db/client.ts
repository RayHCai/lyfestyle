import type { ContentBlock, MessageRole, RunKind, RunStatus } from '@lyfestyle/shared';
import type { ITXClientDenyList } from '@prisma/client/runtime/client';
import { Prisma, PrismaClient } from './generated/client.js';
import { migrate, type MigrationTx } from './migrate.js';

export { Prisma };

export type TodoScope = 'day' | 'week';
export type McpTransport = 'http' | 'sse' | 'stdio';
export type Provider = 'canvas';
/** `cancelled`: stopped on purpose (deleted, disabled or shut down), which notifies no one. */
export type AutomationRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AutomationTrigger = 'schedule' | 'manual';
export type DeployStatus = 'pending' | 'approved' | 'rejected';
/** The kind of agent run that proposed a deploy, or `user` for a direct tool call. */
export type DeployOrigin = RunKind | 'user';
export interface AutomationLog {
    at: string;
    level: 'info' | 'warn' | 'error';
    message: string;
}

/** `date` columns travel as `YYYY-MM-DD`, the way the API and its clients use them. */
export const toDay = (value: Date) => value.toISOString().slice(0, 10);
export const fromDay = (day: string) => new Date(`${day}T00:00:00.000Z`);

/**
 * Narrows what the Prisma schema cannot express: text columns holding unions, JSON shapes, and
 * bigint counters that stay well inside a JS number (and must, to serialise as JSON).
 */
function narrow(client: PrismaClient) {
    return client.$extends({
        result: {
            page: {
                seq: { needs: { seq: true }, compute: (r) => Number(r.seq) },
            },
            todo: {
                scope: { needs: { scope: true }, compute: (r) => r.scope as TodoScope },
                date: { needs: { date: true }, compute: (r) => toDay(r.date) },
            },
            goal: {
                month: { needs: { month: true }, compute: (r) => toDay(r.month) },
            },
            run: {
                kind: { needs: { kind: true }, compute: (r) => r.kind as RunKind },
                status: { needs: { status: true }, compute: (r) => r.status as RunStatus },
            },
            automationRun: {
                status: {
                    needs: { status: true },
                    compute: (r) => r.status as AutomationRunStatus,
                },
                trigger: {
                    needs: { trigger: true },
                    compute: (r) => r.trigger as AutomationTrigger,
                },
                logs: {
                    needs: { logs: true },
                    compute: (r) => r.logs as unknown as AutomationLog[],
                },
            },
            automationDeploy: {
                status: { needs: { status: true }, compute: (r) => r.status as DeployStatus },
                origin: { needs: { origin: true }, compute: (r) => r.origin as DeployOrigin },
            },
            notification: {
                id: { needs: { id: true }, compute: (r) => Number(r.id) },
            },
            message: {
                ordinal: { needs: { ordinal: true }, compute: (r) => Number(r.ordinal) },
                role: { needs: { role: true }, compute: (r) => r.role as MessageRole },
                content: {
                    needs: { content: true },
                    compute: (r) => r.content as unknown as ContentBlock[],
                },
            },
            runEvent: {
                id: { needs: { id: true }, compute: (r) => Number(r.id) },
                data: {
                    needs: { data: true },
                    compute: (r) => r.data as Record<string, unknown>,
                },
            },
            usageRecord: {
                kind: { needs: { kind: true }, compute: (r) => r.kind as RunKind },
            },
            integration: {
                provider: { needs: { provider: true }, compute: (r) => r.provider as Provider },
                config: {
                    needs: { config: true },
                    compute: (r) => r.config as Record<string, unknown>,
                },
            },
            pageView: {
                props: {
                    needs: { props: true },
                    compute: (r) => r.props as Record<string, unknown>,
                },
            },
            mcpServer: {
                transport: {
                    needs: { transport: true },
                    compute: (r) => r.transport as McpTransport,
                },
                args: { needs: { args: true }, compute: (r) => r.args as string[] },
            },
        },
    });
}

export type Db = ReturnType<typeof narrow>;

/** A row of one model as queries return it, with the narrowed column types. */
export type Row<M extends Uncapitalize<Prisma.ModelName>> = NonNullable<
    Awaited<ReturnType<Db[M]['findFirst']>>
>;

/** `db` itself or the client inside `db.$transaction(...)`; both run the same queries. */
export type Tx = Omit<Db, ITXClientDenyList>;

/** `pg_advisory_xact_lock`: held until the surrounding transaction ends. */
export async function advisoryLock(tx: Tx, key: number) {
    await tx.$executeRaw`select pg_advisory_xact_lock(${key}::bigint)`;
}

/** `select ... for update` on one row, which Prisma's query API cannot express. */
export async function lockRow(
    tx: Tx,
    table: 'conversations' | 'automations' | 'automation_deploys' | 'runs',
    id: string,
) {
    await tx.$executeRaw`select 1 from ${Prisma.raw(table)} where id = ${id}::uuid for update`;
}

export interface Database {
    db: Db;
    close(): Promise<void>;
}

/** Claims and page writes wait on advisory locks, so allow more than Prisma's 5 s default. */
const transactionOptions = { maxWait: 10_000, timeout: 30_000 };

type DriverAdapter = NonNullable<
    NonNullable<ConstructorParameters<typeof PrismaClient>[0]>['adapter']
>;

/** The narrowed client every service uses, over a Prisma driver adapter. */
export function createDb(adapter: DriverAdapter): { db: Db; disconnect(): Promise<void> } {
    const client = new PrismaClient({ adapter, transactionOptions });
    return { db: narrow(client), disconnect: () => client.$disconnect() };
}

/** Connects to Postgres, applies any pending migrations, and returns the client. */
export async function openDatabase(options: {
    url: string;
    migrationsFolder: string;
}): Promise<Database> {
    const { url, migrationsFolder } = options;
    const { Client, Pool } = (await import('pg')).default;
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const host = new URL(url).host;
    // Hosted Postgres sits behind a proxy that drops idle TCP connections without telling the
    // client. Without keepalive and timeouts a dead socket hangs its query, the transaction holding
    // it never ends, and once the pool is full every transaction fails with P2028. The connect
    // timeout stays under `transactionOptions.maxWait` so a slow connect reports its real cause.
    const pool = new Pool({
        connectionString: url,
        max: 10,
        connectionTimeoutMillis: 8_000,
        idleTimeoutMillis: 30_000,
        keepAlive: true,
        query_timeout: 30_000,
    });
    // An idle client whose connection drops emits here; unhandled, it would crash the process.
    pool.on('error', (err) => console.error('Postgres pool client error', err));
    await closeOnFailure(
        pool.end.bind(pool),
        // A connection of its own: the pool's 30 s query timeout would abort a long migration.
        migrate(async (fn) => {
            const conn = new Client({ connectionString: url, connectionTimeoutMillis: 8_000 });
            await conn.connect().catch((err: Error) => {
                throw new Error(`Cannot reach Postgres at ${host}: ${err.message}`, {
                    cause: err,
                });
            });
            const tx: MigrationTx = {
                exec: async (sql) => void (await conn.query(sql)),
                query: async (sql, params) => (await conn.query(sql, params)).rows,
            };
            try {
                await conn.query('begin');
                const result = await fn(tx);
                await conn.query('commit');
                return result;
            } catch (err) {
                // A failed rollback must not hide why the migration failed.
                await conn.query('rollback').catch(() => undefined);
                throw err;
            } finally {
                await conn.end().catch(() => undefined);
            }
        }, migrationsFolder),
    );
    const { db, disconnect } = createDb(new PrismaPg(pool));
    return {
        db,
        close: async () => {
            await disconnect();
            await pool.end();
        },
    };
}

export async function closeOnFailure(close: () => Promise<void>, work: Promise<void>) {
    try {
        await work;
    } catch (err) {
        await close();
        throw err;
    }
}
