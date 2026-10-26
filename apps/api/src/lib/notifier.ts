import { EventEmitter } from 'node:events';

/** In-process pub/sub: the API runs as one instance, so wakeups need no broker. */
export class Notifier {
    readonly #emitter = new EventEmitter().setMaxListeners(0);

    emit(topic: string, payload?: unknown): void {
        this.#emitter.emit(topic, payload);
    }

    on(topic: string, listener: (payload: unknown) => void): () => void {
        this.#emitter.on(topic, listener);
        return () => this.#emitter.off(topic, listener);
    }

    /** Resolves true when `topic` fires, false on timeout or abort. */
    wait(topic: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            if (signal?.aborted) return resolve(false);
            const finish = (fired: boolean) => {
                clearTimeout(timer);
                off();
                signal?.removeEventListener('abort', onAbort);
                resolve(fired);
            };
            const onAbort = () => finish(false);
            const off = this.on(topic, () => finish(true));
            const timer = setTimeout(() => finish(false), timeoutMs);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
}

export const topics = {
    runQueued: 'runs:queued',
    run: (id: string) => `run:${id}`,
} as const;
