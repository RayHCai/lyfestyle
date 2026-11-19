import { describe, expect, it } from 'vitest';
import { LIST, MOBILE_CAPABLE, filterDocs, readEntry, writeEntry } from '../src/lib/mobile';

describe('readEntry', () => {
    it('round-trips what writeEntry stores', () => {
        const doc = { route: { name: 'doc', id: 'a1', edit: true }, depth: 2 } as const;
        expect(readEntry(writeEntry(doc))).toEqual(doc);
        const trash = { route: { name: 'trash' }, depth: 1 } as const;
        expect(readEntry(writeEntry(trash))).toEqual(trash);
    });

    it('starts at the list for a fresh load or state the app did not write', () => {
        for (const state of [null, undefined, 'x', 3, {}, { other: 1 }, { lyfestyleMobile: 'x' }])
            expect(readEntry(state)).toEqual({ route: LIST, depth: 0 });
    });

    it('repairs a malformed entry instead of trusting it', () => {
        const read = (entry: unknown) => readEntry({ lyfestyleMobile: entry });
        expect(read({ route: { name: 'doc' }, depth: 1 })).toEqual({ route: LIST, depth: 1 });
        expect(read({ route: { name: 'doc', id: '' }, depth: 1 }).route).toEqual(LIST);
        expect(read({ route: { name: 'doc', id: 'a', edit: 'yes' } }).route).toEqual({
            name: 'doc',
            id: 'a',
            edit: false,
        });
        expect(read({ route: { name: 'settings' }, depth: -4 })).toEqual({ route: LIST, depth: 0 });
        expect(read({ route: LIST, depth: 1.5 }).depth).toBe(0);
    });
});

describe('filterDocs', () => {
    const docs = [{ title: 'Weekly review' }, { title: 'Reading list' }, { title: '' }];

    it('keeps everything for an empty query', () => {
        expect(filterDocs(docs, '  ')).toBe(docs);
    });

    it('matches every word, in any order and case', () => {
        expect(filterDocs(docs, 'REVIEW week')).toEqual([{ title: 'Weekly review' }]);
        expect(filterDocs(docs, 'list weekly')).toEqual([]);
    });

    it('matches an untitled document by the name it shows', () => {
        expect(filterDocs(docs, 'untitled')).toEqual([{ title: '' }]);
    });
});

it('is off outside the web build and screenshot mode', () => {
    expect(MOBILE_CAPABLE).toBe(false);
});
