import { describe, expect, it } from 'vitest';
import { axisTop, compactCount, dayKey, fillDays, siteLabel } from '../src/lib/metrics';

const day = (m: number, d: number) => new Date(2026, m - 1, d).getTime();

describe('dayKey', () => {
    it('writes a local midnight as the API day key', () => {
        expect(dayKey(day(3, 7))).toBe('2026-03-07');
        expect(dayKey(day(12, 31))).toBe('2026-12-31');
    });
});

describe('fillDays', () => {
    it('lists every day oldest first, with zeros where the API had none', () => {
        const days = fillDays(
            [
                { key: '2026-10-26', views: 5, visitors: 2 },
                { key: '2026-10-28', views: 9, visitors: 4 },
            ],
            day(10, 28),
            4,
        );
        expect(days).toEqual([
            { day: day(10, 25), views: 0, visitors: 0 },
            { day: day(10, 26), views: 5, visitors: 2 },
            { day: day(10, 27), views: 0, visitors: 0 },
            { day: day(10, 28), views: 9, visitors: 4 },
        ]);
    });

    it('steps by calendar day across a month end', () => {
        expect(fillDays([], day(11, 1), 2).map((d) => dayKey(d.day))).toEqual([
            '2026-10-31',
            '2026-11-01',
        ]);
    });
});

describe('axisTop', () => {
    it.each([
        [0, 1],
        [1, 1],
        [3, 5],
        [7, 10],
        [10, 10],
        [11, 20],
        [140, 200],
        [4_200, 5_000],
    ])('rounds %i up to %i', (max, top) => {
        expect(axisTop(max)).toBe(top);
    });
});

describe('compactCount', () => {
    it.each([
        [0, '0'],
        [980, '980'],
        [1_284, '1,284'],
        [12_900, '12.9k'],
        [40_000, '40k'],
        [4_200_000, '4.2m'],
    ])('reads %i as %s', (n, text) => {
        expect(compactCount(n)).toBe(text);
    });
});

describe('siteLabel', () => {
    it('drops https but keeps any other scheme', () => {
        expect(siteLabel('https://hunter.studio')).toBe('hunter.studio');
        expect(siteLabel('http://localhost:5173')).toBe('http://localhost:5173');
    });
});
