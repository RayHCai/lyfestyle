import { describe, expect, it } from 'vitest';
import {
    addBlocks,
    appendStderr,
    joinText,
    patchLast,
    readBlocks,
    settle,
    stderrTail,
    turnMessages,
} from '../src/lib/turn';
import type { Conversation, Message } from '../src/lib/types';

const reply = (patch: Partial<Message> = {}): Message => ({
    id: 'r',
    role: 'assistant',
    content: '',
    createdAt: 1,
    ...patch,
});

describe('turn messages', () => {
    it('creates the user message and an empty reply after it', () => {
        const [user, answer] = turnMessages('hi', 100);
        expect(user).toMatchObject({ role: 'user', content: 'hi', createdAt: 100 });
        expect(answer).toMatchObject({ role: 'assistant', content: '', live: '', createdAt: 101 });
        expect(user.id).not.toBe(answer.id);
    });
});

describe('folding output', () => {
    it('joins text blocks as paragraphs', () => {
        expect(joinText('', 'a')).toBe('a');
        expect(joinText('a', 'b')).toBe('a\n\nb');
        expect(joinText('a\n\n', 'b')).toBe('a\n\nb');
        expect(joinText('a', '')).toBe('a');
    });

    it('reads text and tool names from blocks of either harness', () => {
        expect(
            readBlocks([
                { type: 'text', text: 'one' },
                { type: 'tool_use', name: 'pages_get' },
                { type: 'thinking', text: 'hidden' },
                { type: 'text', text: 'two' },
            ]),
        ).toEqual({ text: 'one\n\ntwo', tools: ['pages_get'] });
    });

    it('adds a finished message to the reply and drops the partial text', () => {
        const m = addBlocks(reply({ content: 'first', tools: ['a'], live: 'fir' }), [
            { type: 'tool_use', name: 'b' },
            { type: 'text', text: 'second' },
        ]);
        expect(m).toMatchObject({ content: 'first\n\nsecond', tools: ['a', 'b'], live: '' });
    });

    it('keeps the last 4000 characters of stderr', () => {
        const long = appendStderr('x'.repeat(3999), 'tail');
        expect(long).toHaveLength(4000);
        expect(long.endsWith('tail\n')).toBe(true);
        expect(stderrTail('a\nb\nc\nd\n')).toBe('b\nc\nd');
    });
});

describe('settle', () => {
    const empty = (tail: string) => `nothing${tail ? ': ' + tail : ''}`;

    it('merges the streamed text and trims it', () => {
        const m = settle(reply({ content: 'Hello', live: ' world \n' }), '', undefined, empty);
        expect(m).toMatchObject({ content: 'Hello world', live: undefined, error: undefined });
    });

    it('explains an empty reply from the stderr tail', () => {
        expect(settle(reply(), 'boom\n', undefined, empty).error).toBe('nothing: boom');
    });

    it('prefers the given error, then the one already on the reply', () => {
        expect(settle(reply({ error: 'old' }), '', 'new', empty).error).toBe('new');
        expect(settle(reply({ error: 'old' }), '', undefined, empty).error).toBe('old');
        expect(settle(reply({ content: 'ok' }), 'noise', undefined, empty).error).toBeUndefined();
    });
});

describe('patchLast', () => {
    const conv = (messages: Message[]): Conversation => ({
        id: 'c',
        title: 't',
        createdAt: 0,
        updatedAt: 0,
        messages,
    });

    it('patches a reply at the end of the thread', () => {
        const c = patchLast(conv([reply()]), (m) => ({ ...m, content: 'x' }));
        expect(c.messages[0]?.content).toBe('x');
        expect(c.updatedAt).toBeGreaterThan(0);
    });

    it('leaves a thread that ends with the user alone', () => {
        const c = conv([{ id: 'u', role: 'user', content: 'q', createdAt: 0 }]);
        expect(patchLast(c, (m) => ({ ...m, content: 'x' }))).toBe(c);
    });
});
