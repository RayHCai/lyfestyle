import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@lyfestyle/shared';
import type { ApiMessage } from '../src/lib/api';
import { mapTranscript } from '../src/lib/transcript';

let n = 0;
const msg = (role: ApiMessage['role'], runId: string | null, ...content: ContentBlock[]) => ({
    id: `m${++n}`,
    role,
    content,
    runId,
    createdAt: '2026-10-28T12:00:00.000Z',
});
const text = (t: string): ContentBlock => ({ type: 'text', text: t });

describe('mapTranscript', () => {
    it('folds one run into one assistant message, tool calls into its tool list', () => {
        const out = mapTranscript([
            msg('user', 'r1', text('plan my week')),
            msg('assistant', 'r1', text('Looking.'), {
                type: 'tool_use',
                id: 't1',
                name: 'pages_search',
                input: {},
            }),
            msg('tool', 'r1', { type: 'tool_result', toolUseId: 't1', content: '[]' }),
            msg('assistant', 'r1', text('Here it is.')),
        ]);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ role: 'user', content: 'plan my week', runId: 'r1' });
        expect(out[1]).toMatchObject({
            role: 'assistant',
            content: 'Looking.\n\nHere it is.',
            tools: ['pages_search'],
            runId: 'r1',
        });
    });

    it('keeps separate runs as separate replies', () => {
        const out = mapTranscript([
            msg('user', 'r1', text('a')),
            msg('assistant', 'r1', text('one')),
            msg('user', 'r2', text('b')),
            msg('assistant', 'r2', text('two')),
        ]);
        expect(out.map((m) => `${m.role}:${m.content}`)).toEqual([
            'user:a',
            'assistant:one',
            'user:b',
            'assistant:two',
        ]);
    });

    it('turns the result of an automations_deploy call into a deploy on the reply', () => {
        const out = mapTranscript([
            msg('user', 'r1', text('add the weather')),
            msg('assistant', 'r1', {
                type: 'tool_use',
                id: 'd',
                name: 'mcp__lyfestyle__automations_deploy',
                input: {},
            }),
            msg('tool', 'r1', {
                type: 'tool_result',
                toolUseId: 'd',
                content: JSON.stringify({ id: 'dep1', status: 'pending' }),
            }),
            msg('assistant', 'r1', text('Proposed.')),
        ]);
        expect(out[1]).toMatchObject({ content: 'Proposed.', deploys: ['dep1'] });
    });

    it('ignores failed or non-JSON deploy results and results of other tools', () => {
        const out = mapTranscript([
            msg('user', 'r1', text('go')),
            msg(
                'assistant',
                'r1',
                { type: 'tool_use', id: 'd', name: 'automations_deploy', input: {} },
                { type: 'tool_use', id: 'o', name: 'pages_get', input: {} },
            ),
            msg(
                'tool',
                'r1',
                { type: 'tool_result', toolUseId: 'd', content: 'bad schedule', isError: true },
                { type: 'tool_result', toolUseId: 'o', content: '{"id":"page"}' },
            ),
        ]);
        expect(out[1]?.deploys).toBeUndefined();
    });
});
