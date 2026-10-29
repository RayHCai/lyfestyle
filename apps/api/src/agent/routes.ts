import { runEventInput, runKind, runStatus } from '@lyfestyle/shared';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { pageQuery } from '../lib/pagination.js';
import { timeZone } from '../lib/timezone.js';
import { byId, validate } from '../lib/validate.js';
import type { Services } from '../services.js';

const KEEPALIVE_MS = 15_000;

/** Every event type, derived from the protocol so a new one is filterable without a change here. */
const eventType = z.enum([...runEventInput.options.map((o) => o.shape.type.value), 'status']);

export const conversationsRoutes = ({ conversations }: Services) =>
    new Hono()
        .basePath('/conversations')
        .get('/', validate('query', z.object(pageQuery)), async (c) =>
            c.json(await conversations.list(c.req.valid('query'))),
        )
        .post(
            '/',
            validate('json', z.object({ title: z.string().trim().min(1).max(200).optional() })),
            async (c) => c.json(await conversations.create(c.req.valid('json')), 201),
        )
        .get('/:id', byId, async (c) => c.json(await conversations.get(c.req.valid('param').id)))
        .patch(
            '/:id',
            byId,
            validate('json', z.object({ title: z.string().trim().min(1).max(200) })),
            async (c) =>
                c.json(
                    await conversations.rename(c.req.valid('param').id, c.req.valid('json').title),
                ),
        )
        .delete('/:id', byId, async (c) =>
            c.json(await conversations.remove(c.req.valid('param').id)),
        )
        .post(
            '/:id/messages',
            byId,
            validate(
                'json',
                z.object({
                    text: z.string().trim().min(1).max(100_000),
                    /** An earlier user message to replace: it and everything after it are dropped. */
                    from: z.uuid().optional(),
                }),
            ),
            async (c) => {
                const { text, from } = c.req.valid('json');
                return c.json(await conversations.send(c.req.valid('param').id, text, from), 201);
            },
        );

const claimBody = z.object({
    runnerId: z.string().min(1).max(200),
    harness: z.string().min(1).max(100),
    /** Leave runs of other kinds to other runners, e.g. automations to a cloud runner. */
    kinds: z.array(runKind).min(1).optional(),
    waitMs: z.number().int().min(0).max(30_000).default(0),
});

const completeBody = z.object({
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    output: z.string().max(1_000_000).optional(),
    error: z.string().max(10_000).optional(),
});

export const runsRoutes = ({ runs }: Services) =>
    new Hono()
        .basePath('/runs')
        .get(
            '/',
            validate(
                'query',
                z.object({
                    status: runStatus.optional(),
                    kind: runKind.optional(),
                    automationRunId: z.uuid().optional(),
                    conversationId: z.uuid().optional(),
                    ...pageQuery,
                }),
            ),
            async (c) => c.json(await runs.list(c.req.valid('query'))),
        )
        .post('/claim', validate('json', claimBody), async (c) => {
            const { waitMs, ...runner } = c.req.valid('json');
            const claimed = await runs.claimWait(runner, waitMs, c.req.raw.signal);
            return claimed ? c.json(claimed) : c.body(null, 204);
        })
        .get('/:id', byId, async (c) => c.json(await runs.get(c.req.valid('param').id)))
        .get(
            '/:id/events',
            byId,
            validate(
                'query',
                z.object({
                    after: z.coerce.number().int().nonnegative().optional(),
                    type: eventType.optional(),
                    limit: z.coerce.number().int().min(1).max(1000).default(500),
                }),
            ),
            async (c) => {
                const { id } = c.req.valid('param');
                await runs.get(id);
                return c.json({ items: await runs.events(id, c.req.valid('query')) });
            },
        )
        .get(
            '/:id/stream',
            byId,
            validate(
                'query',
                z.object({ after: z.coerce.number().int().nonnegative().optional() }),
            ),
            async (c) => {
                const { id } = c.req.valid('param');
                await runs.get(id);
                const resumeFrom = Number(
                    c.req.header('last-event-id') ?? c.req.valid('query').after ?? 0,
                );
                if (!Number.isSafeInteger(resumeFrom)) throw badRequest('Invalid Last-Event-ID');

                return streamSSE(c, async (stream) => {
                    const abort = new AbortController();
                    stream.onAbort(() => abort.abort());
                    const events = runs.follow(id, resumeFrom, {
                        signal: abort.signal,
                        idleMs: KEEPALIVE_MS,
                    });
                    for await (const event of events) {
                        await stream.writeSSE(
                            event
                                ? {
                                      id: String(event.id),
                                      event: event.type,
                                      data: JSON.stringify(event),
                                  }
                                : { event: 'ping', data: '' },
                        );
                    }
                });
            },
        )
        .post('/:id/cancel', byId, async (c) => c.json(await runs.cancel(c.req.valid('param').id)))
        .post(
            '/:id/events',
            byId,
            validate('json', z.object({ events: z.array(runEventInput).min(1).max(200) })),
            async (c) =>
                c.json(await runs.report(c.req.valid('param').id, c.req.valid('json').events)),
        )
        .post('/:id/heartbeat', byId, async (c) =>
            c.json(await runs.heartbeat(c.req.valid('param').id)),
        )
        .post('/:id/complete', byId, validate('json', completeBody), async (c) =>
            c.json(await runs.complete(c.req.valid('param').id, c.req.valid('json'))),
        );

export const usageRoutes = ({ usage }: Services) =>
    new Hono().basePath('/usage').get(
        '/',
        validate(
            'query',
            z.object({
                from: z.coerce.date().optional(),
                to: z.coerce.date().optional(),
                groupBy: z.enum(['day', 'model', 'kind', 'harness', 'automation']).default('day'),
                timezone: timeZone.default('UTC'),
            }),
        ),
        async (c) => c.json(await usage.summary(c.req.valid('query'))),
    );
