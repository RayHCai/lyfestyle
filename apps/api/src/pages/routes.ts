import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';

export const pageFields = {
    title: z.string().max(500),
    content: z.string().max(1_000_000),
    icon: z.string().max(64).nullable(),
};

const draft = z.object({
    title: pageFields.title.optional(),
    content: pageFields.content.optional(),
    icon: pageFields.icon.optional(),
});

const byId = validate('param', z.object({ id: z.uuid() }));

export const pagesRoutes = ({ pages }: Services) =>
    new Hono()
        .basePath('/pages')
        .get(
            '/',
            validate(
                'query',
                z.object({
                    q: z.string().trim().min(1).optional(),
                    deleted: z.stringbool().default(false),
                    ...pageQuery,
                }),
            ),
            async (c) => {
                const { q, deleted, limit, cursor } = c.req.valid('query');
                if (q) return c.json({ items: await pages.search(q, limit), nextCursor: null });
                return c.json(await pages.list({ limit, cursor, deleted }));
            },
        )
        .post('/', validate('json', draft.extend({ id: z.uuid().optional() })), async (c) =>
            c.json(await pages.create(c.req.valid('json')), 201),
        )
        .get('/graph', async (c) => c.json(await pages.graph()))
        .get('/:id', byId, async (c) => c.json(await pages.get(c.req.valid('param').id)))
        .patch(
            '/:id',
            byId,
            validate('json', draft.extend({ baseVersion: z.number().int().positive().optional() })),
            async (c) => {
                const { baseVersion, ...changes } = c.req.valid('json');
                return c.json(await pages.update(c.req.valid('param').id, changes, baseVersion));
            },
        )
        .delete(
            '/:id',
            byId,
            validate(
                'query',
                z.object({ baseVersion: z.coerce.number().int().positive().optional() }),
            ),
            async (c) =>
                c.json(
                    await pages.remove(c.req.valid('param').id, c.req.valid('query').baseVersion),
                ),
        )
        .post('/:id/restore', byId, async (c) =>
            c.json(await pages.restore(c.req.valid('param').id)),
        )
        .post(
            '/:id/append',
            byId,
            validate('json', z.object({ content: z.string().min(1).max(1_000_000) })),
            async (c) =>
                c.json(await pages.append(c.req.valid('param').id, c.req.valid('json').content)),
        )
        .get('/:id/backlinks', byId, async (c) =>
            c.json({ items: await pages.backlinks(c.req.valid('param').id) }),
        )
        .get('/:id/links', byId, async (c) =>
            c.json({ items: await pages.links(c.req.valid('param').id) }),
        );
