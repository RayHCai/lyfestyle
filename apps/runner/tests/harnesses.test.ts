import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunEventInput } from '@lyfestyle/shared';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeHarness, DEFAULT_CONNECTOR_TOOLS, mapSdkMessage } from '../src/claude-code.js';
import { CommandHarness, splitCommand } from '../src/command.js';
import type { HarnessInput } from '../src/harness.js';

const msg = (m: unknown) => m as SDKMessage;

const init = msg({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-9',
    claude_code_version: '2.1.302',
    model: 'claude-opus-5-5',
    tools: ['WebSearch', 'mcp__lyfestyle__pages_search'],
    mcp_servers: [
        { name: 'lyfestyle', status: 'connected' },
        { name: 'broken', status: 'failed' },
    ],
});

const assistant = msg({
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 'sess-9',
    message: {
        content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'Let me look.' },
            {
                type: 'tool_use',
                id: 'tu_1',
                name: 'mcp__lyfestyle__pages_search',
                input: { query: 'x' },
            },
        ],
    },
});

const toolResult = msg({
    type: 'user',
    parent_tool_use_id: null,
    session_id: 'sess-9',
    message: {
        role: 'user',
        content: [
            {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [{ type: 'text', text: '[]' }],
                is_error: true,
            },
        ],
    },
});

const result = (cumulative: number) =>
    msg({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Nothing found.',
        session_id: 'sess-9',
        num_turns: 2,
        duration_ms: 1234.5,
        total_cost_usd: cumulative / 1000,
        modelUsage: {
            'claude-opus-5-5': {
                inputTokens: cumulative,
                outputTokens: cumulative / 10,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 50,
                costUSD: cumulative / 1000,
            },
        },
        errors: [],
    });

function input(overrides: Partial<HarnessInput> = {}): HarnessInput & { events: RunEventInput[] } {
    const events: RunEventInput[] = [];
    return {
        runId: 'run-1',
        kind: 'chat',
        prompt: 'find x',
        session: null,
        history: [],
        job: null,
        mcpServers: [
            {
                name: 'lyfestyle',
                transport: 'http',
                url: 'http://api/mcp',
                headers: { Authorization: 'Bearer t' },
            },
            {
                name: 'files',
                transport: 'stdio',
                command: 'files-mcp',
                args: ['--ro'],
                env: { A: '1' },
            },
        ],
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        events,
        ...overrides,
    };
}

describe('mapSdkMessage', () => {
    it('turns init into a session event and flags MCP servers that did not connect', () => {
        const events = mapSdkMessage(init, 'claude-code');
        expect(events[0]).toEqual({ type: 'session', harness: 'claude-code', sessionId: 'sess-9' });
        expect(events.at(-1)).toMatchObject({
            type: 'log',
            level: 'warn',
            message: 'MCP server "broken" is failed',
        });
    });

    it('keeps text and tool calls, dropping empty thinking', () => {
        expect(mapSdkMessage(assistant, 'claude-code')).toEqual([
            {
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me look.' },
                    {
                        type: 'tool_use',
                        id: 'tu_1',
                        name: 'mcp__lyfestyle__pages_search',
                        input: { query: 'x' },
                    },
                ],
            },
        ]);
    });

    it('records tool results', () => {
        expect(mapSdkMessage(toolResult, 'claude-code')).toEqual([
            {
                type: 'message',
                role: 'tool',
                content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '[]', isError: true }],
            },
        ]);
    });

    it('ignores subagent traffic', () => {
        expect(
            mapSdkMessage(
                msg({ ...(assistant as object), parent_tool_use_id: 'tu_0' }),
                'claude-code',
            ),
        ).toEqual([]);
    });

    it('reports only what a resumed session added since its earlier runs', () => {
        const baseline = [
            {
                model: 'claude-opus-5-5',
                inputTokens: 1000,
                outputTokens: 100,
                cacheReadTokens: 0,
                cacheWriteTokens: 50,
                costUsd: 1,
            },
        ];
        const [usage] = mapSdkMessage(result(1500), 'claude-code', baseline);
        expect(usage).toEqual({
            type: 'usage',
            model: 'claude-opus-5-5',
            inputTokens: 500,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.5,
            sessionId: 'sess-9',
            durationMs: 1235,
        });
    });
});

describe('ClaudeCodeHarness', () => {
    function fakeQuery(messages: SDKMessage[], seen: { prompt?: string; options?: Options }) {
        return (({ prompt, options }: { prompt: string; options?: Options }) => {
            seen.prompt = prompt;
            if (options) seen.options = options;
            return (async function* () {
                yield* messages;
            })();
        }) as unknown as NonNullable<ConstructorParameters<typeof ClaudeCodeHarness>[0]['query']>;
    }

    it('locks Claude Code down to the app’s tools and its own settings', async () => {
        const seen: { prompt?: string; options?: Options } = {};
        const harness = new ClaudeCodeHarness({
            cwd: '/agent',
            model: 'claude-opus-5-5',
            query: fakeQuery([init, assistant, toolResult, result(100)], seen),
        });
        const run = input();
        expect(await harness.run(run)).toEqual({ output: 'Nothing found.' });

        expect(seen.options).toMatchObject({
            cwd: '/agent',
            model: 'claude-opus-5-5',
            tools: ['WebSearch', 'WebFetch'],
            allowedTools: [
                'WebSearch',
                'WebFetch',
                'mcp__lyfestyle',
                'mcp__files',
                ...DEFAULT_CONNECTOR_TOOLS,
            ],
            permissionMode: 'dontAsk',
            strictMcpConfig: false,
            settingSources: [],
            mcpServers: {
                lyfestyle: {
                    type: 'http',
                    url: 'http://api/mcp',
                    headers: { Authorization: 'Bearer t' },
                },
                files: { type: 'stdio', command: 'files-mcp', args: ['--ro'], env: { A: '1' } },
            },
        });
        expect(seen.options!.resume).toBeUndefined();
        expect(seen.options!.systemPrompt).toContain('Lyfestyle');
        expect(run.events.map((e) => e.type)).toEqual([
            'session',
            'log',
            'log',
            'message',
            'message',
            'usage',
            'log',
        ]);
    });

    it('keeps claude.ai connectors out when no connector tools are allowed', async () => {
        const seen: { prompt?: string; options?: Options } = {};
        const harness = new ClaudeCodeHarness({
            cwd: '/agent',
            connectorTools: [],
            query: fakeQuery([result(10)], seen),
        });
        await harness.run(input());
        expect(seen.options).toMatchObject({
            allowedTools: ['WebSearch', 'WebFetch', 'mcp__lyfestyle', 'mcp__files'],
            strictMcpConfig: true,
        });
    });

    it('resumes its own session and replays history for anyone else’s', async () => {
        const seen: { prompt?: string; options?: Options } = {};
        const harness = new ClaudeCodeHarness({
            cwd: '/agent',
            query: fakeQuery([result(10)], seen),
        });
        await harness.run(
            input({ session: { harness: 'claude-code', sessionId: 'sess-1', usage: [] } }),
        );
        expect(seen.options!.resume).toBe('sess-1');
        expect(seen.prompt).toBe('find x');

        await harness.run(
            input({
                session: { harness: 'other', sessionId: 'x', usage: [] },
                history: [
                    { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
                    { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
                ],
            }),
        );
        expect(seen.options!.resume).toBeUndefined();
        expect(seen.prompt).toContain('User: earlier question\n\nAssistant: earlier answer');
        expect(seen.prompt!.endsWith('find x')).toBe(true);
    });

    it('fails on an error result', async () => {
        const failed = msg({
            ...(result(1) as object),
            subtype: 'error_max_turns',
            errors: ['Reached max turns'],
        });
        const harness = new ClaudeCodeHarness({ cwd: '/agent', query: fakeQuery([failed], {}) });
        await expect(harness.run(input())).rejects.toThrow('Reached max turns');
    });
});

describe('CommandHarness', () => {
    it('splits quoted command lines', () => {
        expect(splitCommand(`node "C:/My Agent/run.mjs" --flag 'two words'`)).toEqual([
            'node',
            'C:/My Agent/run.mjs',
            '--flag',
            'two words',
        ]);
    });

    it('runs any stream-json agent with the prompt on stdin', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lyfestyle-agent-'));
        const script = join(dir, 'agent.mjs');
        await writeFile(
            script,
            `let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
    const session = process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : 'new';
    const out = (o) => console.log(JSON.stringify(o));
    out({ type: 'system', subtype: 'init', session_id: 'cmd-' + session, claude_code_version: 'x', model: 'm', tools: [], mcp_servers: [] });
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'got ' + prompt }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done:' + session, session_id: 'cmd-' + session, num_turns: 1, duration_ms: 1, total_cost_usd: 0, modelUsage: {}, errors: [] });
});`,
        );
        const harness = new CommandHarness(`node "${script}"`);
        const first = input();
        expect(await harness.run(first)).toEqual({ output: 'done:new' });
        expect(first.events[0]).toEqual({
            type: 'session',
            harness: 'command',
            sessionId: 'cmd-new',
        });
        expect(first.events).toContainEqual({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'got find x' }],
        });

        const resumed = input({ session: { harness: 'command', sessionId: 'abc', usage: [] } });
        expect(await harness.run(resumed)).toEqual({ output: 'done:abc' });
    });
});
