import { Cron } from 'croner';
import { badRequest } from '../lib/errors.js';
import { isTimeZone } from '../lib/timezone.js';

/**
 * Parses a cron expression in `timezone`: five fields, six with seconds first, or a nickname such
 * as `@daily`. croner also takes a seventh (year) field, which the API does not promise. A bad
 * expression or zone is a 400.
 */
export function cron(schedule: string, timezone: string): Cron {
    if (!isTimeZone(timezone)) throw badRequest(`Unknown time zone: ${timezone}`);
    const fields = schedule.trim().split(/\s+/);
    if (!(fields.length === 1 && fields[0]?.startsWith('@')) && ![5, 6].includes(fields.length)) {
        throw badRequest(
            'Invalid cron schedule: use five fields (minute hour day month weekday), or six with seconds first',
        );
    }
    try {
        return new Cron(schedule, { timezone, paused: true });
    } catch (err) {
        throw badRequest(`Invalid cron schedule: ${(err as Error).message}`);
    }
}

/** For a new deploy: the schedule must parse and still have a slot after `from` (no 30 February). */
export function checkSchedule(schedule: string, timezone: string, from: Date) {
    if (!cron(schedule, timezone).nextRun(from)) {
        throw badRequest(`The schedule "${schedule}" never runs`);
    }
}

type Timing = { schedule: string; timezone: string; enabled: boolean };

export const nextRun = (timing: Timing, from: Date) =>
    timing.enabled ? cron(timing.schedule, timing.timezone).nextRun(from) : null;

/** Every slot in [from, to), capped so a every-second schedule cannot flood a response. */
export function slotsBetween(timing: Timing, from: Date, to: Date, cap = 300): Date[] {
    if (!timing.enabled) return [];
    const job = cron(timing.schedule, timing.timezone);
    const out: Date[] = [];
    // nextRun is exclusive of its argument, so step back a millisecond to include `from` itself.
    let at = job.nextRun(new Date(from.getTime() - 1));
    while (at && at < to && out.length < cap) {
        out.push(at);
        at = job.nextRun(at);
    }
    return out;
}
