import { describe, expect, it } from 'vitest';
import {
    addDays,
    extractPageLinks,
    isoDate,
    monthStart,
    pageLink,
    weekStart,
} from '../src/index.js';

const A = '0b7e8a4e-6a47-4c39-9d0e-2f3c1a7b5e11';
const B = '7f1d2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b';

describe('extractPageLinks', () => {
    it('finds page links, dedupes them and ignores other links', () => {
        const md = `See [Alpha](page:${A}) and [beta](page:${B.toUpperCase()}).\n[Alpha again](page:${A}) [web](https://example.com)`;
        expect(extractPageLinks(md)).toEqual([A, B]);
    });

    it('round-trips with pageLink', () => {
        expect(extractPageLinks(pageLink(A, 'Has [brackets]'))).toEqual([A]);
    });
});

describe('dates', () => {
    it('finds the Sunday that starts the week', () => {
        expect(weekStart('2026-10-26')).toBe('2026-10-25');
        expect(weekStart('2026-10-25')).toBe('2026-10-25');
        expect(weekStart('2026-11-01')).toBe('2026-11-01');
    });

    it('crosses month and year boundaries', () => {
        expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
        expect(monthStart('2026-02-17')).toBe('2026-02-01');
    });

    it('rejects impossible days', () => {
        expect(isoDate.safeParse('2026-02-30').success).toBe(false);
        expect(isoDate.safeParse('2026-02-28').success).toBe(true);
    });
});
