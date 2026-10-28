import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/lib/diff';

const show = (before: string, after: string) =>
    diffLines(before, after)?.map((l) => l.kind + l.text);

describe('diffLines', () => {
    it('keeps equal lines and marks the changed one', () => {
        expect(show('a\nb\nc\n', 'a\nB\nc\n')).toEqual([' a', '+B', '-b', ' c']);
    });

    it('marks added and removed lines at either end', () => {
        expect(show('a\nb', 'b\nc')).toEqual(['-a', ' b', '+c']);
    });

    it('treats a trailing newline as no extra line', () => {
        expect(show('a\n', 'a')).toEqual([' a']);
    });

    it('rebuilds the new text from kept and added lines', () => {
        const before = 'one\ntwo\nthree\nfour';
        const after = 'zero\none\nthree\nfour\nfive';
        const lines = diffLines(before, after) ?? [];
        const kept = (kind: string) =>
            lines
                .filter((l) => l.kind !== kind)
                .map((l) => l.text)
                .join('\n');
        expect(kept('-')).toBe(after);
        expect(kept('+')).toBe(before);
    });

    it('gives up on inputs too big to compare', () => {
        const big = Array.from({ length: 1001 }, (_, i) => String(i)).join('\n');
        expect(diffLines(big, big + '\nx')).toBeNull();
    });
});
