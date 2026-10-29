import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    key: () => null,
    length: 0,
});

const { claimPrompt, runMcpServers, toRunEvents } = await import('../src/lib/runner');
type Claim = Parameters<typeof claimPrompt>[0];

const claim = (patch: Partial<Claim> = {}): Claim => ({
    run: {
        id: 'r1',
        kind: 'chat',
        status: 'running',
        prompt: 'next?',
        conversationId: 'c1',
        automationRunId: null,
        budgetUsd: 5,
        output: null,
        error: null,
        createdAt: '',
        startedAt: null,
        finishedAt: null,
    },
    session: null,
    history: [],
    automation: null,
    agentToken: 'agent-token',
    ...patch,
});

describe('toRunEvents', () => {
    it('reports the session and assistant blocks', () => {
        expect(
            toRunEvents({ type: 'system', subtype: 'init', session_id: 's1' }, 'desktop-codex'),
        ).toContainEqual({ type: 'session', harness: 'desktop-codex', sessionId: 's1' });
        expect(
            toRunEvents(
                {
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'text', text: 'hi' },
                            { type: 'thinking', thinking: 'hm' },
                            { type: 'tool_use', id: 't', name: 'Bash', input: {} },
                            { type: 'tool_use', name: 'no id' },
                        ],
                    },
                },
                'x',
            ),
        ).toEqual([
            {
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'text', text: 'hi' },
                    { type: 'thinking', text: 'hm' },
                    { type: 'tool_use', id: 't', name: 'Bash', input: {} },
                ],
            },
        ]);
    });

    it('reports tool results and skips subagent lines', () => {
        expect(
            toRunEvents(
                {
                    type: 'user',
                    message: {
                        content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
                    },
                },
                'x',
            ),
        ).toEqual([
            {
                type: 'message',
                role: 'tool',
                content: [{ type: 'tool_result', toolUseId: 't', content: 'ok' }],
            },
        ]);
        expect(
            toRunEvents(
                { type: 'assistant', parent_tool_use_id: 'p', message: { content: [] } },
                'x',
            ),
        ).toEqual([]);
    });

    it('reports usage as what this run added to a resumed session', () => {
        const events = toRunEvents(
            {
                type: 'result',
                subtype: 'success',
                session_id: 's1',
                modelUsage: {
                    opus: { inputTokens: 150, outputTokens: 30, costUSD: 1.5 },
                },
            },
            'x',
            [
                {
                    model: 'opus',
                    inputTokens: 100,
                    outputTokens: 10,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    costUsd: 1,
                },
            ],
        );
        expect(events[0]).toMatchObject({
            type: 'usage',
            model: 'opus',
            inputTokens: 50,
            outputTokens: 20,
            costUsd: 0.5,
            sessionId: 's1',
        });
        expect(events[1]).toMatchObject({ type: 'log', level: 'info' });
    });
});

describe('claimPrompt', () => {
    it('replays earlier turns only for a fresh session', () => {
        const c = claim({
            history: [
                { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
            ],
        });
        expect(claimPrompt(c, true)).toBe('next?');
        expect(claimPrompt(c, false)).toBe(
            '<conversation_so_far>\nUser: hello\n\nAssistant: hi\n</conversation_so_far>\n\nnext?',
        );
        expect(claimPrompt(claim(), false)).toBe('next?');
    });
});

describe('runMcpServers', () => {
    it('puts the API tool server with the agent token first, then registered servers', () => {
        const servers = runMcpServers(
            {
                builtinServer: { name: 'lyfestyle', path: '/mcp' },
                mcpServers: [
                    { name: 'todo', transport: 'http', url: 'https://t/mcp', headers: {} },
                    { name: 'fs', transport: 'stdio', command: 'fs', args: ['-x'], env: {} },
                ],
            },
            'https://api.example/',
            'agent-token',
        );
        expect(Object.keys(servers)).toEqual(['lyfestyle', 'todo', 'fs']);
        expect(servers.lyfestyle).toEqual({
            type: 'http',
            url: 'https://api.example/mcp',
            headers: { Authorization: 'Bearer agent-token' },
        });
        expect(servers.fs).toEqual({ type: 'stdio', command: 'fs', args: ['-x'], env: {} });
    });
});
