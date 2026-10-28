import { afterEach, describe, expect, it, vi } from 'vitest';
import { PURGE_EVERY_MS, startScheduler } from '../src/scheduler.js';
import type { Services } from '../src/services.js';

const TICK_MS = 15_000;

/** Just the services the scheduler calls, each recording that it ran. */
function fakeServices(start = new Date('2026-10-28T12:00:00.000Z')) {
    const clock = { at: start };
    const calls: string[] = [];
    const step = (name: string) =>
        vi.fn<(at: Date) => Promise<number>>(async () => {
            calls.push(name);
            return 0;
        });
    const fakes = {
        now: () => clock.at,
        automations: { recover: step('recover'), startDue: step('startDue') },
        runs: { reapStale: step('reapStale') },
        pages: { purgeTrash: step('purgeTrash') },
        metrics: { purgeExpired: step('purgeExpired') },
    };
    return { fakes, services: fakes as unknown as Services, calls, clock };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('scheduler', () => {
    it('runs every step even when one of them fails', async () => {
        const { fakes, services, calls } = fakeServices();
        fakes.automations.startDue.mockRejectedValueOnce(new Error('cron table broke'));
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await startScheduler(services, TICK_MS)();
        expect(calls).toEqual(['recover', 'reapStale', 'purgeTrash', 'purgeExpired']);
        expect(error).toHaveBeenCalledWith('Scheduler: startDue failed', expect.any(Error));
    });

    it('purges at most hourly and retries a failed recovery on the next tick', async () => {
        vi.useFakeTimers();
        const { fakes, services, clock } = fakeServices();
        fakes.automations.recover.mockRejectedValueOnce(new Error('database restarting'));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const tick = async (ms = TICK_MS) => {
            clock.at = new Date(clock.at.getTime() + ms);
            await vi.advanceTimersByTimeAsync(TICK_MS);
        };

        const stop = startScheduler(services, TICK_MS);
        await tick();
        await tick();
        expect(fakes.automations.recover).toHaveBeenCalledTimes(2);
        expect(fakes.automations.startDue).toHaveBeenCalledTimes(3);
        expect(fakes.pages.purgeTrash).toHaveBeenCalledTimes(1);

        await tick(PURGE_EVERY_MS);
        expect(fakes.pages.purgeTrash).toHaveBeenCalledTimes(2);
        expect(fakes.metrics.purgeExpired).toHaveBeenCalledTimes(2);
        expect(fakes.automations.recover).toHaveBeenCalledTimes(2);
        await stop();
    });

    it('stops only after the tick in flight has finished', async () => {
        const { fakes, services, calls } = fakeServices();
        let release = () => {};
        fakes.runs.reapStale.mockImplementationOnce(
            () => new Promise((resolve) => (release = () => resolve(0))),
        );

        const stop = startScheduler(services, TICK_MS);
        let stopped = false;
        const stopping = stop().then(() => (stopped = true));
        await new Promise((resolve) => setImmediate(resolve));
        expect(stopped).toBe(false);

        release();
        await stopping;
        expect(calls).toEqual(['recover', 'startDue', 'purgeTrash', 'purgeExpired']);
    });
});
