import type { RunEvent } from '@lyfestyle/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, TEST_TOKEN, type TestContext } from '../src/testing.js';

let t: TestContext;
let clock = new Date('2026-10-26T12:00:00Z');
beforeAll(async () => {
    t = await createTestContext({ now: () => clock });
});
afterAll(() => t.close());

const runner = { runnerId: 'laptop', harness: 'fake' };

async function claim(waitMs = 0) {
    return t.call('POST', '/runs/claim', { ...runner, waitMs });
}

async function drainQueue() {
    while ((await claim()).status === 200) {
        // Earlier tests may leave queued runs behind.
    }
}

async function readStream(path: string): Promise<RunEvent[]> {
    const res = await t.app.request(path, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    return text
        .split('\n\n')
        .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
        .filter((line): line is string => Boolean(line) && line !== 'data: ')
        .map((line) => JSON.parse(line.slice(6)) as RunEvent);
}

describe('conversations', () => {
    it('stores a message, queues a turn, and records what the harness reports', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        const sent = await t.call('POST', `/conversations/${convo.id}/messages`, {
            text: 'What is on my plate today?\nThanks',
        });
        expect(sent.status).toBe(201);
        expect(sent.body.run).toMatchObject({
            kind: 'chat',
            status: 'queued',
            conversationId: convo.id,
        });

        const claimed = await claim();
        expect(claimed.status).toBe(200);
        expect(claimed.body.run).toMatchObject({
            id: sent.body.run.id,
            status: 'running',
            runnerId: 'laptop',
        });
        expect(claimed.body.history).toEqual([]);
        expect(claimed.body.session).toBeNull();

        const runId = claimed.body.run.id;
        const report = await t.call('POST', `/runs/${runId}/events`, {
            events: [
                { type: 'session', harness: 'fake', sessionId: 'sess-1' },
                { type: 'log', level: 'info', message: 'started' },
                {
                    type: 'message',
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Checking your board.' },
                        {
                            type: 'tool_use',
                            id: 'tu1',
                            name: 'todos_get_board',
                            input: { today: '2026-10-26' },
                        },
                    ],
                },
                {
                    type: 'message',
                    role: 'tool',
                    content: [{ type: 'tool_result', toolUseId: 'tu1', content: '{"day":[]}' }],
                },
                {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Nothing today!' }],
                },
                {
                    type: 'usage',
                    model: 'claude-opus-5-5',
                    inputTokens: 1200,
                    outputTokens: 300,
                    cacheReadTokens: 800,
                    cacheWriteTokens: 100,
                    costUsd: 0.0123,
                    durationMs: 4200,
                    sessionId: 'sess-1',
                },
            ],
        });
        expect(report.body).toEqual({ cancelRequested: false });

        const done = await t.call('POST', `/runs/${runId}/complete`, {
            status: 'succeeded',
            output: 'Nothing today!',
        });
        expect(done.body).toMatchObject({ status: 'succeeded', output: 'Nothing today!' });

        const full = (await t.call('GET', `/conversations/${convo.id}`)).body;
        expect(full).toMatchObject({
            title: 'What is on my plate today?',
            harness: 'fake',
            harnessSessionId: 'sess-1',
            activeRuns: [],
        });
        expect(full.messages.map((m: { role: string }) => m.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant',
        ]);

        const run = (await t.call('GET', `/runs/${runId}`)).body;
        expect(run.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300, costUsd: 0.0123 });

        const logs = (await t.call('GET', `/runs/${runId}/events?type=log`)).body.items;
        expect(logs).toEqual([
            expect.objectContaining({ type: 'log', level: 'info', message: 'started' }),
        ]);
    });

    it('hands the next turn its history and resumable session', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', { title: 'Two turns' })).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'first' });
        const first = await claim();
        await t.call('POST', `/runs/${first.body.run.id}/events`, {
            events: [
                { type: 'session', harness: 'fake', sessionId: 'sess-2' },
                { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'one' }] },
                {
                    type: 'usage',
                    model: 'm',
                    inputTokens: 10,
                    outputTokens: 5,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    costUsd: 0.5,
                    sessionId: 'sess-2',
                },
            ],
        });

        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'second' });
        expect((await claim()).status).toBe(204);

        await t.call('POST', `/runs/${first.body.run.id}/complete`, { status: 'succeeded' });
        const second = await claim();
        expect(second.body.run.prompt).toBe('second');
        expect(second.body.session).toEqual({
            harness: 'fake',
            sessionId: 'sess-2',
            usage: [
                {
                    model: 'm',
                    inputTokens: 10,
                    outputTokens: 5,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    costUsd: 0.5,
                },
            ],
        });
        expect(second.body.history).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'first' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
        ]);
        await t.call('POST', `/runs/${second.body.run.id}/complete`, { status: 'succeeded' });
    });
});

describe('runs', () => {
    it('long-polls until a run is queued', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        const waiting = claim(5_000);
        await new Promise((r) => setTimeout(r, 50));
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'wake up' });
        const claimed = await waiting;
        expect(claimed.status).toBe(200);
        expect(claimed.body.run.prompt).toBe('wake up');
        await t.call('POST', `/runs/${claimed.body.run.id}/complete`, { status: 'succeeded' });
    });

    it('cancels a queued run outright and asks a running one to stop', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        const queued = (
            await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'never mind' })
        ).body.run;
        expect((await t.call('POST', `/runs/${queued.id}/cancel`)).body.status).toBe('cancelled');
        expect((await claim()).status).toBe(204);

        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'go' });
        const running = (await claim()).body.run;
        await t.call('POST', `/runs/${running.id}/cancel`);
        expect((await t.call('POST', `/runs/${running.id}/heartbeat`)).body).toEqual({
            status: 'running',
            cancelRequested: true,
        });
        const report = await t.call('POST', `/runs/${running.id}/events`, {
            events: [{ type: 'log', level: 'info', message: 'stopping' }],
        });
        expect(report.body.cancelRequested).toBe(true);
        await t.call('POST', `/runs/${running.id}/complete`, { status: 'cancelled' });
        expect(
            (
                await t.call('POST', `/runs/${running.id}/events`, {
                    events: [{ type: 'log', level: 'info', message: 'late' }],
                })
            ).status,
        ).toBe(409);
    });

    it('fails runs whose runner stops heartbeating', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'crash' });
        const run = (await claim()).body.run;

        clock = new Date(clock.getTime() + t.config.runStaleAfterMs + 1_000);
        expect(await t.services.runs.reapStale(clock)).toEqual([run.id]);
        expect((await t.call('GET', `/runs/${run.id}`)).body).toMatchObject({
            status: 'failed',
            error: 'Runner stopped reporting',
        });
    });

    it('streams a finished run as server-sent events and stops at its terminal status', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'stream me' });
        const run = (await claim()).body.run;
        await t.call('POST', `/runs/${run.id}/events`, {
            events: [
                { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
            ],
        });
        await t.call('POST', `/runs/${run.id}/complete`, { status: 'succeeded' });

        const events = await readStream(`/runs/${run.id}/stream`);
        expect(events.map((e) => (e.type === 'status' ? `status:${e.status}` : e.type))).toEqual([
            'status:queued',
            'status:running',
            'message',
            'status:succeeded',
        ]);
        const resumed = await readStream(`/runs/${run.id}/stream?after=${events[1]!.id}`);
        expect(resumed.map((e) => e.type)).toEqual(['message', 'status']);
    });

    it('streams live events until the run ends', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'live' });
        const run = (await claim()).body.run;
        const streamed = readStream(`/runs/${run.id}/stream`);
        await new Promise((r) => setTimeout(r, 50));
        await t.call('POST', `/runs/${run.id}/events`, {
            events: [{ type: 'log', level: 'info', message: 'working' }],
        });
        await t.call('POST', `/runs/${run.id}/complete`, { status: 'failed', error: 'boom' });
        const events = await streamed;
        expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed', error: 'boom' });
        expect(events.some((e) => e.type === 'log')).toBe(true);
    });

    it('filters run lists', async () => {
        const failed = await t.call('GET', '/runs?status=failed&kind=chat');
        expect(failed.body.items.length).toBeGreaterThan(0);
        expect(failed.body.items.every((r: { status: string }) => r.status === 'failed')).toBe(
            true,
        );
    });
});

describe('jobs', () => {
    it('validates schedules and time zones', async () => {
        const bad = await t.call('POST', '/jobs', {
            name: 'x',
            prompt: 'y',
            schedule: 'every day',
        });
        expect(bad.status).toBe(400);
        const zone = await t.call('POST', '/jobs', {
            name: 'x',
            prompt: 'y',
            schedule: '0 7 * * *',
            timezone: 'Mars/Base',
        });
        expect(zone.status).toBe(400);
    });

    it('queues due jobs once and never stacks a second run', async () => {
        await drainQueue();
        clock = new Date('2026-10-26T06:59:00-04:00');
        const job = (
            await t.call('POST', '/jobs', {
                name: 'Morning briefing',
                prompt: 'Summarise my day',
                schedule: '0 7 * * *',
                timezone: 'America/New_York',
            })
        ).body;
        expect(new Date(job.nextRunAt).toISOString()).toBe('2026-10-26T11:00:00.000Z');

        expect(await t.services.jobs.enqueueDue(clock)).toEqual([]);

        clock = new Date('2026-10-28T08:00:00-04:00');
        const queued = await t.services.jobs.enqueueDue(clock);
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({ kind: 'job', jobId: job.id, prompt: 'Summarise my day' });

        clock = new Date('2026-10-29T08:00:00-04:00');
        expect(await t.services.jobs.enqueueDue(clock)).toEqual([]);

        const detail = (await t.call('GET', `/jobs/${job.id}`)).body;
        expect(new Date(detail.nextRunAt).toISOString()).toBe('2026-10-30T11:00:00.000Z');
        expect(detail.recentRuns).toHaveLength(1);

        const claimed = await claim();
        expect(claimed.body.job).toEqual({ id: job.id, name: 'Morning briefing' });
        expect((await t.call('POST', `/jobs/${job.id}/trigger`)).status).toBe(409);
        await t.call('POST', `/runs/${claimed.body.run.id}/complete`, { status: 'succeeded' });

        const triggered = await t.call('POST', `/jobs/${job.id}/trigger`);
        expect(triggered.status).toBe(201);
        const list = (await t.call('GET', '/jobs')).body.items;
        expect(list.find((j: { id: string }) => j.id === job.id).lastRun.status).toBe('queued');
    });

    it('stops scheduling a paused job', async () => {
        const job = (
            await t.call('POST', '/jobs', { name: 'p', prompt: 'p', schedule: '* * * * *' })
        ).body;
        const paused = await t.call('PATCH', `/jobs/${job.id}`, { enabled: false });
        expect(paused.body.nextRunAt).toBeNull();
    });

    it('leaves fields a patch omits alone, time zone included', async () => {
        const job = (
            await t.call('POST', '/jobs', {
                name: 'Chicago',
                prompt: 'p',
                schedule: '0 9 * * *',
                timezone: 'America/Chicago',
            })
        ).body;
        await t.call('PATCH', `/jobs/${job.id}`, { enabled: false });
        const resumed = (await t.call('PATCH', `/jobs/${job.id}`, { enabled: true })).body;
        expect(resumed).toMatchObject({ timezone: 'America/Chicago', schedule: '0 9 * * *' });
        expect(new Date(resumed.nextRunAt).getUTCHours()).toBe(14);
    });
});

describe('usage', () => {
    it('totals tokens and cost by model and by day', async () => {
        const byModel = (await t.call('GET', '/usage?groupBy=model')).body;
        expect(byModel.totals).toMatchObject({ runs: 2, inputTokens: 1210, costUsd: 0.5123 });
        expect(byModel.groups).toEqual([
            expect.objectContaining({ key: 'claude-opus-5-5', runs: 1, outputTokens: 300 }),
            expect.objectContaining({ key: 'm', runs: 1, outputTokens: 5 }),
        ]);

        const byDay = (await t.call('GET', '/usage?groupBy=day&timezone=America/Los_Angeles')).body;
        expect(byDay.groups[0].key).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        const empty = (await t.call('GET', '/usage?from=2030-01-01T00:00:00Z')).body;
        expect(empty).toMatchObject({ totals: { runs: 0, costUsd: 0 }, groups: [] });
    });
});
