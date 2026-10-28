import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';
import { notificationFields } from './schema.js';

export const notificationsRoutes = ({ notifications }: Services) =>
    new Hono()
        .basePath('/notifications')
        .get(
            '/',
            validate(
                'query',
                z.object({
                    after: z.coerce.number().int().nonnegative().optional(),
                    limit: z.coerce.number().int().min(1).max(100).default(50),
                }),
            ),
            async (c) => c.json(await notifications.list(c.req.valid('query'))),
        )
        .post('/', validate('json', z.object(notificationFields)), async (c) =>
            c.json(await notifications.create(c.req.valid('json')), 201),
        );
