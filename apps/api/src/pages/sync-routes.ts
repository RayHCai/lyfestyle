import { Hono } from 'hono';
import { z } from 'zod';
import { limitBody, validate } from '../lib/validate.js';
import type { Services } from '../services.js';
import { pageFields } from './schema.js';

/** 500 changes of up to a million characters each would parse to gigabytes in memory. */
const PUSH_BODY_BYTES = 10 * 1024 * 1024;

const change = z.object({
    id: z.uuid(),
    baseVersion: z.number().int().positive().nullable(),
    ...pageFields,
    deleted: z.boolean(),
});

export const syncRoutes = ({ pages }: Services) =>
    new Hono()
        .basePath('/sync')
        .post(
            '/push',
            limitBody(PUSH_BODY_BYTES),
            validate('json', z.object({ changes: z.array(change).max(500) })),
            async (c) => c.json({ results: await pages.applyChanges(c.req.valid('json').changes) }),
        )
        .get(
            '/pull',
            validate(
                'query',
                z.object({
                    cursor: z.coerce.number().int().nonnegative().default(0),
                    limit: z.coerce.number().int().min(1).max(1000).default(500),
                }),
            ),
            async (c) => {
                const { cursor, limit } = c.req.valid('query');
                return c.json(await pages.changesSince(cursor, limit));
            },
        );
