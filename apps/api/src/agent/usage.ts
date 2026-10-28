import { Prisma, type Db } from '../db/client.js';
import { createdDay, createdWithin, groupedTotals, whereAll } from '../lib/report.js';

type UsageGrouping = 'day' | 'model' | 'kind' | 'harness' | 'automation';

interface UsageTotals {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
}

const totals = Prisma.sql`
    count(distinct run_id)::int as "runs",
    coalesce(sum(input_tokens), 0)::float8 as "inputTokens",
    coalesce(sum(output_tokens), 0)::float8 as "outputTokens",
    coalesce(sum(cache_read_tokens), 0)::float8 as "cacheReadTokens",
    coalesce(sum(cache_write_tokens), 0)::float8 as "cacheWriteTokens",
    coalesce(sum(cost_usd), 0)::float8 as "costUsd"`;

export function createUsageService(db: Db) {
    return {
        /** Token and cost totals for this app's agent runs, overall and per group. */
        async summary(options: {
            from?: Date | undefined;
            to?: Date | undefined;
            groupBy: UsageGrouping;
            timezone: string;
        }) {
            const key = {
                day: createdDay(options.timezone),
                model: Prisma.sql`model`,
                kind: Prisma.sql`kind`,
                harness: Prisma.sql`harness`,
                automation: Prisma.sql`automation_id::text`,
            }[options.groupBy];
            const report = await groupedTotals<UsageTotals>(db, {
                table: 'usage_records',
                totals,
                key,
                where: whereAll(createdWithin(options)),
            });
            return { groupBy: options.groupBy, ...report };
        },
    };
}
