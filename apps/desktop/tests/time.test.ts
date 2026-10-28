import { describe, expect, it } from 'vitest';
import {
    addDays,
    agoLabel,
    clock,
    cost,
    duration,
    relativeTime,
    startOfDay,
    when,
} from '../src/lib/time';

const now = new Date(2026, 9, 28, 14, 30).getTime();
const ago = (ms: number) => now - ms;

describe('relativeTime', () => {
    it.each([
        [ago(10_000), 'now'],
        [ago(5 * 60_000), '5m'],
        [ago(3 * 3_600_000), '3h'],
        [ago(2 * 86_400_000), '2d'],
    ])('reads %i as %s', (ts, label) => {
        expect(relativeTime(ts, now)).toBe(label);
    });

    it('falls back to the date after a week', () => {
        expect(relativeTime(ago(10 * 86_400_000), now)).toMatch(/18/);
    });

    it('never goes negative for a time ahead of now', () => {
        expect(relativeTime(now + 60_000, now)).toBe('now');
    });
});

describe('agoLabel', () => {
    it('words the relative time', () => {
        expect(agoLabel(ago(1000), now)).toBe('just now');
        expect(agoLabel(ago(5 * 60_000), now)).toBe('5m ago');
        expect(agoLabel(ago(10 * 86_400_000), now)).toMatch(/^on /);
    });
});

describe('days', () => {
    it('steps calendar days from midnight', () => {
        const day = startOfDay(now);
        expect(new Date(day).getHours()).toBe(0);
        expect(new Date(addDays(day, 1)).getDate()).toBe(29);
        expect(new Date(addDays(day, -28)).getMonth()).toBe(8);
        expect(startOfDay(addDays(day, 1))).toBe(addDays(day, 1));
    });

    it('shows a time today, and the weekday too for any other day', () => {
        const today = new Date(2026, 9, 28, 9, 5).toISOString();
        const tomorrow = new Date(2026, 9, 29, 9, 5).toISOString();
        expect(when(today, now)).toBe(clock(today));
        expect(when(tomorrow, now)).toBe(
            `${new Date(tomorrow).toLocaleDateString(undefined, { weekday: 'short' }).toLowerCase()} ${clock(tomorrow)}`,
        );
    });
});

describe('duration and cost', () => {
    it.each([
        [0, '0s'],
        [42_400, '42s'],
        [185_000, '3m 5s'],
        [4_800_000, '1h 20m'],
        [-5, '0s'],
    ])('reads %i ms as %s', (ms, label) => {
        expect(duration(ms)).toBe(label);
    });

    it('rounds small costs up to a floor', () => {
        expect(cost(0)).toBe('$0');
        expect(cost(0.004)).toBe('<$0.01');
        expect(cost(0.426)).toBe('$0.43');
    });
});
