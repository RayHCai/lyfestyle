import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAutomationsService } from '../src/automations/service.js';
import { createTestContext, type TestContext } from '../src/testing.js';
import { fakeFetch } from './fake-fetch.js';

let t: TestContext;
let clock = new Date('2026-10-26T12:00:00Z');
const net = fakeFetch();
const sent: unknown[] = [];
net.on('POST', 'https://api.resend.com/emails', async (req) => {
    sent.push(await req.json());
    return net.json({ id: 'email-1' });
});

beforeAll(async () => {
    t = await createTestContext({
        fetch: net.fetch,
        now: () => clock,
        env: {
            RESEND_API_KEY: 're_test',
            RESEND_FROM: 'Lyfestyle <agent@example.com>',
            NOTIFY_EMAIL: 'me@example.com',
            AUTOMATION_TIMEOUT_MS: '3000',
        },
    });
});
afterAll(async () => {
    await t.services.automations.stopAll('test over');
    await t.close();
});

const runner = { runnerId: 'laptop', harness: 'fake' };

// Each run starts a Node process, and several tests wait out the 3 s AUTOMATION_TIMEOUT_MS.
const slow = { timeout: 20_000 };

/** Proposes code through the agent's tool and approves it the way the app does. */
async function deploy(code: string, extra: Record<string, unknown> = {}) {
    const proposed = await t.call('POST', '/tools/automations_deploy', {
        name: 'Test',
        schedule: '0 7 * * *',
        code,
        ...extra,
    });
    expect(proposed.status).toBe(200);
    const approved = await t.call(
        'POST',
        `/automations/deploys/${proposed.body.result.id}/approve`,
    );
    expect(approved.status).toBe(200);
    return approved.body;
}

async function runNow(id: string) {
    const started = await t.call('POST', `/automations/${id}/trigger`);
    expect(started.status).toBe(201);
    await t.services.automations.idle();
    const detail = (await t.call('GET', `/automations/${id}`)).body;
    return detail.recentRuns.find((r: { id: string }) => r.id === started.body.id);
}

const propose = (input: Record<string, unknown>) =>
    t.services.automations.propose(
        { name: 'Test', schedule: '0 7 * * *', code: 'export default () => {}', ...input },
        { kind: 'user', runId: null },
    );

/** Starts the code, which must call ctx.agent, and resolves once its agent run is queued. */
async function startWaitingOnAgent(id: string) {
    const started = (await t.call('POST', `/automations/${id}/trigger`)).body;
    // Long enough for a child process to start on a busy machine.
    await expect
        .poll(() => t.services.db.run.findFirst({ where: { automationRunId: started.id } }), {
            timeout: 10_000,
        })
        .toBeTruthy();
    const agentRun = await t.services.db.run.findFirstOrThrow({
        where: { automationRunId: started.id },
    });
    return { runId: started.id as string, agentRunId: agentRun.id };
}

const statusOf = async (agentRunId: string) =>
    (await t.services.db.run.findUniqueOrThrow({ where: { id: agentRunId } })).status;

describe('deploys', () => {
    it('rejects bad schedules and code without a default export', async () => {
        const schedule = await t.call('POST', '/tools/automations_deploy', {
            name: 'x',
            schedule: 'every day',
            code: 'export default () => {}',
        });
        expect(schedule.status).toBe(400);
        // Seven fields (croner's year), and a date that never comes.
        for (const bad of ['0 0 7 * * * 2030', '0 0 30 2 *']) {
            await expect(propose({ schedule: bad })).rejects.toMatchObject({ status: 400 });
        }
        const code = await t.call('POST', '/tools/automations_deploy', {
            name: 'x',
            schedule: '0 7 * * *',
            code: 'console.log(1)',
        });
        expect(code.status).toBe(400);
    });

    it('deploys nothing until the user approves, and versions each approval', async () => {
        const proposed = (
            await t.call('POST', '/tools/automations_deploy', {
                name: 'Briefing',
                schedule: '0 7 * * *',
                timezone: 'America/New_York',
                code: 'export default () => "v1"',
            })
        ).body.result;
        const pending = (await t.call('GET', '/automations/deploys?status=pending')).body.items;
        expect(pending.find((d: { id: string }) => d.id === proposed.id)).toMatchObject({
            automationId: null,
            current: null,
        });
        const before = (await t.call('GET', '/automations')).body.items;
        expect(before.some((a: { name: string }) => a.name === 'Briefing')).toBe(false);

        const one = await t.call('GET', `/automations/deploys/${proposed.id}`);
        expect(one.body).toMatchObject({ id: proposed.id, status: 'pending', current: null });

        const v1 = (await t.call('POST', `/automations/deploys/${proposed.id}/approve`)).body;
        expect(v1).toMatchObject({ name: 'Briefing', version: 1, enabled: true });
        expect(new Date(v1.nextRunAt).toISOString()).toBe('2026-10-27T11:00:00.000Z');
        expect((await t.call('POST', `/automations/deploys/${proposed.id}/approve`)).status).toBe(
            409,
        );

        const first = (
            await t.call('POST', '/tools/automations_deploy', {
                automationId: v1.id,
                name: 'Briefing',
                schedule: '0 8 * * *',
                timezone: 'America/New_York',
                code: 'export default () => "v2"',
            })
        ).body.result;
        const second = (
            await t.call('POST', '/tools/automations_deploy', {
                automationId: v1.id,
                name: 'Briefing',
                schedule: '0 9 * * *',
                timezone: 'America/New_York',
                code: 'export default () => "v2"',
            })
        ).body.result;
        const deploys = (await t.call('GET', '/automations/deploys')).body.items;
        const byId = (id: string) => deploys.find((d: { id: string }) => d.id === id);
        expect(byId(first.id).status).toBe('rejected');
        expect(byId(second.id)).toMatchObject({
            status: 'pending',
            current: { version: 1, code: 'export default () => "v1"' },
        });

        const v2 = (await t.call('POST', `/automations/deploys/${second.id}/approve`)).body;
        expect(v2).toMatchObject({ id: v1.id, version: 2, schedule: '0 9 * * *' });
        expect((await runNow(v1.id)).output).toBe('v2');
    });

    it('rejects a proposal', async () => {
        const proposed = (
            await t.call('POST', '/tools/automations_deploy', {
                name: 'Nope',
                schedule: '0 7 * * *',
                code: 'export default () => {}',
            })
        ).body.result;
        const rejected = await t.call('POST', `/automations/deploys/${proposed.id}/reject`);
        expect(rejected.body.status).toBe('rejected');
        expect((await t.call('POST', `/automations/deploys/${proposed.id}/reject`)).status).toBe(
            409,
        );
    });

    it('records who proposed a deploy', async () => {
        const byUser = await t.call('POST', '/tools/automations_deploy', {
            name: 'Mine',
            schedule: '0 7 * * *',
            code: 'export default () => {}',
        });
        const mine = await t.call('GET', `/automations/deploys/${byUser.body.result.id}`);
        expect(mine.body).toMatchObject({ origin: 'user', runId: null });

        const chat = await t.services.db.$transaction((tx) =>
            t.services.runs.enqueue(tx, { kind: 'chat', prompt: 'Make me an automation' }),
        );
        await t.services.runs.cancel(chat.run.id);
        const byAgent = await t.services.automations.propose(
            { name: 'From chat', schedule: '0 7 * * *', code: 'export default () => {}' },
            { kind: 'chat', runId: chat.run.id },
        );
        const listed = (await t.call('GET', '/automations/deploys?status=pending')).body.items;
        expect(listed.find((d: { id: string }) => d.id === byAgent.id)).toMatchObject({
            origin: 'chat',
            runId: chat.run.id,
        });
    });

    it('keeps exactly one proposal pending when two arrive at once', async () => {
        const automation = await deploy('export default () => "v1"', { name: 'Raced' });
        const [a, b] = await Promise.all([
            propose({ automationId: automation.id, name: 'Raced', code: 'export default () => 1' }),
            propose({ automationId: automation.id, name: 'Raced', code: 'export default () => 2' }),
        ]);
        const rows = await t.services.db.automationDeploy.findMany({
            where: { id: { in: [a.id, b.id] } },
        });
        expect(rows.map((r) => r.status).toSorted()).toEqual(['pending', 'rejected']);
    });
});

describe('execution', slow, () => {
    it('gives code its helpers: notify, state, logs and the tools', async () => {
        const automation = await deploy(`
            export default async (ctx) => {
                const runs = (ctx.state.get().runs ?? 0) + 1;
                await ctx.state.set({ runs });
                console.log('run', runs);
                const todo = await ctx.tool('todos_create', { title: 'From code', scope: 'day', date: '2026-10-26' });
                await ctx.notify({ title: 'Done', body: todo.title });
                return { runs, by: ctx.automation.name };
            };
        `);
        const first = await runNow(automation.id);
        expect(first).toMatchObject({ status: 'succeeded', trigger: 'manual', version: 1 });
        expect(JSON.parse(first.output)).toEqual({ runs: 1, by: 'Test' });
        expect(first.logs).toEqual([expect.objectContaining({ level: 'info', message: 'run 1' })]);

        const second = await runNow(automation.id);
        expect(JSON.parse(second.output).runs).toBe(2);

        const notes = (await t.call('GET', '/notifications?limit=100')).body.items;
        expect(notes.at(-1)).toMatchObject({ title: 'Done', body: 'From code', source: 'Test' });
        const later = (await t.call('GET', `/notifications?after=${notes.at(-1).id}`)).body;
        expect(later.items).toEqual([]);
    });

    it('emails the user by default', async () => {
        const automation = await deploy(
            `export default (ctx) => ctx.email({ subject: 'Hello', text: 'Body' })`,
        );
        expect((await runNow(automation.id)).status).toBe('succeeded');
        expect(sent.at(-1)).toMatchObject({ to: ['me@example.com'], subject: 'Hello' });
    });

    it('fails the run and notifies the user when the code throws', async () => {
        const automation = await deploy(`export default () => { throw new Error('boom') }`);
        const run = await runNow(automation.id);
        expect(run.status).toBe('failed');
        expect(run.error).toContain('boom');
        const notes = (await t.call('GET', '/notifications?limit=1')).body.items;
        expect(notes[0]).toMatchObject({ title: 'Test failed' });
    });

    it('stops code that runs past the timeout', async () => {
        const automation = await deploy(
            `export default () => new Promise(() => setInterval(() => {}, 1000))`,
        );
        const run = await runNow(automation.id);
        expect(run).toMatchObject({ status: 'failed', error: 'Timed out after 3 s' });
    });

    it('refuses to start a second run while one is going', async () => {
        const automation = await deploy(
            `export default () => new Promise((r) => setTimeout(r, 300))`,
        );
        expect((await t.call('POST', `/automations/${automation.id}/trigger`)).status).toBe(201);
        expect((await t.call('POST', `/automations/${automation.id}/trigger`)).status).toBe(409);
        await t.services.automations.idle();
    });

    it('resets state to {} on set(null), in the run and the next', async () => {
        const automation = await deploy(`
            export default async (ctx) => {
                await ctx.state.set(null);
                return { now: ctx.state.get() };
            };
        `);
        expect(JSON.parse((await runNow(automation.id)).output)).toEqual({ now: {} });
        expect((await t.call('GET', `/automations/${automation.id}`)).body.state).toEqual({});
    });

    it('fails the run on a malformed message, and the API carries on', async () => {
        const automation = await deploy(`
            export default () => {
                process.send({ type: 'call', id: 'x', method: 'constructor' });
                return new Promise(() => {});
            };
        `);
        const run = await runNow(automation.id);
        expect(run).toMatchObject({
            status: 'failed',
            error: 'The code sent the API an invalid message',
        });
        expect(run.logs).toContainEqual(
            expect.objectContaining({
                level: 'error',
                message: expect.stringContaining('constructor'),
            }),
        );
        expect((await t.call('GET', '/automations')).status).toBe(200);
    });
});

describe('agent runs', slow, () => {
    const usage = {
        type: 'usage',
        model: 'claude-opus-5-5',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 1.5,
    };

    it('queues runs for the runner that share one $5 budget', async () => {
        const automation = await deploy(`
            export default async (ctx) => {
                const a = await ctx.agent('First');
                const b = await ctx.agent('Second');
                return a + ' ' + b;
            };
        `);
        const started = (await t.call('POST', `/automations/${automation.id}/trigger`)).body;
        for (const [prompt, budget, output] of [
            ['First', 5, 'one'],
            ['Second', 3.5, 'two'],
        ] as const) {
            const claimed = (await t.call('POST', '/runs/claim', { ...runner, waitMs: 2000 })).body;
            expect(claimed.run).toMatchObject({
                kind: 'automation',
                prompt,
                automationRunId: started.id,
                budgetUsd: budget,
            });
            expect(claimed.automation).toEqual({ id: automation.id, name: 'Test' });
            await t.call('POST', `/runs/${claimed.run.id}/events`, { events: [usage] });
            await t.call('POST', `/runs/${claimed.run.id}/complete`, {
                status: 'succeeded',
                output,
            });
        }
        await t.services.automations.idle();
        const detail = (await t.call('GET', `/automations/${automation.id}`)).body;
        expect(detail.recentRuns[0]).toMatchObject({
            status: 'succeeded',
            output: 'one two',
            costUsd: 3,
        });
        const byAutomation = (await t.call('GET', '/usage?groupBy=automation')).body.groups;
        expect(byAutomation).toContainEqual(
            expect.objectContaining({ key: automation.id, costUsd: 3 }),
        );
        await t.call('DELETE', `/automations/${automation.id}`);
    });

    it('splits the budget between calls made in parallel', async () => {
        const automation = await deploy(`
            export default async (ctx) => {
                const calls = [ctx.agent('A', { budgetUsd: 2 }), ctx.agent('B'), ctx.agent('C')];
                const settled = await Promise.allSettled(calls);
                return settled.map((r) => (r.status === 'fulfilled' ? r.value : r.reason.message));
            };
        `);
        const started = (await t.call('POST', `/automations/${automation.id}/trigger`)).body;
        // The calls reach the API one after another. Each run spends its whole budget, so
        // however they interleave with the runner, C finds nothing left.
        const budgets: Record<string, number> = {};
        for (let i = 0; i < 2; i++) {
            const { run } = (await t.call('POST', '/runs/claim', { ...runner, waitMs: 2000 })).body;
            expect(run.automationRunId).toBe(started.id);
            budgets[run.prompt] = run.budgetUsd;
            await t.call('POST', `/runs/${run.id}/events`, {
                events: [{ ...usage, costUsd: run.budgetUsd }],
            });
            await t.call('POST', `/runs/${run.id}/complete`, {
                status: 'succeeded',
                output: run.prompt.toLowerCase(),
            });
        }
        expect(budgets).toEqual({ A: 2, B: 3 });
        await t.services.automations.idle();
        const run = (await t.call('GET', `/automations/${automation.id}`)).body.recentRuns[0];
        expect(JSON.parse(run.output)).toEqual([
            'a',
            'b',
            expect.stringContaining('No budget left'),
        ]);
        expect(run.costUsd).toBe(5);
        await t.call('DELETE', `/automations/${automation.id}`);
    });

    it('stops waiting for the agent when the code times out, and cancels its run', async () => {
        const automation = await deploy(`export default (ctx) => ctx.agent('Nobody claims this')`);
        const { runId, agentRunId } = await startWaitingOnAgent(automation.id);
        await t.services.automations.idle();
        const run = await t.services.db.automationRun.findUniqueOrThrow({ where: { id: runId } });
        expect(run).toMatchObject({ status: 'failed', error: 'Timed out after 3 s' });
        expect(await statusOf(agentRunId)).toBe('cancelled');
        await t.call('DELETE', `/automations/${automation.id}`);
    });

    it('cancels without notifying when paused, deleted or shut down', async () => {
        const waiting = `export default (ctx) => ctx.agent('Hold on')`;
        const notes = await t.services.db.notification.count();
        const runOf = (id: string) => t.services.db.automationRun.findUnique({ where: { id } });

        const paused = await deploy(waiting, { name: 'Paused' });
        const first = await startWaitingOnAgent(paused.id);
        await t.call('PATCH', `/automations/${paused.id}`, { enabled: false });
        expect(await runOf(first.runId)).toMatchObject({
            status: 'cancelled',
            error: 'The automation was paused',
        });
        expect(await statusOf(first.agentRunId)).toBe('cancelled');

        const deleted = await deploy(waiting, { name: 'Deleted' });
        const second = await startWaitingOnAgent(deleted.id);
        expect((await t.call('DELETE', `/automations/${deleted.id}`)).status).toBe(200);
        expect(await statusOf(second.agentRunId)).toBe('cancelled');

        const third = await startWaitingOnAgent(paused.id);
        await t.services.automations.stopAll('The API shut down during this run');
        expect(await runOf(third.runId)).toMatchObject({
            status: 'cancelled',
            error: 'The API shut down during this run',
        });
        expect(await statusOf(third.agentRunId)).toBe('cancelled');

        expect(await t.services.db.notification.count()).toBe(notes);
        await t.call('DELETE', `/automations/${paused.id}`);
    });
});

describe('scheduling', slow, () => {
    it('starts due automations once and moves them to their next slot', async () => {
        await t.services.automations.idle();
        clock = new Date('2026-11-02T06:59:00-05:00');
        const automation = await deploy(`export default () => 'tick'`, {
            name: 'Morning',
            timezone: 'America/New_York',
        });
        // Earlier tests' automations share the 7:00 UTC slot; only this one is checked here.
        const ours = (runs: { automationId: string }[]) =>
            runs.filter((r) => r.automationId === automation.id);
        expect(ours(await t.services.automations.startDue(clock))).toEqual([]);

        clock = new Date('2026-11-03T08:00:00-05:00');
        const started = ours(await t.services.automations.startDue(clock));
        expect(started).toEqual([expect.objectContaining({ trigger: 'schedule' })]);
        expect(ours(await t.services.automations.startDue(clock))).toEqual([]);
        await t.services.automations.idle();

        const detail = (await t.call('GET', `/automations/${automation.id}`)).body;
        expect(new Date(detail.nextRunAt).toISOString()).toBe('2026-11-04T12:00:00.000Z');

        const day = await t.call(
            'GET',
            `/automations/timeline?from=2026-11-03T05:00:00Z&to=2026-11-05T05:00:00Z`,
        );
        expect(ours(day.body.runs)).toEqual([
            expect.objectContaining({ name: 'Morning', status: 'succeeded' }),
        ]);
        expect(ours(day.body.upcoming)).toEqual([
            { automationId: automation.id, name: 'Morning', at: '2026-11-04T12:00:00.000Z' },
        ]);

        const paused = await t.call('PATCH', `/automations/${automation.id}`, { enabled: false });
        expect(paused.body.nextRunAt).toBeNull();
    });

    it('fails runs a previous process left running', async () => {
        const automation = await deploy(`export default () => {}`);
        const orphan = await t.services.db.automationRun.create({
            data: { automationId: automation.id, version: 1, trigger: 'schedule' },
        });
        const left = await t.services.db.$transaction((tx) =>
            t.services.runs.enqueue(tx, {
                kind: 'automation',
                prompt: 'Left behind',
                automationRunId: orphan.id,
            }),
        );
        expect(await t.services.automations.recover(clock)).toBeGreaterThanOrEqual(1);
        const row = await t.services.db.automationRun.findUnique({ where: { id: orphan.id } });
        expect(row).toMatchObject({ status: 'failed', error: 'The API restarted during this run' });
        expect(await statusOf(left.run.id)).toBe('cancelled');
    });

    it('pauses an automation whose stored schedule broke, and starts the others', async () => {
        clock = new Date('2026-11-10T06:59:00Z');
        const good = await deploy(`export default () => 'fine'`, { name: 'Good' });
        const bad = await deploy(`export default () => 'never'`, { name: 'Bad' });
        // As if stored before seven-field schedules were refused.
        await t.services.db.automation.update({
            where: { id: bad.id },
            data: { schedule: '0 0 7 * * * 2030' },
        });
        clock = new Date('2026-11-10T07:00:30Z');
        const started = (await t.services.automations.startDue(clock)).map((r) => r.automationId);
        expect(started).toContain(good.id);
        expect(started).not.toContain(bad.id);
        await t.services.automations.idle();

        const broken = (await t.call('GET', `/automations/${bad.id}`)).body;
        expect(broken).toMatchObject({ enabled: false, nextRunAt: null });
        expect(broken.recentRuns[0]).toMatchObject({
            status: 'failed',
            error: expect.stringMatching(/^Paused: its schedule no longer works/),
        });
        expect(
            await t.services.db.notification.findFirst({ where: { automationId: bad.id } }),
        ).toMatchObject({ title: 'Bad failed' });
    });

    it('lists each automation with its newest run, without loading logs', async () => {
        const automation = await deploy(`export default () => console.log('x'.repeat(3000))`, {
            name: 'Listed',
        });
        await runNow(automation.id);
        clock = new Date(clock.getTime() + 60_000);
        const newest = await runNow(automation.id);

        // A db that records what list() asks of it.
        const asked: string[] = [];
        const db = new Proxy(t.services.db, {
            get(target, prop) {
                if (prop === '$queryRaw') {
                    return (sql: TemplateStringsArray, ...values: unknown[]) => {
                        asked.push(sql.join('?'));
                        return target.$queryRaw(sql, ...values);
                    };
                }
                asked.push(String(prop));
                return Reflect.get(target, prop);
            },
        });
        const { runs, notifications, resend, config, now } = t.services;
        const automations = createAutomationsService({
            db,
            runs,
            notifications,
            resend,
            config,
            now,
            callTool: () => Promise.reject(new Error('unused')),
        });
        const listed = (await automations.list()).find((a) => a.id === automation.id);
        expect(listed?.lastRun).toEqual({
            id: newest.id,
            status: 'succeeded',
            startedAt: clock,
            finishedAt: clock,
        });
        expect(listed).not.toHaveProperty('code');
        expect(asked).not.toContain('automationRun');
        expect(asked.join(' ')).not.toMatch(/\b(logs|output)\b/);
        await t.call('DELETE', `/automations/${automation.id}`);
    });

    it('deletes an automation with its history', async () => {
        const automation = await deploy(`export default () => {}`);
        await runNow(automation.id);
        expect((await t.call('DELETE', `/automations/${automation.id}`)).status).toBe(200);
        expect((await t.call('GET', `/automations/${automation.id}`)).status).toBe(404);
        expect(
            await t.services.db.automationRun.count({ where: { automationId: automation.id } }),
        ).toBe(0);
    });
});
