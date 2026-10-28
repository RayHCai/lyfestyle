import { createTestContext, TEST_TOKEN, TEST_URL, type TestContext } from '@lyfestyle/api/testing';
import { createApiClient } from '@lyfestyle/client';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bridge } from '../src/bridge.js';
import type { Harness, HarnessInput } from '../src/harness.js';
import { Runner, type RunnerOptions } from '../src/runner.js';

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
        input.emit(usage(input.runId, 0.01));
        return `echo: ${input.prompt}`;
    };

    async run(input: HarnessInput) {
        this.inputs.push(input);
        return { output: await this.behaviour(input) };
    }
}

const usage = (runId: string, costUsd: number) =>
    ({
        type: 'usage',
        model: 'claude-opus-5-5',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
        sessionId: `s-${runId}`,
    }) as const;

/** Rejects once the run's signal aborts, as a well-behaved harness does. */
const untilAborted = (input: HarnessInput) =>
    new Promise<never>((_, reject) =>
        input.signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
        await new Promise((r) => setTimeout(r, 5));
    }
}

/**
 * A fetch to the test API that answers the requests `fail` picks itself, with an error response
 * or a thrown network error, to stand in for an outage.
 */
function flaky(fail: (path: string) => Response | Error | undefined): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const outcome = fail(new URL(request.url).pathname);
        if (outcome instanceof Error) throw outcome;
        return outcome ?? t.fetch(request);
    }) as typeof fetch;
}

let harness: FakeHarness;
let runner: Runner;
let logs: string[];
const api = (fetch = t.fetch) => createApiClient({ baseUrl: TEST_URL, token: TEST_TOKEN, fetch });

function makeRunner(options: Partial<RunnerOptions> = {}) {
    return new Runner({
        api: api(),
        harness,
        runnerId: 'test-runner',
        apiUrl: TEST_URL,
        heartbeatMs: 20,
        flushMs: 5,
        retryMs: 5,
        log: (message) => logs.push(message),
        ...options,
    });
}

beforeEach(() => {
    harness = new FakeHarness();
    logs = [];
    runner = makeRunner();
});

async function send(text: string, conversationId?: string) {
    const id = conversationId ?? (await t.call('POST', '/conversations', {})).body.id;
    const { run } = (await t.call('POST', `/conversations/${id}/messages`, { text })).body;
    return { conversationId: id, runId: run.id as string };
}

const getRun = async (runId: string) => (await t.call('GET', `/runs/${runId}`)).body;

describe('runner', () => {
    it('executes a chat turn and records what the harness reported', async () => {
        await t.call('POST', '/mcp-servers', {
            name: 'notes',
            transport: 'stdio',
            command: 'notes-mcp',
        });
        const claims: { agentToken: string }[] = [];
        const spying = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const res = await t.fetch(input, init);
            if (String(input).endsWith('/runs/claim') && res.status === 200)
                claims.push(await res.clone().json());
            return res;
        }) as typeof fetch;
        runner = makeRunner({ api: api(spying) });
        const { conversationId, runId } = await send('hello');
        expect(await runner.runOnce(0)).toBe(true);

        const input = harness.inputs[0]!;
        // The agent gets the run's scoped token, never the runner's own API token.
        expect(claims[0]!.agentToken).toBeTruthy();
        expect(input.mcpServers[0]).toEqual({
            name: 'lyfestyle',
            transport: 'http',
            url: `${TEST_URL}/mcp`,
            headers: { Authorization: `Bearer ${claims[0]!.agentToken}` },
        });
        expect(JSON.stringify(input.mcpServers)).not.toContain(TEST_TOKEN);
        expect(input.mcpServers.map((s) => s.name)).toContain('notes');

        const run = await getRun(runId);
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
        expect(await getRun(runId)).toMatchObject({ status: 'failed', error: 'model overloaded' });
        const events = (await t.call('GET', `/runs/${runId}/events?type=log`)).body.items;
        expect(events.at(-1)).toMatchObject({ level: 'error', message: 'model overloaded' });
    });

    it('aborts the harness when the run is cancelled', async () => {
        harness.behaviour = untilAborted;
        const { runId } = await send('long task');
        const running = runner.runOnce(0);
        await until(() => harness.inputs.length === 1);
        await t.call('POST', `/runs/${runId}/cancel`);
        await running;
        expect((await getRun(runId)).status).toBe('cancelled');
    });

    it('reports nothing claimed when the queue is empty', async () => {
        while (await runner.runOnce(0));
        expect(await runner.runOnce(0)).toBe(false);
    });

    it('retries failed reports and delivers every event in order', async () => {
        let failures = 3;
        runner = makeRunner({
            api: api(
                flaky((path) => {
                    if (!path.endsWith('/events') || failures <= 0) return undefined;
                    failures--;
                    return failures === 1
                        ? new Response('Bad gateway', { status: 502 })
                        : new TypeError('fetch failed');
                }),
            ),
        });
        harness.behaviour = async (input) => {
            input.emit({ type: 'session', harness: 'fake', sessionId: `s-${input.runId}` });
            input.emit({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'one' }],
            });
            await new Promise((r) => setTimeout(r, 20));
            input.emit({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'two' }],
            });
            input.emit(usage(input.runId, 0.02));
            return 'two';
        };
        const { conversationId, runId } = await send('go');
        await runner.runOnce(0);

        expect(failures).toBe(0);
        expect(await getRun(runId)).toMatchObject({ status: 'succeeded', output: 'two' });
        expect((await getRun(runId)).usage.costUsd).toBe(0.02);
        const convo = (await t.call('GET', `/conversations/${conversationId}`)).body;
        expect(convo.harnessSessionId).toBe(`s-${runId}`);
        expect(
            convo.messages.map((m: { content: { text?: string }[] }) => m.content[0]!.text),
        ).toEqual(['go', 'one', 'two']);
    });

    it('drops an invalid event instead of failing the batch it is in', async () => {
        harness.behaviour = async (input) => {
            input.emit({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'a' }],
            });
            input.emit({ type: 'message', role: 'assistant', content: [] });
            input.emit({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'b' }],
            });
            return 'b';
        };
        const { conversationId, runId } = await send('mixed');
        await runner.runOnce(0);
        expect((await getRun(runId)).status).toBe('succeeded');
        const convo = (await t.call('GET', `/conversations/${conversationId}`)).body;
        expect(convo.messages).toHaveLength(3);
        expect(logs).toContainEqual(expect.stringContaining('Dropped an invalid message event'));
    });

    it('gives up on unreported events after the flush timeout and still completes', async () => {
        runner = makeRunner({
            api: api(
                flaky((path) => (path.endsWith('/events') ? new TypeError('down') : undefined)),
            ),
            flushTimeoutMs: 50,
        });
        const { runId } = await send('offline');
        await runner.runOnce(0);
        expect(await getRun(runId)).toMatchObject({ status: 'succeeded', output: 'echo: offline' });
        expect(logs).toContainEqual(expect.stringContaining('Could not report the last'));
    });

    it('retries completing a finished run through an outage', async () => {
        let failures = 2;
        runner = makeRunner({
            api: api(
                flaky((path) =>
                    path.endsWith('/complete') && failures-- > 0
                        ? new Response('Service unavailable', { status: 503 })
                        : undefined,
                ),
            ),
        });
        const { runId } = await send('finish');
        await runner.runOnce(0);
        expect(await getRun(runId)).toMatchObject({ status: 'succeeded', output: 'echo: finish' });
    });

    it('stops the harness at once when its conversation is deleted', async () => {
        harness.behaviour = untilAborted;
        const { conversationId } = await send('doomed');
        const running = runner.runOnce(0);
        await until(() => harness.inputs.length === 1);
        await t.call('DELETE', `/conversations/${conversationId}`);
        await running;
        expect(harness.inputs[0]!.signal.aborted).toBe(true);
    });

    it.each(['/heartbeat', '/events'])(
        'drops the run without completing it when %s answers 404',
        async (route) => {
            const completions: string[] = [];
            runner = makeRunner({
                api: api(
                    flaky((path) => {
                        if (path.endsWith('/complete')) completions.push(path);
                        return path.endsWith(route)
                            ? Response.json(
                                  { error: { code: 'not_found', message: 'Run not found' } },
                                  { status: 404 },
                              )
                            : undefined;
                    }),
                ),
            });
            harness.behaviour = async (input) => {
                input.emit({ type: 'log', level: 'info', message: 'working' });
                return untilAborted(input);
            };
            const { conversationId } = await send('gone');
            await runner.runOnce(0);
            expect(harness.inputs[0]!.signal.reason).toBe('deleted');
            expect(completions).toEqual([]);
            await t.call('DELETE', `/conversations/${conversationId}`);
        },
    );

    it('fails a run that outlives RUN_TIMEOUT_MINUTES', async () => {
        harness.behaviour = untilAborted;
        runner = makeRunner({ runTimeoutMs: 50 });
        const { runId } = await send('hang');
        await runner.runOnce(0);
        const run = await getRun(runId);
        expect(run.status).toBe('failed');
        expect(run.error).toContain('RUN_TIMEOUT_MINUTES');
    });

    it('never starts the harness when the run is stopped while it is being set up', async () => {
        runner = makeRunner({
            soul: async () => {
                void runner.stop();
                return '';
            },
        });
        const { runId } = await send('too late');
        await runner.runOnce(0);
        expect(harness.inputs).toEqual([]);
        expect(await getRun(runId)).toMatchObject({
            status: 'failed',
            error: 'Runner shut down mid-run',
        });
    });

    it('keeps the output of a run that finished as a budget stop landed', async () => {
        harness.behaviour = async (input) => {
            input.emit(usage(input.runId, 10));
            await until(() => input.signal.aborted);
            return 'finished anyway';
        };
        const { runId } = await send('expensive');
        await runner.runOnce(0);
        expect(await getRun(runId)).toMatchObject({
            status: 'succeeded',
            output: 'finished anyway',
        });
    });

    it('stops promptly while backing off from a failing API', async () => {
        runner = makeRunner({
            api: api(
                flaky((path) => (path.endsWith('/claim') ? new TypeError('down') : undefined)),
            ),
        });
        runner.start();
        await until(() => logs.some((l) => l.startsWith('Runner error')));
        const started = Date.now();
        await runner.stop();
        expect(Date.now() - started).toBeLessThan(500);
    });
});

describe('bridge', () => {
    const client = () => ({ baseUrl: TEST_URL, token: TEST_TOKEN, fetch: t.fetch });

    function collect() {
        const lines: Record<string, any>[] = [];
        const warnings: string[] = [];
        const io = {
            write: (line: object) => lines.push(line),
            warn: (m: string) => warnings.push(m),
        };
        return { lines, warnings, io };
    }

    it('prints a turn as Claude Code stream-json and continues the conversation', async () => {
        while (await runner.runOnce(0));
        const { lines, warnings, io } = collect();

        const turn = bridge({ client: client(), prompt: 'ping', io });
        await runner.runOnce(5_000);
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
        const again = bridge({ client: client(), prompt: 'pong', session: init!.session_id, io });
        await runner.runOnce(5_000);
        await again;
        expect(lines[0]!.session_id).toBe(init!.session_id);
        const convo = (await t.call('GET', `/conversations/${init!.session_id}`)).body;
        expect(convo.messages).toHaveLength(4);
        expect(warnings).toEqual([]);
    });

    it('starts a fresh conversation for an unknown session and says so', async () => {
        const { lines, warnings, io } = collect();
        const turn = bridge({ client: client(), prompt: 'hi', session: crypto.randomUUID(), io });
        await runner.runOnce(5_000);
        await turn;
        expect(warnings[0]).toContain('No conversation found');
        expect(lines.at(-1)).toMatchObject({ type: 'result', is_error: false });
    });

    it('ends a failed run with an error result and exit code 1', async () => {
        harness.behaviour = async () => {
            throw new Error('model overloaded');
        };
        const { lines, warnings, io } = collect();
        const turn = bridge({ client: client(), prompt: 'boom', io });
        await runner.runOnce(5_000);
        expect(await turn).toBe(1);
        expect(lines.at(-1)).toMatchObject({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            result: 'model overloaded',
        });
        expect(warnings).toContain('model overloaded');
    });

    it('cancels the run when interrupted', async () => {
        harness.behaviour = untilAborted;
        const stop = new AbortController();
        const { lines, io } = collect();
        const turn = bridge({ client: client(), prompt: 'wait', io, signal: stop.signal });
        const running = runner.runOnce(5_000);
        await until(() => harness.inputs.length === 1);
        stop.abort();
        // Interrupted, the bridge either stops reading at once or reports the cancelled run.
        expect(['interrupted', 1]).toContain(await turn.catch(() => 'interrupted'));
        await running;
        expect((await getRun(lines[0]!.run_id)).status).toBe('cancelled');
    });

    describe('bin/lyfestyle-agent.mjs', () => {
        let server: Server;
        let url: string;
        beforeAll(async () => {
            // The bin talks HTTP, so the in-process API gets a real socket for this test.
            server = createServer(async (req, res) => {
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(chunk as Buffer);
                const response = await t.app.fetch(
                    new Request(`${url}${req.url}`, {
                        method: req.method!,
                        headers: req.headers as Record<string, string>,
                        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
                    }),
                );
                res.writeHead(response.status, Object.fromEntries(response.headers));
                if (response.body) for await (const chunk of response.body) res.write(chunk);
                res.end();
            });
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        });
        afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

        it('prints only JSON lines on stdout and the unknown-session phrase on stderr', async () => {
            const bin = fileURLToPath(new URL('../bin/lyfestyle-agent.mjs', import.meta.url));
            const child = spawn(process.execPath, [bin, '--session', crypto.randomUUID()], {
                env: { ...process.env, LYFESTYLE_API_URL: url, LYFESTYLE_API_TOKEN: TEST_TOKEN },
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
            child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
            const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
            child.stdin.end('ping from the bin');

            await runner.runOnce(20_000);
            expect(await exited).toBe(0);
            const lines = stdout.trimEnd().split('\n');
            const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(parsed[0]).toMatchObject({ type: 'system', subtype: 'init' });
            expect(parsed.at(-1)).toMatchObject({
                type: 'result',
                subtype: 'success',
                result: 'echo: ping from the bin',
            });
            expect(stderr).toContain('No conversation found');
        }, 30_000);
    });
});
