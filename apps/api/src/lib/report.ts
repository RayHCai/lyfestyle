import { Prisma, type Db } from '../db/client.js';

type Condition = Prisma.Sql | undefined;

/** `where a and b …` over the conditions that apply, or nothing when none do. */
export function whereAll(conditions: Condition[]): Prisma.Sql {
    const present = conditions.filter((c) => c !== undefined);
    return present.length ? Prisma.sql`where ${Prisma.join(present, ' and ')}` : Prisma.empty;
}

/** `created_at` within `[from, to)`, either end optional. */
export const createdWithin = (range: {
    from?: Date | undefined;
    to?: Date | undefined;
}): Condition[] => [
    range.from ? Prisma.sql`created_at >= ${range.from}` : undefined,
    range.to ? Prisma.sql`created_at < ${range.to}` : undefined,
];

/** The calendar day `created_at` falls on in `timezone`, as `YYYY-MM-DD`. */
export const createdDay = (timezone: string) =>
    Prisma.sql`to_char(created_at at time zone ${timezone}, 'YYYY-MM-DD')`;

/**
 * The `totals` select list over the rows of `table` matching `where`, once overall and once per
 * `key` (ordered by `order`, the key by default).
 */
export async function groupedTotals<T extends object>(
    db: Db,
    query: {
        table: 'usage_records' | 'page_views';
        totals: Prisma.Sql;
        key: Prisma.Sql;
        where: Prisma.Sql;
        order?: Prisma.Sql;
    },
) {
    const table = Prisma.raw(query.table);
    const [overall, groups] = await Promise.all([
        db.$queryRaw<T[]>`select ${query.totals} from ${table} ${query.where}`,
        db.$queryRaw<(T & { key: string | null })[]>`
            select ${query.key} as key, ${query.totals} from ${table} ${query.where}
            group by 1 order by ${query.order ?? Prisma.sql`1`}`,
    ]);
    return { totals: overall[0]!, groups };
}
