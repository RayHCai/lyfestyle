import type { Services } from '../services.js';

/** Queues due jobs and reaps runs whose runner went quiet, every `tickMs`. Returns a stop function. */
export function startScheduler(services: Services, tickMs: number): () => void {
    let busy = false;
    const tick = async () => {
        if (busy) return;
        busy = true;
        try {
            const at = services.now();
            await services.jobs.enqueueDue(at);
            await services.runs.reapStale(at);
        } catch (err) {
            console.error('Scheduler tick failed', err);
        } finally {
            busy = false;
        }
    };
    const timer = setInterval(tick, tickMs);
    timer.unref();
    void tick();
    return () => clearInterval(timer);
}
