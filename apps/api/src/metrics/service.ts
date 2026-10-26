import { and, asc, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pageViews } from '../db/schema.js';
import { decodeCursor, paginate } from '../lib/pagination.js';

export type ViewGrouping = 'day' | 'origin' | 'path' | 'referrer';

export interface ViewInput {
    origin: string;
    path: string;
    url: string;
    title?: string | null | undefined;
    referrer?: string | null | undefined;
    ip?: string | null | undefined;
    userAgent?: string | null | undefined;
    language?: string | null | undefined;
    props?: Record<string, unknown> | undefined;
}

export interface ViewFilter {
    from?: Date | undefined;
    to?: Date | undefined;
    origin?: string | undefined;
}

const totals = {
    views: sql<number>`count(*)::int`,
    visitors: sql<number>`count(distinct ${pageViews.ip})::int`,
};

const referrerHost = sql<
    string | null
>`substring(${pageViews.referrer} from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)')`;

export type MetricsService = ReturnType<typeof createMetricsService>;

export function createMetricsService(db: Db, now: () => Date) {
    const matching = (filter: ViewFilter) =>
        and(
            filter.from ? gte(pageViews.createdAt, filter.from) : undefined,
            filter.to ? lt(pageViews.createdAt, filter.to) : undefined,
            filter.origin ? eq(pageViews.origin, filter.origin) : undefined,
        );

    return {
        async record(input: ViewInput) {
            await db.insert(pageViews).values({
                origin: input.origin,
                path: input.path,
                url: input.url,
                title: input.title ?? null,
                referrer: input.referrer ?? null,
                ip: input.ip ?? null,
                userAgent: input.userAgent ?? null,
                language: input.language ?? null,
                props: input.props ?? {},
                createdAt: now(),
            });
        },

        /** View and unique-IP totals, overall and per group. */
        async summary(options: ViewFilter & { groupBy: ViewGrouping; timezone: string }) {
            const where = matching(options);
            const key: SQL<string | null> = {
                day: sql<string>`to_char(${pageViews.createdAt} at time zone ${options.timezone}, 'YYYY-MM-DD')`,
                origin: sql<string>`${pageViews.origin}`,
                path: sql<string>`${pageViews.path}`,
                referrer: referrerHost,
            }[options.groupBy];
            const [overall, groups] = await Promise.all([
                db.select(totals).from(pageViews).where(where),
                db
                    .select({ key: key.as('key'), ...totals })
                    .from(pageViews)
                    .where(where)
                    .groupBy(sql`1`)
                    .orderBy(
                        ...(options.groupBy === 'day'
                            ? [asc(sql`1`)]
                            : [desc(sql`2`), asc(sql`1`)]),
                    ),
            ]);
            return { groupBy: options.groupBy, totals: overall[0]!, groups };
        },

        /** Raw views, newest first. */
        async list(options: ViewFilter & { limit: number; cursor?: string | undefined }) {
            const after = decodeCursor(options.cursor);
            const rows = await db
                .select()
                .from(pageViews)
                .where(
                    and(
                        matching(options),
                        after
                            ? sql`(${pageViews.createdAt}, ${pageViews.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`
                            : undefined,
                    ),
                )
                .orderBy(desc(pageViews.createdAt), desc(pageViews.id))
                .limit(options.limit + 1);
            return paginate(rows, options.limit, (r) => ({ at: r.createdAt, id: r.id }));
        },
    };
}
