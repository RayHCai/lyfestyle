import { DAY_MS } from '@lyfestyle/shared';
import { z } from 'zod';
import type { Config } from '../config.js';
import { Prisma, type Db } from '../db/client.js';
import { badRequest, forbidden, invalid, rateLimited } from '../lib/errors.js';
import { keyset, paginate } from '../lib/pagination.js';
import { createDailyCap, createRateLimiter } from '../lib/rate-limit.js';
import { createdDay, createdWithin, groupedTotals, whereAll } from '../lib/report.js';

type ViewGrouping = 'day' | 'origin' | 'path' | 'referrer';

interface ViewFilter {
    from?: Date | undefined;
    to?: Date | undefined;
    origin?: string | undefined;
}

/** A page view report as the tracker sends it. */
const viewBody = z.object({
    url: z.url({ protocol: /^https?$/ }).max(2048),
    title: z.string().max(300).nullish(),
    referrer: z.string().max(2048).nullish(),
    language: z.string().max(35).nullish(),
    props: z
        .record(
            z.string().max(50),
            z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
        )
        .refine((p) => Object.keys(p).length <= 20, 'At most 20 props')
        .optional(),
});

/** What `/metrics/collect` hands over: the raw body and the request headers that matter. */
interface Beacon {
    body: string;
    origin: string | undefined;
    forwardedFor: string | undefined;
    /** The socket peer, when the request arrived over one. */
    remoteAddress: string | null;
    userAgent: string | undefined;
}

/** The anonymous endpoint writes to the production database, so it is capped. */
const DEFAULT_LIMITS = { perIpPerMinute: 60, perDay: 10_000 };

const totals = Prisma.sql`count(*)::int as views, count(distinct ip)::int as visitors`;

const referrerHost = Prisma.sql`substring(referrer from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)')`;

interface Totals {
    views: number;
    visitors: number;
}

/**
 * The visitor's address. Railway's proxy appends the peer it saw to X-Forwarded-For, so the
 * rightmost entry is the one a visitor cannot forge; earlier entries are whatever the client sent.
 * Which hop Railway appends is unverified: if every view shows one proxy address, revisit this.
 */
function clientIp(beacon: Beacon): string | null {
    const hops = beacon.forwardedFor
        ?.split(',')
        .map((hop) => hop.trim())
        .filter(Boolean);
    return (hops?.at(-1) ?? beacon.remoteAddress)?.slice(0, 64) ?? null;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw badRequest('Body must be JSON');
    }
}

export function createMetricsService(deps: {
    db: Db;
    now: () => Date;
    config: Pick<Config, 'metricsOrigins' | 'metricsRetentionDays'>;
    limits?: { perIpPerMinute: number; perDay: number };
}) {
    const { db, now, config } = deps;
    const limits = deps.limits ?? DEFAULT_LIMITS;
    const perIp = createRateLimiter({ perMinute: limits.perIpPerMinute });
    const daily = createDailyCap(limits.perDay);

    const matching = (filter: ViewFilter) => ({
        ...(filter.from || filter.to
            ? {
                  createdAt: {
                      ...(filter.from ? { gte: filter.from } : {}),
                      ...(filter.to ? { lt: filter.to } : {}),
                  },
              }
            : {}),
        ...(filter.origin ? { origin: filter.origin } : {}),
    });

    return {
        /**
         * Records a beacon from a website, or throws: 429 past the per-address or daily limit,
         * 400 for a malformed body or an Origin that disagrees with `url`, 403 for a site not in
         * `METRICS_ORIGINS`.
         */
        async collect(beacon: Beacon) {
            const at = now();
            const ip = clientIp(beacon);
            if (!perIp.take(ip ?? 'unknown', at.getTime())) {
                throw rateLimited('Too many views from this address');
            }
            const parsed = viewBody.safeParse(parseJson(beacon.body));
            if (!parsed.success) throw invalid(parsed.error);
            const view = parsed.data;
            const page = new URL(view.url);
            // Browsers send Origin with every POST; `null` means the page hid it.
            const origin = beacon.origin === 'null' ? undefined : beacon.origin;
            if (origin !== undefined && origin !== page.origin) {
                throw badRequest('Origin header does not match url');
            }
            if (config.metricsOrigins !== '*') {
                // Without an Origin, anyone could report views for a listed site by naming it.
                if (origin === undefined) throw forbidden('Origin header required');
                if (!config.metricsOrigins.includes(page.origin)) {
                    throw forbidden('Origin not accepted');
                }
            }
            if (!daily.take(at)) throw rateLimited('Daily view limit reached');
            await db.pageView.create({
                data: {
                    origin: page.origin,
                    path: page.pathname,
                    url: view.url,
                    title: view.title ?? null,
                    referrer: view.referrer || null,
                    ip,
                    userAgent: beacon.userAgent?.slice(0, 500) ?? null,
                    language: view.language ?? null,
                    props: (view.props ?? {}) as Prisma.InputJsonObject,
                    createdAt: at,
                },
            });
        },

        /** View and unique-IP totals, overall and per group. */
        async summary(options: ViewFilter & { groupBy: ViewGrouping; timezone: string }) {
            const key = {
                day: createdDay(options.timezone),
                origin: Prisma.sql`origin`,
                path: Prisma.sql`path`,
                referrer: referrerHost,
            }[options.groupBy];
            const report = await groupedTotals<Totals>(db, {
                table: 'page_views',
                totals,
                key,
                where: whereAll([
                    ...createdWithin(options),
                    options.origin ? Prisma.sql`origin = ${options.origin}` : undefined,
                ]),
                order: options.groupBy === 'day' ? Prisma.sql`1` : Prisma.sql`2 desc, 1`,
            });
            return { groupBy: options.groupBy, ...report };
        },

        /** Raw views, newest first. */
        async list(options: ViewFilter & { limit: number; cursor?: string | undefined }) {
            const page = keyset('createdAt', options);
            const rows = await db.pageView.findMany({
                ...page,
                where: { ...matching(options), ...page.where },
            });
            return paginate(rows, options.limit, 'createdAt');
        },

        /** Deletes views older than `METRICS_RETENTION_DAYS` (none when it is 0); answers how many. */
        async purgeExpired(at: Date): Promise<number> {
            if (!config.metricsRetentionDays) return 0;
            const cutoff = new Date(at.getTime() - config.metricsRetentionDays * DAY_MS);
            const { count } = await db.pageView.deleteMany({
                where: { createdAt: { lt: cutoff } },
            });
            return count;
        },
    };
}
