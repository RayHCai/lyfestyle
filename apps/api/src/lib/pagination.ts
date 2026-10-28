import { z } from 'zod';
import { badRequest } from './errors.js';

/** Keyset position after the last item of a page ordered by `(timestamp, id)` descending. */
export interface Cursor {
    at: Date;
    id: string;
}

function encodeCursor(at: Date, id: string): string {
    return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

const uuid = z.uuid();

export function decodeCursor(cursor: string | undefined): Cursor | undefined {
    if (!cursor) return undefined;
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const date = new Date(at ?? '');
    // The id reaches a uuid column; anything else would fail there as a 500.
    if (!uuid.safeParse(id).success || Number.isNaN(date.getTime())) {
        throw badRequest('Invalid cursor');
    }
    return { at: date, id: id! };
}

/** A Prisma `where` for rows after `cursor` in `(field, id)` descending order. */
function beyond<F extends string>(field: F, cursor: Cursor | undefined) {
    if (!cursor) return {};
    return {
        OR: [
            { [field]: { lt: cursor.at } } as Record<F, { lt: Date }>,
            { [field]: cursor.at, id: { lt: cursor.id } } as Record<F, Date> & {
                id: { lt: string };
            },
        ],
    };
}

export const pageQuery = {
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
};

/**
 * One page of rows newest first by `(field, id)`: spread `where` into the query's own filter and
 * pass `orderBy` and `take` as they are, then hand the rows to `paginate` with the same field.
 * The field's column must be millisecond precision, like the cursor (see schema.prisma).
 */
export function keyset<F extends string>(
    field: F,
    page: { limit: number; cursor?: string | undefined },
) {
    return {
        where: beyond(field, decodeCursor(page.cursor)),
        orderBy: [{ [field]: 'desc' }, { id: 'desc' }] as [Record<F, 'desc'>, { id: 'desc' }],
        take: page.limit + 1,
    };
}

export function paginate<F extends string, T extends { id: string } & Record<F, Date>>(
    rows: T[],
    limit: number,
    field: F,
) {
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
        items,
        nextCursor: rows.length > limit && last ? encodeCursor(last[field], last.id) : null,
    };
}
