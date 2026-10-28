import { describe, expect, it } from 'vitest';
import { parseCursors } from '../src/lib/notifications';
import { dropDoc, parseConversation, parseIndex, parseSettings, putDoc } from '../src/lib/stored';
import { defaultSettings } from '../src/lib/types';

describe('parseSettings', () => {
    it('fills every field from the defaults', () => {
        expect(parseSettings(null)).toEqual(defaultSettings);
        expect(parseSettings('nope')).toEqual(defaultSettings);
    });

    it('keeps string fields and replaces null or mistyped ones', () => {
        const s = parseSettings({ name: 'Hunter', todoMcpUrl: null, model: 4, extra: 'x' });
        expect(s.name).toBe('Hunter');
        expect(s.todoMcpUrl).toBe('');
        expect(s.model).toBe('');
        expect(s).not.toHaveProperty('extra');
    });
});

describe('parseConversation', () => {
    it('rejects what is not a conversation', () => {
        expect(parseConversation(null)).toBeNull();
        expect(parseConversation({ title: 'no id' })).toBeNull();
    });

    it('survives missing or broken messages', () => {
        const c = parseConversation({
            id: 'c1',
            title: 'Trip',
            messages: [
                { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
                { id: 'm2', role: 'robot', content: 'x' },
                null,
                { id: 'm3', role: 'assistant', content: 7, tools: ['a', 1] },
            ],
        });
        expect(c?.messages.map((m) => [m.id, m.content])).toEqual([
            ['m1', 'hi'],
            ['m3', ''],
        ]);
        expect(c?.messages[1]?.tools).toEqual(['a']);
        expect(c?.streaming).toBe(false);
        expect(parseConversation({ id: 'c2' })?.messages).toEqual([]);
    });
});

describe('documents/index.json', () => {
    const a = { id: 'a', title: 'A', createdAt: 1, updatedAt: 10 };
    const b = { id: 'b', title: 'B', createdAt: 2, updatedAt: 20 };

    it('reads a missing or empty file as no documents', () => {
        expect(parseIndex(null)).toEqual([]);
        expect(parseIndex('  ')).toEqual([]);
    });

    it('treats a file that does not parse as an error, not as an empty list', () => {
        expect(() => parseIndex('[{"id": "a",')).toThrow(/not valid JSON/);
        expect(() => parseIndex('{"id": "a"}')).toThrow(/not a list/);
    });

    it('sorts newest first, drops entries without an id and keeps unknown fields', () => {
        const list = parseIndex(
            JSON.stringify([a, 'junk', { title: 'no id' }, { ...b, icon: '*' }]),
        );
        expect(list.map((d) => d.id)).toEqual(['b', 'a']);
        expect(list[0]).toHaveProperty('icon', '*');
    });

    it('applies one change to the list on disk, keeping entries it did not know', () => {
        // `b` was added on disk by the agent's tool server; the app only knew `a`.
        const disk = [b, a];
        expect(putDoc(disk, { ...a, title: 'A2', updatedAt: 30 }).map((d) => d.title)).toEqual([
            'A2',
            'B',
        ]);
        expect(dropDoc(disk, 'a')).toEqual([b]);
    });
});

describe('notification cursors', () => {
    it('reads cursors by API URL, and the older single-server form', () => {
        expect(parseCursors({ 'https://a': 4, 'https://b': 9, bad: 'x' })).toEqual({
            'https://a': 4,
            'https://b': 9,
        });
        expect(parseCursors({ url: 'https://a', after: 3 })).toEqual({ 'https://a': 3 });
        expect(parseCursors(null)).toEqual({});
    });
});
