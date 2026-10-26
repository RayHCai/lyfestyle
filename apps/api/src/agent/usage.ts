import { and, asc, gte, lt, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { usageRecords } from '../db/schema.js';

export type UsageGrouping = 'day' | 'model' | 'kind' | 'harness' | 'job';

const sum = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)::float8`;

const totals = {
    runs: sql<number>`count(distinct ${usageRecords.runId})::int`,
    inputTokens: sum(usageRecords.inputTokens),
    outputTokens: sum(usageRecords.outputTokens),
    cacheReadTokens: sum(usageRecords.cacheReadTokens),
    cacheWriteTokens: sum(usageRecords.cacheWriteTokens),
    costUsd: sum(usageRecords.costUsd),
};

export function createUsageService(db: Db) {
    return {
        /** Token and cost totals for this app's agent runs, overall and per group. */
        async summary(options: {
            from?: Date | undefined;
            to?: Date | undefined;
            groupBy: UsageGrouping;
            timezone: string;
        }) {
            const where = and(
                options.from ? gte(usageRecords.createdAt, options.from) : undefined,
                options.to ? lt(usageRecords.createdAt, options.to) : undefined,
            );
            const key: SQL<string | null> = {
                day: sql<string>`to_char(${usageRecords.createdAt} at time zone ${options.timezone}, 'YYYY-MM-DD')`,
                model: sql<string>`${usageRecords.model}`,
                kind: sql<string>`${usageRecords.kind}`,
                harness: sql<string>`${usageRecords.harness}`,
                job: sql<string | null>`${usageRecords.jobId}::text`,
            }[options.groupBy];
            const [overall, groups] = await Promise.all([
                db.select(totals).from(usageRecords).where(where),
                db
                    .select({ key: key.as('key'), ...totals })
                    .from(usageRecords)
                    .where(where)
                    .groupBy(sql`1`)
                    .orderBy(asc(sql`1`)),
            ]);
            return { groupBy: options.groupBy, totals: overall[0]!, groups };
        },
    };
}
