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
let automationId: string | undefined;

async function claim(waitMs = 0) {
    return t.call('POST', '/runs/claim', { ...runner, waitMs });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const say = (text: string) => ({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
});

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

    it('replaces a message and what followed it, starting a fresh session', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        const turn = async (text: string, reply: string) => {
            const sent = await t.call('POST', `/conversations/${convo.id}/messages`, { text });
            const run = (await claim()).body.run;
            await t.call('POST', `/runs/${run.id}/events`, {
                events: [{ type: 'session', harness: 'fake', sessionId: 'sess-edit' }, say(reply)],
            });
            await t.call('POST', `/runs/${run.id}/complete`, { status: 'succeeded' });
            return sent.body.message.id as string;
        };
        await turn('first', 'one');
        const second = await turn('second', 'two');
        await turn('third', 'three');

        const edited = await t.call('POST', `/conversations/${convo.id}/messages`, {
            text: 'second, edited',
            from: second,
        });
        expect(edited.status).toBe(201);
        const claimed = (await claim()).body;
        expect(claimed.session).toBeNull();
        expect(claimed.history).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'first' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
        ]);
        const full = (await t.call('GET', `/conversations/${convo.id}`)).body;
        expect(full.messages.map((m: { role: string }) => m.role)).toEqual([
            'user',
            'assistant',
            'user',
        ]);

        // Mid-turn, and for a message that is gone, the rewind is refused.
        const busy = await t.call('POST', `/conversations/${convo.id}/messages`, {
            text: 'again',
            from: edited.body.message.id,
        });
        expect(busy.status).toBe(409);
        await t.call('POST', `/runs/${claimed.run.id}/complete`, { status: 'succeeded' });
        const gone = await t.call('POST', `/conversations/${convo.id}/messages`, {
            text: 'again',
            from: second,
        });
        expect(gone.status).toBe(404);
    });
});

describe('conversation turns', () => {
    it('includes an earlier turn’s reply that landed after the next message', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'first' });
        const first = (await claim()).body.run;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'second' });
        await t.call('POST', `/runs/${first.id}/events`, { events: [say('one')] });
        await t.call('POST', `/runs/${first.id}/complete`, { status: 'succeeded' });

        const second = (await claim()).body;
        expect(second.run.prompt).toBe('second');
        expect(second.history).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'first' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
        ]);
        await t.call('POST', `/runs/${second.run.id}/complete`, { status: 'succeeded' });
    });

    it('wakes a waiting claim when a turn ends and frees the next one', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'first' });
        const first = (await claim()).body.run;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'second' });

        const started = Date.now();
        const waiting = claim(10_000);
        await sleep(50);
        await t.call('POST', `/runs/${first.id}/complete`, { status: 'succeeded' });
        const next = await waiting;
        expect(next.body.run.prompt).toBe('second');
        expect(Date.now() - started).toBeLessThan(5_000);
        await t.call('POST', `/runs/${next.body.run.id}/complete`, { status: 'succeeded' });
    });

    it('cancels a turn in flight before deleting its conversation', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'one' });
        const running = (await claim()).body.run;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'two' });

        const streamed = readStream(`/runs/${running.id}/stream`);
        await sleep(50);
        expect((await t.call('DELETE', `/conversations/${convo.id}`)).status).toBe(200);
        expect((await streamed).at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });

        // The runner holding the turn hears 404 and stops; the queued turn went with it.
        expect((await t.call('POST', `/runs/${running.id}/heartbeat`)).status).toBe(404);
        const late = await t.call('POST', `/runs/${running.id}/events`, { events: [say('late')] });
        expect(late.status).toBe(404);
        expect((await claim()).status).toBe(204);
    });
});

describe('runs', () => {
    it('hands a claim a token scoped to its run', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'token' });
        const claimed = (await claim()).body;
        expect(await t.services.runs.authorize(claimed.agentToken)).toEqual({
            id: claimed.run.id,
            kind: 'chat',
        });
        await t.call('POST', `/runs/${claimed.run.id}/complete`, { status: 'succeeded' });
        expect(await t.services.runs.authorize(claimed.agentToken)).toBeNull();
        expect(await t.services.runs.authorize(TEST_TOKEN)).toBeNull();
    });

    it('claims nothing for a runner that already hung up', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        const sent = (await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'x' }))
            .body;
        const runner = { runnerId: 'gone', harness: 'fake' };
        expect(await t.services.runs.claimWait(runner, 1_000, AbortSignal.abort())).toBeNull();
        expect((await t.call('GET', `/runs/${sent.run.id}`)).body.status).toBe('queued');
        await t.call('POST', `/runs/${sent.run.id}/cancel`);
    });

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

    it('follows a long backlog and live events without gaps or repeats', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'chatty' });
        const run = (await claim()).body.run;
        const log = (message: string) => ({
            type: 'log' as const,
            level: 'info' as const,
            message,
        });
        await t.services.runs.report(
            run.id,
            Array.from({ length: 603 }, (_, i) => log(`backlog ${i}`)),
        );

        const seen: RunEvent[] = [];
        const abort = new AbortController();
        for await (const event of t.services.runs.follow(run.id, 0, {
            signal: abort.signal,
            idleMs: 60_000,
        })) {
            if (!event) continue;
            seen.push(event);
            // Lands while the first backlog page is still being sent.
            if (seen.length === 1) await t.services.runs.report(run.id, [log('live')]);
            if (event.type === 'log' && event.message === 'live') {
                await t.services.runs.complete(run.id, { status: 'succeeded' });
            }
        }

        const stored = await t.services.runs.events(run.id, { limit: 1000 });
        expect(stored).toHaveLength(1 + 1 + 603 + 1 + 1);
        expect(seen.map((e) => e.id)).toEqual(stored.map((e) => e.id));
    });

    it('filters run lists', async () => {
        const failed = await t.call('GET', '/runs?status=failed&kind=chat');
        expect(failed.body.items.length).toBeGreaterThan(0);
        expect(failed.body.items.every((r: { status: string }) => r.status === 'failed')).toBe(
            true,
        );
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

describe('budgets', () => {
    it('cancels a run whose reported usage passes its budget', async () => {
        await drainQueue();
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'Big job' });
        const claimed = (await claim()).body;
        expect(claimed.run.budgetUsd).toBe(5);

        const usage = (costUsd: number) => ({
            type: 'usage',
            model: 'claude-opus-5-5',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd,
        });
        const path = `/runs/${claimed.run.id}/events`;
        expect((await t.call('POST', path, { events: [usage(3)] })).body).toEqual({
            cancelRequested: false,
        });
        expect((await t.call('POST', path, { events: [usage(2.5)] })).body).toEqual({
            cancelRequested: true,
        });
        const logs = (await t.call('GET', `${path}?type=log`)).body.items;
        expect(logs.at(-1).message).toBe('Stopped: spent $5.50 of a $5.00 budget');
        await t.call('POST', `/runs/${claimed.run.id}/complete`, { status: 'cancelled' });
    });
});

describe('shared automation budget', () => {
    it('stops every agent run of an automation run once together they pass the budget', async () => {
        await drainQueue();
        const { db, runs } = t.services;
        const automation = await db.automation.create({
            data: { name: 'Budget', schedule: '0 * * * *', code: 'export default () => {}' },
        });
        automationId = automation.id;
        const parent = await db.automationRun.create({
            data: { automationId: automation.id, version: 1, trigger: 'manual' },
        });
        const queued = await db.$transaction(async (tx) => [
            await runs.enqueue(tx, { kind: 'automation', prompt: 'a', automationRunId: parent.id }),
            await runs.enqueue(tx, { kind: 'automation', prompt: 'b', automationRunId: parent.id }),
        ]);
        runs.announce(queued);
        const a = (await claim()).body.run;
        const b = (await claim()).body.run;

        const usage = (costUsd: number) => ({
            type: 'usage',
            model: 'claude-opus-5-5',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd,
        });
        const spend = (id: string, cost: number) =>
            t.call('POST', `/runs/${id}/events`, { events: [usage(cost)] });
        expect((await spend(a.id, 3)).body).toEqual({ cancelRequested: false });
        // Each is within its own $5, but together they are not.
        expect((await spend(b.id, 2.5)).body).toEqual({ cancelRequested: true });
        expect((await t.call('POST', `/runs/${a.id}/heartbeat`)).body).toEqual({
            status: 'running',
            cancelRequested: true,
        });
        const logs = (await t.call('GET', `/runs/${b.id}/events?type=log`)).body.items;
        expect(logs.at(-1).message).toContain('shared $5.00 budget');
        for (const run of [a, b]) {
            await t.call('POST', `/runs/${run.id}/complete`, { status: 'cancelled' });
        }
    });
});

describe('usage groupings', () => {
    it('groups by kind, harness and automation', async () => {
        const group = async (by: string) =>
            (await t.call('GET', `/usage?groupBy=${by}`)).body.groups as {
                key: string | null;
                runs: number;
                costUsd: number;
            }[];
        const byKind = await group('kind');
        expect(byKind.map((g) => g.key)).toEqual(['automation', 'chat']);
        expect(byKind[0]).toMatchObject({ runs: 2, costUsd: 5.5 });
        expect((await group('harness')).map((g) => g.key)).toEqual(['fake']);
        const byAutomation = await group('automation');
        expect(byAutomation.find((g) => g.key === automationId)).toMatchObject({
            runs: 2,
            costUsd: 5.5,
        });
        expect(byAutomation.some((g) => g.key === null)).toBe(true);
    });
});
