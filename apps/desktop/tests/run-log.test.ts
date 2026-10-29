import type { RunEvent } from '@lyfestyle/shared';
import { describe, expect, it } from 'vitest';
import { eventLines } from '../src/lib/run-log';

const at = '2026-10-29T07:00:00.000Z';
const base = { runId: 'r1', createdAt: at };

describe('eventLines', () => {
    it('shows text and tool calls, one line per block, and skips thinking', () => {
        const event: RunEvent = {
            ...base,
            id: 4,
            type: 'message',
            role: 'assistant',
            content: [
                { type: 'thinking', text: 'hmm' },
                { type: 'text', text: 'Checking your inbox' },
                { type: 'tool_use', id: 't1', name: 'mcp__lyfestyle__todos_list', input: {} },
                { type: 'text', text: '  ' },
            ],
        };
        expect(eventLines(event)).toEqual([
            { key: '4:1', at, kind: 'text', text: 'Checking your inbox' },
            { key: '4:2', at, kind: 'tool', text: '→ mcp__lyfestyle__todos_list {}' },
        ]);
    });

    it('clips long tool results and marks failed ones', () => {
        const [line] = eventLines({
            ...base,
            id: 5,
            type: 'message',
            role: 'tool',
            content: [
                { type: 'tool_result', toolUseId: 't1', content: 'x'.repeat(1000), isError: true },
            ],
        });
        expect(line?.kind).toBe('error');
        expect(line?.text).toHaveLength(2 + 400 + 1);
    });

    it('shows logs, status changes and spend, and nothing for a session', () => {
        expect(
            [
                { ...base, id: 1, type: 'status', status: 'running' },
                { ...base, id: 2, type: 'log', level: 'warn', message: 'Stopped: over budget' },
                {
                    ...base,
                    id: 3,
                    type: 'usage',
                    model: 'claude-opus-5-5',
                    inputTokens: 10,
                    outputTokens: 5,
                    cacheReadTokens: 80,
                    cacheWriteTokens: 10,
                    costUsd: 0.25,
                },
                { ...base, id: 6, type: 'session', harness: 'claude-code', sessionId: 's' },
                { ...base, id: 7, type: 'status', status: 'failed', error: 'budget' },
            ]
                .flatMap((e) => eventLines(e as RunEvent))
                .map((l) => [l.kind, l.text]),
        ).toEqual([
            ['status', 'running'],
            ['warn', 'Stopped: over budget'],
            ['usage', 'claude-opus-5-5 · 100 in · 5 out · $0.25'],
            ['status', 'failed: budget'],
        ]);
    });
});
