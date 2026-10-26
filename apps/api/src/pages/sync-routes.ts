import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';
import type { ChangeResult } from './service.js';
import { pageFields } from './routes.js';

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
            validate('json', z.object({ changes: z.array(change).max(500) })),
            async (c) => {
                const results: ChangeResult[] = [];
                for (const item of c.req.valid('json').changes) {
                    results.push(await pages.applyChange(item));
                }
                return c.json({ results });
            },
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
