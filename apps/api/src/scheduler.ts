import type { Services } from './services.js';

/** The purges scan whole tables (the trash under the page write lock), so not every tick. */
export const PURGE_EVERY_MS = 60 * 60 * 1000;

/**
 * Every `tickMs`: starts due automations and reaps runs whose runner went quiet; at most hourly,
 * empties expired trash and page views. The first tick first fails automation runs an earlier
 * process left unfinished. Returns a stop function that resolves once any tick in flight ends.
 */
export function startScheduler(services: Services, tickMs: number): () => Promise<void> {
    let recovered = false;
    let purgedAt = -Infinity;
    let inFlight: Promise<void> | null = null;

    /** One failing step is logged and skipped, so it cannot hold up the others on every tick. */
    async function step(name: string, work: () => Promise<unknown>): Promise<boolean> {
        try {
            await work();
            return true;
        } catch (err) {
            console.error(`Scheduler: ${name} failed`, err);
            return false;
        }
    }

    async function tick() {
        const at = services.now();
        if (!recovered) recovered = await step('recover', () => services.automations.recover(at));
        await step('startDue', () => services.automations.startDue(at));
        await step('reapStale', () => services.runs.reapStale(at));
        if (at.getTime() - purgedAt >= PURGE_EVERY_MS) {
            purgedAt = at.getTime();
            await step('purgeTrash', () => services.pages.purgeTrash(at));
            await step('purgeExpired', () => services.metrics.purgeExpired(at));
        }
    }

    const run = () => {
        // A tick that outlasts the interval is not overlapped by the next one.
        inFlight ??= tick().finally(() => {
            inFlight = null;
        });
        return inFlight;
    };

    const timer = setInterval(run, tickMs);
    timer.unref();
    void run();
    return async () => {
        clearInterval(timer);
        await inFlight;
    };
}
