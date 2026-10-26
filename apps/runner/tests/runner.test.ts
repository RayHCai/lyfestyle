import { createTestContext, TEST_TOKEN, TEST_URL, type TestContext } from '@lyfestyle/api/testing';
import { createApiClient } from '@lyfestyle/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bridge } from '../src/bridge.js';
import type { Harness, HarnessInput } from '../src/harness.js';
import { Runner } from '../src/runner.js';

let t: TestContext;
beforeAll(async () => {
    t = await createTestContext();
});
afterAll(() => t.close());

class FakeHarness implements Harness {
    readonly name = 'fake';
    inputs: HarnessInput[] = [];
    behaviour: (input: HarnessInput) => Promise<string | null> = async (input) => {
        input.emit({ type: 'session', harness: 'fake', sessionId: `s-${input.runId}` });
        input.emit({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: `echo: ${input.prompt}` }],
        });
        input.emit({
            type: 'usage',
            model: 'claude-opus-5-5',
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.01,
            sessionId: `s-${input.runId}`,
        });
        return `echo: ${input.prompt}`;
    };

    async run(input: HarnessInput) {
        this.inputs.push(input);
        return { output: await this.behaviour(input) };
    }
}

let harness: FakeHarness;
let runner: Runner;
const api = () => createApiClient({ baseUrl: TEST_URL, token: TEST_TOKEN, fetch: t.fetch });

beforeEach(() => {
    harness = new FakeHarness();
    runner = new Runner({
        api: api(),
        harness,
        runnerId: 'test-runner',
        apiUrl: TEST_URL,
        apiToken: TEST_TOKEN,
        heartbeatMs: 20,
        flushMs: 5,
    });
});

async function send(text: string, conversationId?: string) {
    const id = conversationId ?? (await t.call('POST', '/conversations', {})).body.id;
    const { run } = (await t.call('POST', `/conversations/${id}/messages`, { text })).body;
    return { conversationId: id, runId: run.id as string };
}

describe('runner', () => {
    it('executes a chat turn and records what the harness reported', async () => {
        await t.call('POST', '/mcp-servers', {
            name: 'notes',
            transport: 'stdio',
            command: 'notes-mcp',
        });
        const { conversationId, runId } = await send('hello');
        expect(await runner.runOnce(0)).toBe(true);

        const input = harness.inputs[0]!;
        expect(input.mcpServers[0]).toEqual({
            name: 'lyfestyle',
            transport: 'http',
            url: `${TEST_URL}/mcp`,
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(input.mcpServers.map((s) => s.name)).toContain('notes');

        const run = (await t.call('GET', `/runs/${runId}`)).body;
        expect(run).toMatchObject({
            status: 'succeeded',
            output: 'echo: hello',
            runnerId: 'test-runner',
            harness: 'fake',
        });
        expect(run.usage.costUsd).toBe(0.01);
        const convo = (await t.call('GET', `/conversations/${conversationId}`)).body;
        expect(convo.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
        expect(convo.harnessSessionId).toBe(`s-${runId}`);
    });

    it('passes the session and its spend so far into the next turn', async () => {
        const first = await send('one');
        await runner.runOnce(0);
        await send('two', first.conversationId);
        await runner.runOnce(0);
        expect(harness.inputs[1]!.session).toEqual({
            harness: 'fake',
            sessionId: `s-${first.runId}`,
            usage: [
                expect.objectContaining({
                    model: 'claude-opus-5-5',
                    inputTokens: 100,
                    costUsd: 0.01,
                }),
            ],
        });
    });

    it('fails the run with the harness error', async () => {
        harness.behaviour = async () => {
            throw new Error('model overloaded');
        };
        const { runId } = await send('boom');
        await runner.runOnce(0);
        const run = (await t.call('GET', `/runs/${runId}`)).body;
        expect(run).toMatchObject({ status: 'failed', error: 'model overloaded' });
        const logs = (await t.call('GET', `/runs/${runId}/events?type=log`)).body.items;
        expect(logs.at(-1)).toMatchObject({ level: 'error', message: 'model overloaded' });
    });

    it('aborts the harness when the run is cancelled', async () => {
        harness.behaviour = (input) =>
            new Promise((_, reject) =>
                input.signal.addEventListener('abort', () => reject(new Error('aborted'))),
            );
        const { runId } = await send('long task');
        const running = runner.runOnce(0);
        await new Promise((r) => setTimeout(r, 50));
        await t.call('POST', `/runs/${runId}/cancel`);
        await running;
        expect((await t.call('GET', `/runs/${runId}`)).body.status).toBe('cancelled');
    });

    it('reports nothing claimed when the queue is empty', async () => {
        while (await runner.runOnce(0));
        expect(await runner.runOnce(0)).toBe(false);
    });
});

describe('bridge', () => {
    it('prints a turn as Claude Code stream-json and continues the conversation', async () => {
        while (await runner.runOnce(0));
        const lines: Record<string, any>[] = [];
        const warnings: string[] = [];
        const io = {
            write: (line: object) => lines.push(line),
            warn: (m: string) => warnings.push(m),
        };
        const client = { baseUrl: TEST_URL, token: TEST_TOKEN, fetch: t.fetch };

        const turn = bridge({ client, prompt: 'ping', io });
        await new Promise((r) => setTimeout(r, 50));
        await runner.runOnce(1_000);
        expect(await turn).toBe(0);

        const [init, ...rest] = lines;
        expect(init).toMatchObject({ type: 'system', subtype: 'init' });
        expect(rest).toEqual([
            {
                type: 'assistant',
                session_id: init!.session_id,
                message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ping' }] },
            },
            expect.objectContaining({
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: 'echo: ping',
                session_id: init!.session_id,
                total_cost_usd: 0.01,
            }),
        ]);

        lines.length = 0;
        const again = bridge({ client, prompt: 'pong', session: init!.session_id, io });
        await new Promise((r) => setTimeout(r, 50));
        await runner.runOnce(1_000);
        await again;
        expect(lines[0]!.session_id).toBe(init!.session_id);
        const convo = (await t.call('GET', `/conversations/${init!.session_id}`)).body;
        expect(convo.messages).toHaveLength(4);
        expect(warnings).toEqual([]);
    });

    it('starts a fresh conversation for an unknown session and says so', async () => {
        const lines: Record<string, any>[] = [];
        const warnings: string[] = [];
        const turn = bridge({
            client: { baseUrl: TEST_URL, token: TEST_TOKEN, fetch: t.fetch },
            prompt: 'hi',
            session: crypto.randomUUID(),
            io: { write: (line) => lines.push(line), warn: (m) => warnings.push(m) },
        });
        await new Promise((r) => setTimeout(r, 50));
        await runner.runOnce(1_000);
        await turn;
        expect(warnings[0]).toContain('No conversation found');
        expect(lines.at(-1)).toMatchObject({ type: 'result', is_error: false });
    });
});
