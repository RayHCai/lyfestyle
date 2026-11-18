import { describe, expect, it } from 'vitest';
import {
    DENIED,
    answer,
    clearAgent,
    decision,
    describeInput,
    handleControl,
    pendingFor,
    readControl,
} from '../src/lib/permissions';

const ask = (requestId: string, request: Record<string, unknown> = {}) => ({
    type: 'control_request',
    request_id: requestId,
    request: {
        subtype: 'can_use_tool',
        tool_name: 'Edit',
        input: { file_path: 'C:\\Users\\me\\settings.json', old_string: 'a', new_string: 'b' },
        ...request,
    },
});

describe('readControl', () => {
    it('reads a can_use_tool request', () => {
        expect(
            readControl(
                ask('r1', {
                    decision_reason: { type: 'workingDir', reason: 'Outside the folder' },
                }),
            ),
        ).toEqual({
            kind: 'request',
            request: {
                requestId: 'r1',
                tool: 'Edit',
                input: {
                    file_path: 'C:\\Users\\me\\settings.json',
                    old_string: 'a',
                    new_string: 'b',
                },
                reason: 'Outside the folder',
            },
        });
        expect(readControl(ask('r2', { title: 'Edit settings.json', input: 'bad' }))).toEqual({
            kind: 'request',
            request: { requestId: 'r2', tool: 'Edit', input: {}, title: 'Edit settings.json' },
        });
    });

    it('reads a cancel and flags requests the app cannot answer', () => {
        expect(readControl({ type: 'control_cancel_request', request_id: 'r1' })).toEqual({
            kind: 'cancel',
            requestId: 'r1',
        });
        expect(
            readControl({
                type: 'control_request',
                request_id: 'r3',
                request: { subtype: 'hook' },
            }),
        ).toEqual({ kind: 'unsupported', requestId: 'r3', subtype: 'hook' });
    });

    it('ignores every other line', () => {
        expect(readControl({ type: 'assistant', message: {} })).toBeNull();
        expect(readControl({ type: 'control_request', request: {} })).toBeNull();
        expect(readControl({ type: 'control_cancel_request' })).toBeNull();
    });
});

describe('describeInput', () => {
    it('picks the field that says what the call does', () => {
        expect(describeInput({ command: 'git push', description: 'push' })).toBe('git push');
        expect(describeInput({ file_path: '/a', content: 'x' })).toBe('/a');
        expect(describeInput({ query: 'x' })).toBe('{\n  "query": "x"\n}');
        expect(describeInput({})).toBe('');
    });
});

describe('the pending list', () => {
    it('keeps requests per conversation until answered, withdrawn or the agent exits', async () => {
        expect(handleControl('run-1', 'c1', ask('r1'))?.kind).toBe('request');
        expect(handleControl('run-1', 'c1', ask('r2'))?.kind).toBe('request');
        expect(handleControl('local', 'c2', ask('r1'))?.kind).toBe('request');
        expect(handleControl('local', 'c2', { type: 'assistant' })).toBeNull();
        expect(pendingFor('c1').map((r) => r.requestId)).toEqual(['r1', 'r2']);

        const [first] = pendingFor('c1');
        if (!first) throw new Error('missing request');
        expect(first).toMatchObject({ agent: 'run-1', conversationId: 'c1', tool: 'Edit' });
        await answer(first, true);
        expect(pendingFor('c1').map((r) => r.requestId)).toEqual(['r2']);

        handleControl('run-1', 'c1', { type: 'control_cancel_request', request_id: 'r2' });
        expect(pendingFor('c1')).toEqual([]);

        clearAgent('local');
        expect(pendingFor('c2')).toEqual([]);
    });
});

describe('decision', () => {
    it('allows with the input as asked, or denies with a reason for the agent', () => {
        handleControl('a', 'c9', ask('r9'));
        const [r] = pendingFor('c9');
        if (!r) throw new Error('missing request');
        expect(decision(r, true)).toEqual({ behavior: 'allow', updatedInput: r.input });
        expect(decision(r, false)).toEqual({ behavior: 'deny', message: DENIED });
        clearAgent('a');
    });
});
