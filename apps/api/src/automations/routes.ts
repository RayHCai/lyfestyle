import { DAY_MS } from '@lyfestyle/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { byId, validate } from '../lib/validate.js';
import type { Services } from '../services.js';
import { deployStatus } from './schema.js';

// No create or edit routes: code reaches an automation only through a deploy the agent proposes
// (the automations_deploy tool) and the user approves here.
export const automationsRoutes = ({ automations }: Services) =>
    new Hono()
        .basePath('/automations')
        .get('/', async (c) => c.json({ items: await automations.list() }))
        .get(
            '/deploys',
            validate('query', z.object({ status: deployStatus.optional() })),
            async (c) => c.json({ items: await automations.deploys(c.req.valid('query').status) }),
        )
        .get('/deploys/:id', byId, async (c) =>
            c.json(await automations.deploy(c.req.valid('param').id)),
        )
        .post('/deploys/:id/approve', byId, async (c) =>
            c.json(await automations.approve(c.req.valid('param').id)),
        )
        .post('/deploys/:id/reject', byId, async (c) =>
            c.json(await automations.reject(c.req.valid('param').id)),
        )
        .get(
            '/timeline',
            validate('query', z.object({ from: z.coerce.date(), to: z.coerce.date() })),
            async (c) => {
                const { from, to } = c.req.valid('query');
                if (to <= from || to.getTime() - from.getTime() > 7 * DAY_MS) {
                    throw badRequest('`to` must be after `from`, at most 7 days later');
                }
                return c.json(await automations.timeline(from, to));
            },
        )
        .get('/runs/:id', byId, async (c) => c.json(await automations.run(c.req.valid('param').id)))
        .get('/:id', byId, async (c) => c.json(await automations.get(c.req.valid('param').id)))
        .patch('/:id', byId, validate('json', z.object({ enabled: z.boolean() })), async (c) =>
            c.json(
                await automations.setEnabled(c.req.valid('param').id, c.req.valid('json').enabled),
            ),
        )
        .delete('/:id', byId, async (c) =>
            c.json(await automations.remove(c.req.valid('param').id)),
        )
        .post('/:id/trigger', byId, async (c) =>
            c.json(await automations.trigger(c.req.valid('param').id), 201),
        );
