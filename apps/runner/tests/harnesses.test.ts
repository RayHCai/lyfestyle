import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunEventInput } from '@lyfestyle/shared';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeHarness, DEFAULT_CONNECTOR_TOOLS, mapSdkMessage } from '../src/claude-code.js';
import { cmdArg, CommandHarness, splitCommand } from '../src/command.js';
import { agentEnv, type HarnessInput } from '../src/harness.js';

const msg = (m: unknown) => m as SDKMessage;
const windows = process.platform === 'win32';

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

function input(overrides: Partial<HarnessInput> = {}): HarnessInput & { events: RunEventInput[] } {
    const events: RunEventInput[] = [];
    return {
        runId: 'run-1',
        kind: 'chat',
        prompt: 'find x',
        session: null,
        history: [],
        automation: null,
        soul: '',
        budgetUsd: 5,
        mcpServers: [
            {
                name: 'lyfestyle',
                transport: 'http',
                url: 'http://api/mcp',
                headers: { Authorization: 'Bearer agent-token' },
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

const history: HarnessInput['history'] = [
    { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
];

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

    it('takes figures below the baseline as this run alone, not as nothing spent', () => {
        // A transcript without saved totals restarts the count at this run.
        const [usage] = mapSdkMessage(result(300), 'claude-code', baseline);
        expect(usage).toMatchObject({
            inputTokens: 300,
            outputTokens: 30,
            cacheWriteTokens: 50,
            costUsd: 0.3,
        });
    });

    it('caps absurd token counts at what the API can store', () => {
        const huge = msg({
            ...(result(1) as object),
            modelUsage: { m: { inputTokens: 1e12, outputTokens: -5, costUSD: Number.NaN } },
        });
        expect(mapSdkMessage(huge, 'command')[0]).toMatchObject({
            inputTokens: 2_147_483_647,
            outputTokens: 0,
            costUsd: 0,
        });
    });

    it('turns malformed lines into warnings instead of throwing', () => {
        const lines: unknown[] = [
            null,
            42,
            { type: 'result' },
            { type: 'assistant', message: {} },
            { type: 'assistant' },
            { type: 'system', subtype: 'init' },
            { type: 'user', message: null },
            { type: 'result', subtype: 'x', modelUsage: { '': {}, m: null } },
        ];
        for (const line of lines) expect(() => mapSdkMessage(line, 'command')).not.toThrow();
        expect(mapSdkMessage(null, 'command')).toEqual([
            expect.objectContaining({ type: 'log', level: 'warn' }),
        ]);
        expect(
            mapSdkMessage({ type: 'system', subtype: 'init', session_id: 's' }, 'command')[0],
        ).toEqual({ type: 'session', harness: 'command', sessionId: 's' });
    });
});

describe('agentEnv', () => {
    it('keeps what an agent needs and drops what only the API may see', () => {
        const env = agentEnv(
            { EXTRA: '1' },
            {
                PATH: '/bin',
                HOME: '/home/me',
                APPDATA: 'C:/AppData',
                ANTHROPIC_API_KEY: 'sk-ant',
                DATABASE_URL: 'postgresql://prod',
                SHADOW_DATABASE_URL: 'postgresql://shadow',
                ENCRYPTION_KEY: 'key',
                RESEND_API_KEY: 're_key',
                API_TOKEN: 'root',
                LYFESTYLE_API_TOKEN: 'root',
                database_url: 'postgresql://lowercase',
                UNSET: undefined,
            },
        );
        expect(env).toEqual({
            PATH: '/bin',
            HOME: '/home/me',
            APPDATA: 'C:/AppData',
            ANTHROPIC_API_KEY: 'sk-ant',
            EXTRA: '1',
        });
    });
});

describe('ClaudeCodeHarness', () => {
    type Seen = { prompt?: string; options?: Options; calls: number };
    type Query = NonNullable<ConstructorParameters<typeof ClaudeCodeHarness>[0]['query']>;

    /** A fake `query`: each call gets the next script, which yields messages or throws. */
    function fakeQuery(seen: Seen, ...scripts: (SDKMessage[] | Error)[]): Query {
        return (({ prompt, options }: { prompt: string; options?: Options }) => {
            seen.calls++;
            seen.prompt = prompt;
            if (options) seen.options = options;
            const script = scripts.length > 1 ? scripts.shift()! : scripts[0]!;
            return (async function* () {
                if (script instanceof Error) throw script;
                yield* script;
            })();
        }) as unknown as Query;
    }
    const seen = (): Seen => ({ calls: 0 });

    it('locks Claude Code down to the app’s tools and its own settings', async () => {
        const s = seen();
        const harness = new ClaudeCodeHarness({
            cwd: '/agent',
            model: 'claude-opus-5-5',
            query: fakeQuery(s, [init, assistant, toolResult, result(100)]),
        });
        const run = input();
        expect(await harness.run(run)).toEqual({ output: 'Nothing found.' });

        expect(s.options).toMatchObject({
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
                    headers: { Authorization: 'Bearer agent-token' },
                },
                files: { type: 'stdio', command: 'files-mcp', args: ['--ro'], env: { A: '1' } },
            },
        });
        expect(s.options!.resume).toBeUndefined();
        expect(s.options!.systemPrompt).toContain('Lyfestyle');
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

    it('gives Claude Code the runner’s environment without the API’s secrets', async () => {
        const saved = { DATABASE_URL: process.env.DATABASE_URL, API_TOKEN: process.env.API_TOKEN };
        process.env.DATABASE_URL = 'postgresql://production';
        process.env.API_TOKEN = 'root-token';
        try {
            const s = seen();
            await new ClaudeCodeHarness({ cwd: '/agent', query: fakeQuery(s, [result(1)]) }).run(
                input(),
            );
            const env = s.options!.env!;
            expect(env.DATABASE_URL).toBeUndefined();
            expect(env.API_TOKEN).toBeUndefined();
            expect(Object.keys(env).some((k) => k.toUpperCase() === 'PATH')).toBe(true);
            expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^lyfestyle-runner\/\d+\.\d+\.\d+/);
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    it('keeps claude.ai connectors out when no connector tools are allowed', async () => {
        const s = seen();
        const harness = new ClaudeCodeHarness({
            cwd: '/agent',
            connectorTools: [],
            query: fakeQuery(s, [result(10)]),
        });
        await harness.run(input());
        expect(s.options).toMatchObject({
            allowedTools: ['WebSearch', 'WebFetch', 'mcp__lyfestyle', 'mcp__files'],
            strictMcpConfig: true,
        });
    });

    it('puts the user’s SOUL.md in the system prompt, and nothing when there is none', async () => {
        const s = seen();
        const harness = new ClaudeCodeHarness({ cwd: '/agent', query: fakeQuery(s, [result(10)]) });
        await harness.run(input({ soul: 'Be terse.' }));
        expect(s.options!.systemPrompt).toContain('<soul>\nBe terse.\n</soul>');
        await harness.run(input());
        expect(s.options!.systemPrompt).not.toContain('<soul>');
    });

    it('caps spend at the run’s budget, or the runner’s own lower cap, resumed or not', async () => {
        const s = seen();
        await new ClaudeCodeHarness({ cwd: '/agent', query: fakeQuery(s, [result(10)]) }).run(
            input({ budgetUsd: 5 }),
        );
        expect(s.options!.maxBudgetUsd).toBe(5);

        await new ClaudeCodeHarness({
            cwd: '/agent',
            maxBudgetUsd: 2,
            query: fakeQuery(s, [result(10)]),
        }).run(input({ budgetUsd: 5 }));
        expect(s.options!.maxBudgetUsd).toBe(2);

        // Claude Code counts maxBudgetUsd from the process start, not the restored session total.
        await new ClaudeCodeHarness({ cwd: '/agent', query: fakeQuery(s, [result(2000)]) }).run(
            input({
                budgetUsd: 5,
                session: { harness: 'claude-code', sessionId: 's', usage: baseline },
            }),
        );
        expect(s.options!.maxBudgetUsd).toBe(5);
    });

    it('resumes its own session and replays history for anyone else’s', async () => {
        const s = seen();
        const harness = new ClaudeCodeHarness({ cwd: '/agent', query: fakeQuery(s, [result(10)]) });
        await harness.run(
            input({ session: { harness: 'claude-code', sessionId: 'sess-1', usage: [] } }),
        );
        expect(s.options!.resume).toBe('sess-1');
        expect(s.prompt).toBe('find x');

        await harness.run(
            input({ session: { harness: 'other', sessionId: 'x', usage: [] }, history }),
        );
        expect(s.options!.resume).toBeUndefined();
        expect(s.prompt).toContain('User: earlier question\n\nAssistant: earlier answer');
        expect(s.prompt!.endsWith('find x')).toBe(true);
    });

    it('starts afresh with the history when Claude Code no longer has the session', async () => {
        // How the SDK surfaces `claude --resume <missing id>`: exit code 1 with the CLI's stderr.
        const gone = new Error(
            'Claude Code process exited with code 1. stderr: No conversation found with session ID: sess-1',
        );
        const s = seen();
        const harness = new ClaudeCodeHarness({
            cwd: '/agent',
            query: fakeQuery(s, gone, [init, result(10)]),
        });
        const run = input({
            session: { harness: 'claude-code', sessionId: 'sess-1', usage: baseline },
            history,
        });
        expect(await harness.run(run)).toEqual({ output: 'Nothing found.' });
        expect(s.calls).toBe(2);
        expect(s.options!.resume).toBeUndefined();
        expect(s.prompt).toContain('<conversation_so_far>');
        expect(run.events[0]).toMatchObject({ type: 'log', level: 'warn' });
        // A fresh session's totals are this run's own, so no baseline is subtracted.
        expect(run.events.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 10 });
    });

    it('also starts afresh when the missing session arrives as an error result', async () => {
        const gone = msg({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['No conversation found with session ID: sess-1'],
            modelUsage: {},
        });
        const s = seen();
        const harness = new ClaudeCodeHarness({
            cwd: '/agent',
            query: fakeQuery(s, [gone], [result(10)]),
        });
        const run = input({ session: { harness: 'claude-code', sessionId: 'sess-1', usage: [] } });
        expect(await harness.run(run)).toEqual({ output: 'Nothing found.' });
        expect(run.events.filter((e) => e.type === 'log' && e.level === 'error')).toEqual([]);
    });

    it('does not retry other failures of a resumed session', async () => {
        const s = seen();
        const harness = new ClaudeCodeHarness({
            cwd: '/agent',
            query: fakeQuery(s, new Error('Claude Code process exited with code 1. stderr: boom')),
        });
        await expect(
            harness.run(input({ session: { harness: 'claude-code', sessionId: 's', usage: [] } })),
        ).rejects.toThrow('boom');
        expect(s.calls).toBe(1);
    });

    it('never starts Claude Code for a run stopped before it began', async () => {
        const s = seen();
        const stopped = new AbortController();
        stopped.abort('cancelled');
        const harness = new ClaudeCodeHarness({ cwd: '/agent', query: fakeQuery(s, [result(1)]) });
        await expect(harness.run(input({ signal: stopped.signal }))).rejects.toThrow(
            'stopped before Claude Code started',
        );
        expect(s.calls).toBe(0);
    });

    it('fails on an error result', async () => {
        const failed = msg({
            ...(result(1) as object),
            subtype: 'error_max_turns',
            errors: ['Reached max turns'],
        });
        const harness = new ClaudeCodeHarness({
            cwd: '/agent',
            query: fakeQuery(seen(), [failed]),
        });
        await expect(harness.run(input())).rejects.toThrow('Reached max turns');
    });
});

describe('CommandHarness', () => {
    let dir: string;
    beforeAll(async () => {
        // A space in the path, as in "C:\Users\First Last", must survive every hop.
        dir = join(await mkdtemp(join(tmpdir(), 'lyfestyle-agent-')), 'my agent');
        await mkdir(dir);
    });
    afterAll(() => rm(join(dir, '..'), { recursive: true, force: true }));

    let scripts = 0;
    /** Writes a throwaway agent script and returns the command line that runs it with node. */
    async function agent(source: string) {
        const file = join(dir, `agent-${++scripts}.mjs`);
        await writeFile(file, source);
        return `"${process.execPath}" "${file}"`;
    }

    /**
     * A native wrapper script (`.cmd` on Windows, `sh` elsewhere) that runs `script` with node and
     * stays its parent, so the agent is a grandchild of the runner.
     */
    async function wrapper(script: string) {
        const name = join(dir, `wrapper-${++scripts}${windows ? '.cmd' : ''}`);
        await writeFile(
            name,
            windows
                ? `@"${process.execPath}" "${script}" %*\r\n`
                : `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`,
        );
        if (!windows) await chmod(name, 0o755);
        return name;
    }

    const resultLine = (expr: string) =>
        `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${expr}, session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0, modelUsage: {}, errors: [] }));`;

    /** An agent that answers with its arguments, its prompt and the env vars it was given. */
    const echo = () =>
        agent(`let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
    const env = Object.fromEntries(['LYFESTYLE_MAX_BUDGET_USD', 'LYFESTYLE_MAX_TURNS', 'DATABASE_URL', 'LYFESTYLE_API_TOKEN'].map((k) => [k, process.env[k] ?? null]));
    ${resultLine('JSON.stringify({ args: process.argv.slice(2), prompt, env })')}
});`);

    it('splits quoted command lines', () => {
        expect(splitCommand(`node "C:/My Agent/run.mjs" --flag 'two words'`)).toEqual([
            'node',
            'C:/My Agent/run.mjs',
            '--flag',
            'two words',
        ]);
    });

    it('quotes cmd.exe arguments and refuses what cmd.exe would still expand', () => {
        expect(cmdArg('--session')).toBe('--session');
        expect(cmdArg('C:\\My Agent\\run.cmd')).toBe('"C:\\My Agent\\run.cmd"');
        expect(cmdArg('a&b|c')).toBe('"a&b|c"');
        expect(cmdArg('my dir\\')).toBe('"my dir\\\\"');
        expect(cmdArg('')).toBe('""');
        for (const bad of ['%PATH%', 'say "hi"', 'two\nlines'])
            expect(() => cmdArg(bad)).toThrow('Cannot pass');
    });

    it('runs any stream-json agent with the prompt on stdin', async () => {
        const harness = new CommandHarness(
            await agent(`let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
    const session = process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : 'new';
    const out = (o) => console.log(JSON.stringify(o));
    out({ type: 'system', subtype: 'init', session_id: 'cmd-' + session, claude_code_version: 'x', model: 'm', tools: [], mcp_servers: [] });
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'got ' + prompt }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done:' + session, session_id: 'cmd-' + session, num_turns: 1, duration_ms: 1, total_cost_usd: 0, modelUsage: {}, errors: [] });
});`),
        );
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

    it('opens a fresh command session with the user’s SOUL.md, and leaves resumed ones alone', async () => {
        const harness = new CommandHarness(
            await agent(`let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
    ${resultLine('prompt')}
});`),
        );
        expect(await harness.run(input({ soul: 'Be terse.' }))).toEqual({
            output: '<soul>\nBe terse.\n</soul>\n\nfind x',
        });
        const resumed = input({
            soul: 'Be terse.',
            session: { harness: 'command', sessionId: 'abc', usage: [] },
        });
        expect(await harness.run(resumed)).toEqual({ output: 'find x' });
    });

    it('hands the command its MCP servers as a Claude Code config file', async () => {
        const { output } = await new CommandHarness(
            await agent(`import { readFileSync } from 'node:fs';
process.stdin.resume();
process.stdin.on('end', () => {
    ${resultLine("readFileSync(process.env.LYFESTYLE_MCP_CONFIG, 'utf8')")}
});`),
        ).run(input());
        expect(JSON.parse(output ?? '')).toEqual({
            mcpServers: {
                lyfestyle: {
                    type: 'http',
                    url: 'http://api/mcp',
                    headers: { Authorization: 'Bearer agent-token' },
                },
                files: {
                    type: 'stdio',
                    command: 'files-mcp',
                    args: ['--ro'],
                    env: { A: '1' },
                },
            },
        });
    });

    it('passes the budget and turn cap, and none of the API’s secrets', async () => {
        const saved = process.env.DATABASE_URL;
        process.env.DATABASE_URL = 'postgresql://production';
        try {
            const harness = new CommandHarness(await echo(), { maxTurns: 7, maxBudgetUsd: 2 });
            const { output } = await harness.run(input({ budgetUsd: 5 }));
            expect(JSON.parse(output!).env).toEqual({
                LYFESTYLE_MAX_BUDGET_USD: '2',
                LYFESTYLE_MAX_TURNS: '7',
                DATABASE_URL: null,
                LYFESTYLE_API_TOKEN: null,
            });
            const lower = await new CommandHarness(await echo(), { maxBudgetUsd: 9 }).run(
                input({ budgetUsd: 0.5 }),
            );
            expect(JSON.parse(lower.output!).env.LYFESTYLE_MAX_BUDGET_USD).toBe('0.5');
        } finally {
            if (saved === undefined) delete process.env.DATABASE_URL;
            else process.env.DATABASE_URL = saved;
        }
    });

    it('will not hand a stored session id with shell syntax back to the command', async () => {
        const run = input({
            session: { harness: 'command', sessionId: 'x&echo INJECTED', usage: [] },
            history,
        });
        const { output } = await new CommandHarness(await echo()).run(run);
        const seen = JSON.parse(output!);
        expect(seen.args).toEqual([]);
        expect(seen.prompt).toContain('<conversation_so_far>');
        expect(run.events[0]).toMatchObject({ type: 'log', level: 'warn' });
    });

    it('passes arguments through a wrapper script exactly, spaces and metacharacters too', async () => {
        const script = join(dir, 'echo-args.mjs');
        await writeFile(
            script,
            `process.stdin.resume();
process.stdin.on('end', () => {
    ${resultLine('JSON.stringify(process.argv.slice(2))')}
});`,
        );
        const command = `"${await wrapper(script)}" "a&b" "c d" "x|y>z" ^caret`;
        const { output } = await new CommandHarness(command).run(
            input({ session: { harness: 'command', sessionId: 'sess:1.2', usage: [] } }),
        );
        expect(JSON.parse(output!)).toEqual([
            'a&b',
            'c d',
            'x|y>z',
            '^caret',
            '--session',
            'sess:1.2',
        ]);
    });

    it.runIf(windows)('refuses arguments cmd.exe would expand for a .cmd agent', async () => {
        const command = `"${await wrapper(join(dir, 'unused.mjs'))}" "%USERPROFILE%"`;
        await expect(new CommandHarness(command).run(input())).rejects.toThrow('Cannot pass');
    });

    it('survives malformed output lines and keeps the last result', async () => {
        const run = input();
        const harness = new CommandHarness(
            await agent(`process.stdin.resume();
process.stdin.on('end', () => {
    for (const line of ['null', '{"type":"result"}', '{"type":"assistant","message":{}}', '{"type":"system","subtype":"init"}', '{"type":"result","subtype":"x"}', 'plain text'])
        console.log(line);
    ${resultLine("'fine'")}
});`),
        );
        expect(await harness.run(run)).toEqual({ output: 'fine' });
        expect(run.events.filter((e) => e.type === 'log' && e.level === 'warn').length).toBe(4);
        expect(run.events).toContainEqual({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'plain text' }],
        });
    });

    it('fails on an error result line', async () => {
        const harness = new CommandHarness(
            await agent(`process.stdin.resume();
process.stdin.on('end', () => console.log('{"type":"result","subtype":"error_max_turns","errors":["Too many turns"]}'));`),
        );
        await expect(harness.run(input())).rejects.toThrow('Too many turns');
    });

    it('copes with a command that exits without reading its prompt', async () => {
        const harness = new CommandHarness(await agent(resultLine("'early'")));
        const run = input({ prompt: 'x'.repeat(8 * 1024 * 1024) });
        expect(await harness.run(run)).toEqual({ output: 'early' });

        const silent = new CommandHarness(await agent(''));
        await expect(silent.run(input({ prompt: 'x'.repeat(8 * 1024 * 1024) }))).rejects.toThrow(
            'without reading its prompt',
        );
    });

    it('stops the whole process tree when the run is cancelled', async () => {
        const pidFile = join(dir, 'grandchild.pid');
        const script = join(dir, 'linger.mjs');
        await writeFile(
            script,
            `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`,
        );
        const stop = new AbortController();
        const running = new CommandHarness(`"${await wrapper(script)}"`).run(
            input({ signal: stop.signal }),
        );
        let pid = 0;
        for (let i = 0; i < 500 && !pid; i++) {
            pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
            if (!pid) await new Promise((r) => setTimeout(r, 20));
        }
        expect(pid).toBeGreaterThan(0);
        stop.abort('cancelled');
        await expect(running).rejects.toThrow('stopped');

        const alive = () => {
            try {
                process.kill(pid, 0);
                return true;
            } catch {
                return false;
            }
        };
        for (let i = 0; i < 250 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
        expect(alive()).toBe(false);
    }, 20_000);

    it('never starts a command for a run stopped before it began', async () => {
        const stopped = new AbortController();
        stopped.abort('cancelled');
        const marker = join(dir, 'started.txt');
        const harness = new CommandHarness(
            await agent(
                `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes');`,
            ),
        );
        await expect(harness.run(input({ signal: stopped.signal }))).rejects.toThrow(
            'stopped before the agent command started',
        );
        await expect(readFile(marker, 'utf8')).rejects.toThrow('ENOENT');
    });
});
