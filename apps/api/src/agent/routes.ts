import { runEventInput, runKind, runStatus, type RunEvent } from '@lyfestyle/shared';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { pageQuery } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';
import { isTimeZone } from './jobs.js';

const byId = validate('param', z.object({ id: z.uuid() }));

const KEEPALIVE_MS = 15_000;
const BACKLOG_PAGE = 500;

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
            validate('json', z.object({ text: z.string().trim().min(1).max(100_000) })),
            async (c) =>
                c.json(
                    await conversations.send(c.req.valid('param').id, c.req.valid('json').text),
                    201,
                ),
        );

const claimBody = z.object({
    runnerId: z.string().min(1).max(200),
    harness: z.string().min(1).max(100),
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
                    jobId: z.uuid().optional(),
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
                    type: z.enum(['message', 'log', 'session', 'usage', 'status']).optional(),
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
                    let cursor = resumeFrom;
                    const queue: RunEvent[] = [];
                    let wake = () => {};
                    const off = runs.subscribe(id, (events) => {
                        queue.push(...events);
                        wake();
                    });
                    stream.onAbort(() => wake());

                    const flush = async () => {
                        while (queue.length) {
                            const event = queue.shift()!;
                            if (event.id <= cursor) continue;
                            cursor = event.id;
                            await stream.writeSSE({
                                id: String(event.id),
                                event: event.type,
                                data: JSON.stringify(event),
                            });
                            if (runs.isTerminal(event)) return true;
                        }
                        return false;
                    };

                    try {
                        for (;;) {
                            const page = await runs.events(id, {
                                after: cursor,
                                limit: BACKLOG_PAGE,
                            });
                            queue.unshift(...page);
                            if (await flush()) return;
                            if (page.length < BACKLOG_PAGE) break;
                        }
                        const run = await runs.get(id);
                        if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return;

                        while (!stream.aborted) {
                            if (await flush()) return;
                            await new Promise<void>((resolve) => {
                                const timer = setTimeout(resolve, KEEPALIVE_MS);
                                wake = () => {
                                    clearTimeout(timer);
                                    resolve();
                                };
                            });
                            if (!queue.length && !stream.aborted) {
                                await stream.writeSSE({ event: 'ping', data: '' });
                            }
                        }
                    } finally {
                        off();
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

const timezone = z.string().refine(isTimeZone, 'Unknown IANA time zone');

// No default here: under .partial() a default would overwrite the stored zone on every PATCH.
const jobInput = z.object({
    name: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(100_000),
    schedule: z.string().trim().min(1).max(200),
    timezone: timezone.optional(),
    enabled: z.boolean().optional(),
});

export const jobsRoutes = ({ jobs }: Services) =>
    new Hono()
        .basePath('/jobs')
        .get('/', async (c) => c.json({ items: await jobs.list() }))
        .post('/', validate('json', jobInput), async (c) =>
            c.json(await jobs.create(c.req.valid('json')), 201),
        )
        .get('/:id', byId, async (c) => c.json(await jobs.get(c.req.valid('param').id)))
        .patch('/:id', byId, validate('json', jobInput.partial()), async (c) =>
            c.json(await jobs.update(c.req.valid('param').id, c.req.valid('json'))),
        )
        .delete('/:id', byId, async (c) => c.json(await jobs.remove(c.req.valid('param').id)))
        .post('/:id/trigger', byId, async (c) =>
            c.json(await jobs.trigger(c.req.valid('param').id), 201),
        );

export const usageRoutes = ({ usage }: Services) =>
    new Hono().basePath('/usage').get(
        '/',
        validate(
            'query',
            z.object({
                from: z.coerce.date().optional(),
                to: z.coerce.date().optional(),
                groupBy: z.enum(['day', 'model', 'kind', 'harness', 'job']).default('day'),
                timezone: timezone.default('UTC'),
            }),
        ),
        async (c) => c.json(await usage.summary(c.req.valid('query'))),
    );
