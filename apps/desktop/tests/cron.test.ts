import { describe, expect, it } from 'vitest';
import { describeCron } from '../src/lib/cron';

describe('describeCron', () => {
    it.each([
        ['* * * * *', 'every minute'],
        ['*/15 * * * *', 'every 15 min'],
        ['30 * * * *', 'hourly at :30'],
        ['0 */2 * * *', 'every 2 h at :00'],
        ['0 7 * * *', 'daily at 07:00'],
        ['0 8,20 * * *', 'daily at 08:00, 20:00'],
        ['0 7 * * 1-5', 'weekdays at 07:00'],
        ['0 6 * * 6,0', 'weekends at 06:00'],
        ['0 18 * * 0', 'sun at 18:00'],
        ['5 9 * * 1,3', 'mon, wed at 09:05'],
        ['0 9 1 * *', 'monthly on the 1st at 09:00'],
        ['0 9 2 * *', 'monthly on the 2nd at 09:00'],
        ['0 9 11 * *', 'monthly on the 11th at 09:00'],
        ['0 9 23 * *', 'monthly on the 23rd at 09:00'],
    ])('reads %s as "%s"', (expr, words) => {
        expect(describeCron(expr)).toBe(words);
    });

    it('ignores a fixed seconds field', () => {
        expect(describeCron('0 0 7 * * *')).toBe('daily at 07:00');
    });

    it.each(['0 9 * 1 *', '0 9 1 * 1', '*/5 9-17 * * *', 'nonsense', '0 7 * * 9'])(
        'leaves %s as written',
        (expr) => {
            expect(describeCron(expr)).toBe(expr);
        },
    );
});
