import { describe, expect, it } from 'vitest';
import { slashOptions } from '../src/lib/commands';

const skills = [
    { name: 'review', description: 'Review the branch' },
    { name: 'research', description: 'Look something up' },
];
const labels = (value: string) => slashOptions(value, skills).map((o) => o.label);

describe('slashOptions', () => {
    it('lists app commands, then skills, for a bare slash', () => {
        expect(labels('/')).toEqual(['/harness', '/model', '/effort', '/review', '/research']);
    });

    it('narrows by the typed prefix, ignoring case', () => {
        expect(labels('/RE')).toEqual(['/review', '/research']);
        expect(labels('/mo')).toEqual(['/model']);
    });

    it('inserts the name and a space, ready for arguments', () => {
        expect(slashOptions('/rev', skills)[0]?.insert).toBe('/review ');
    });

    it('offers argument values after /model and /effort', () => {
        expect(labels('/model ')).toEqual(['default', 'opus', 'sonnet', 'haiku']);
        expect(labels('/effort h')).toEqual(['high']);
        expect(slashOptions('/effort h', skills)[0]?.insert).toBe('/effort high');
    });

    it('offers nothing for plain text, skill arguments or unknown commands', () => {
        expect(labels('hello')).toEqual([]);
        expect(labels('/review this branch')).toEqual([]);
        expect(labels('/zzz')).toEqual([]);
    });
});

describe('/harness', () => {
    it('offers the harness ids as arguments', () => {
        expect(labels('/harness ')).toEqual(['claude-code', 'codex', 'command']);
        expect(labels('/harness co')).toEqual(['codex', 'command']);
    });
});
