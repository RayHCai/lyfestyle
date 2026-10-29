import { describe, expect, it } from 'vitest';
import { activeHarness, fromCodex, harnessCommand, harnessProblem } from '../src/lib/harness';
import { defaultSettings, type AgentEnv } from '../src/lib/types';

const env: AgentEnv = {
    harness: null,
    apiUrl: null,
    apiToken: null,
    harnesses: [
        { id: 'claude-code', path: 'C:\\npm\\claude.cmd' },
        { id: 'codex', path: null },
    ],
};

describe('harness settings', () => {
    it('defaults to Claude Code, also for an unknown stored value', () => {
        expect(activeHarness(defaultSettings)).toBe('claude-code');
        expect(activeHarness({ ...defaultSettings, harness: 'gemini' })).toBe('claude-code');
        expect(activeHarness({ ...defaultSettings, harness: 'codex' })).toBe('codex');
    });

    it('uses the typed command, else what was detected on PATH', () => {
        expect(harnessCommand('claude-code', defaultSettings, env)).toBe('C:\\npm\\claude.cmd');
        const typed = { ...defaultSettings, agentCommand: ' D:\\claude.exe ' };
        expect(harnessCommand('claude-code', typed, env)).toBe('D:\\claude.exe');
    });

    it('says why a harness cannot run', () => {
        expect(harnessProblem('claude-code', defaultSettings, env)).toBeNull();
        expect(harnessProblem('codex', defaultSettings, env)).toBe('not found on PATH');
        expect(harnessProblem('command', defaultSettings, env)).toBe('no custom command set');
        expect(
            harnessProblem('codex', { ...defaultSettings, codexCommand: 'codex' }, env),
        ).toBeNull();
    });
});

describe('fromCodex', () => {
    it('leaves Claude Code lines alone', () => {
        expect(fromCodex({ type: 'assistant', message: { content: [] } }, 'm')).toBeNull();
        expect(fromCodex({ type: 'result', subtype: 'success' }, 'm')).toBeNull();
    });

    it('turns a thread into a session and a message into assistant text', () => {
        expect(fromCodex({ type: 'thread.started', thread_id: 't1' }, 'gpt')).toEqual([
            { type: 'system', subtype: 'init', session_id: 't1', model: 'gpt' },
        ]);
        expect(
            fromCodex(
                { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'hi' } },
                'gpt',
            ),
        ).toEqual([{ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }]);
        expect(fromCodex({ type: 'item.started', item: {} }, 'gpt')).toEqual([]);
    });

    it('turns tool items into a tool use and its result', () => {
        const lines = fromCodex(
            {
                type: 'item.completed',
                item: {
                    id: 'i1',
                    type: 'mcp_tool_call',
                    server: 'lyfestyle',
                    tool: 'pages_list',
                    arguments: { q: 'x' },
                    result: { items: [] },
                    status: 'completed',
                },
            },
            'gpt',
        );
        expect(lines).toEqual([
            {
                type: 'assistant',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            id: 'i1',
                            name: 'mcp__lyfestyle__pages_list',
                            input: { q: 'x' },
                        },
                    ],
                },
            },
            {
                type: 'user',
                message: {
                    content: [{ type: 'tool_result', tool_use_id: 'i1', content: '{"items":[]}' }],
                },
            },
        ]);
        const failed = fromCodex(
            {
                type: 'item.completed',
                item: { id: 'i2', type: 'command_execution', command: 'ls', exit_code: 1 },
            },
            'gpt',
        );
        expect(JSON.stringify(failed)).toContain('"is_error":true');
    });

    it('ends the turn with a result carrying usage, or the error', () => {
        const [done] = fromCodex(
            {
                type: 'turn.completed',
                usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 },
            },
            'gpt',
        )!;
        expect(done).toMatchObject({
            type: 'result',
            subtype: 'success',
            modelUsage: { gpt: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 4 } },
        });
        const [failed] = fromCodex({ type: 'turn.failed', error: { message: 'quota' } }, 'gpt')!;
        expect(failed).toMatchObject({ type: 'result', is_error: true, result: 'quota' });
    });
});
