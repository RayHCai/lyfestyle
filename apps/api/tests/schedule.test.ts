import { describe, expect, it } from 'vitest';
import { checkSchedule, cron, nextRun, slotsBetween } from '../src/automations/schedule.js';

const daily = (schedule: string, timezone = 'UTC') => ({ schedule, timezone, enabled: true });

describe('schedules', () => {
    it('takes five or six fields, or a nickname', () => {
        for (const schedule of ['0 7 * * 1-5', '30 0 7 * * *', '@daily']) {
            expect(() => cron(schedule, 'UTC')).not.toThrow();
        }
        expect(() => cron('0 0 7 * * * 2030', 'UTC')).toThrow('five fields');
        expect(() => cron('* * * *', 'UTC')).toThrow('five fields');
        expect(() => cron('0 7 * * *', 'Mars/Olympus')).toThrow('Unknown time zone');
    });

    it('refuses a schedule with no next run', () => {
        const from = new Date('2026-10-28T00:00:00Z');
        expect(() => checkSchedule('0 0 30 2 *', 'UTC', from)).toThrow('never runs');
        expect(() => checkSchedule('0 0 29 2 *', 'UTC', from)).not.toThrow();
    });

    it('has no next run while paused', () => {
        const from = new Date('2026-10-28T00:00:00Z');
        expect(nextRun({ ...daily('0 7 * * *'), enabled: false }, from)).toBeNull();
        expect(nextRun(daily('0 7 * * *'), from)).toEqual(new Date('2026-10-28T07:00:00Z'));
    });

    it('caps the slots of a busy schedule', () => {
        const from = new Date('2026-10-28T00:00:00Z');
        const to = new Date('2026-10-28T01:00:00Z');
        expect(slotsBetween(daily('* * * * * *'), from, to)).toHaveLength(300);
        expect(slotsBetween(daily('*/10 * * * *'), from, to, 4)).toHaveLength(4);
        expect(slotsBetween(daily('0 * * * *'), from, to)).toEqual([from]);
    });

    it('fires once at a wall-clock time the fall-back repeats', () => {
        // 2026-11-01 01:30 happens twice in New York: in EDT, then again in EST.
        const slots = slotsBetween(
            daily('30 1 * * *', 'America/New_York'),
            new Date('2026-10-31T12:00:00Z'),
            new Date('2026-11-02T12:00:00Z'),
        );
        expect(slots.map((d) => d.toISOString())).toEqual([
            '2026-11-01T05:30:00.000Z',
            '2026-11-02T06:30:00.000Z',
        ]);
    });
});
