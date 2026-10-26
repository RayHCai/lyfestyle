import { z } from 'zod';
import { badRequest } from './errors.js';

/** Keyset position after the last item of a page ordered by `(timestamp, id)` descending. */
export interface Cursor {
    at: Date;
    id: string;
}

export function encodeCursor(at: Date, id: string): string {
    return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Cursor | undefined {
    if (!cursor) return undefined;
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const date = new Date(at ?? '');
    if (!id || Number.isNaN(date.getTime())) throw badRequest('Invalid cursor');
    return { at: date, id };
}

export const pageQuery = {
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
};

export function paginate<T>(rows: T[], limit: number, key: (row: T) => Cursor) {
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
        items,
        nextCursor: rows.length > limit && last ? encodeCursor(key(last).at, key(last).id) : null,
    };
}
