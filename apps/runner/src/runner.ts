import { ApiRequestError, unwrap, type ApiClient } from '@lyfestyle/client';
import {
    retryableStatus,
    runEventInput,
    trimTrailingSlashes,
    type RunEventInput,
    type RunKind,
} from '@lyfestyle/shared';
import type { Harness, HarnessInput, McpServerSpec } from './harness.js';

export interface RunnerOptions {
    api: ApiClient;
    harness: Harness;
    runnerId: string;
    /** Where the harness reaches the API's own MCP server. */
    apiUrl: string;
    concurrency?: number;
    /** Claim only runs of these kinds; every kind when omitted. */
    kinds?: RunKind[] | undefined;
    waitMs?: number;
    heartbeatMs?: number;
    flushMs?: number;
    /** First wait before retrying a failed report or completion; it doubles up to 30 s. */
    retryMs?: number;
    /** Longest one run may take before it is stopped and failed (RUN_TIMEOUT_MINUTES). */
    runTimeoutMs?: number;
    /** Longest a finished run waits for its last events to reach the API before completing. */
    flushTimeoutMs?: number;
    /** Longest to keep retrying a run's completion. */
    completeTimeoutMs?: number;
    log?: (message: string, data?: unknown) => void;
    /** Loads the user's SOUL.md for each run; none when omitted. */
    soul?: () => Promise<string>;
}

type Claimed = Awaited<ReturnType<Runner['claim']>>;
type Log = RunnerOptions['log'];

/** Why a run's signal was aborted. */
const SHUTDOWN = 'shutdown';
const CANCELLED = 'cancelled';
const TIMED_OUT = 'timed out';
/** The API answered 404: the run, or the conversation it belonged to, was deleted. */
const DELETED = 'deleted';

const BATCH_SIZE = 200;
const MAX_RETRY_MS = 30_000;
/** How long a harness gets to wind down after its signal aborts before the runner moves on. */
const STOP_GRACE_MS = 15_000;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

/**
 * Buffers a run's events and posts them in order, 200 per request. A failed post keeps its events
 * at the front of the buffer and is retried with backoff for as long as the run lasts; an invalid
 * event is dropped on the way in, since one would fail its whole batch.
 */
class Reporter {
    #buffer: RunEventInput[] = [];
    #timer: ReturnType<typeof setTimeout> | undefined;
    #sending: Promise<void> | null = null;
    /** Set once nothing more will be sent: the API refused the run, or the reporter gave up. */
    #closed = false;
    readonly #giveUp = new AbortController();

    constructor(
        private readonly o: {
            api: ApiClient;
            runId: string;
            flushMs: number;
            retryMs: number;
            onStop: (reason: string) => void;
            log: Log;
        },
    ) {}

    get pending() {
        return this.#buffer.length;
    }

    push(event: RunEventInput) {
        const parsed = runEventInput.safeParse(event);
        if (!parsed.success) {
            this.o.log?.(`Dropped an invalid ${String(event.type)} event`, parsed.error.message);
            return;
        }
        if (this.#closed) return;
        this.#buffer.push(parsed.data);
        this.#timer ??= setTimeout(() => void this.#send(), this.o.flushMs);
    }

    /** Waits for everything buffered to be delivered, giving up after `timeoutMs`; true if it was. */
    async flush(timeoutMs: number): Promise<boolean> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
        });
        const drained = (async () => {
            while (this.#buffer.length && !this.#closed) await this.#send();
            return true as const;
        })();
        const done = await Promise.race([drained, expired]);
        clearTimeout(timer);
        if (!done) this.close();
        return done && !this.#buffer.length;
    }

    /** Stops sending; a retry waiting on its backoff ends at once. */
    close() {
        this.#closed = true;
        clearTimeout(this.#timer);
        this.#giveUp.abort();
    }

    #send(): Promise<void> {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#sending ??= this.#deliver().finally(() => {
            this.#sending = null;
            // Events pushed while the last request was settling still need a send.
            if (this.#buffer.length && !this.#closed)
                this.#timer ??= setTimeout(() => void this.#send(), this.o.flushMs);
        });
        return this.#sending;
    }

    async #deliver() {
        let wait = this.o.retryMs;
        while (this.#buffer.length && !this.#closed) {
            const batch = this.#buffer.slice(0, BATCH_SIZE);
            let failure: unknown;
            try {
                const res = await this.o.api.runs[':id'].events.$post({
                    param: { id: this.o.runId },
                    json: { events: batch },
                });
                if (res.status === 404 || res.status === 409) {
                    // Deleted, or no longer running (cancelled, or reaped as stale): stop the agent.
                    this.close();
                    this.#buffer = [];
                    return this.o.onStop(res.status === 404 ? DELETED : CANCELLED);
                }
                if (res.ok) {
                    this.#buffer.splice(0, batch.length);
                    wait = this.o.retryMs;
                    if ((await res.json()).cancelRequested) this.o.onStop(CANCELLED);
                    continue;
                }
                failure = await ApiRequestError.from(res);
                if (!retryableStatus(res.status)) {
                    // Retrying a refused batch would hold back every event after it.
                    this.o.log?.(
                        `The API refused ${batch.length} events; dropping them`,
                        String(failure),
                    );
                    this.#buffer.splice(0, batch.length);
                    continue;
                }
            } catch (err) {
                failure = err;
            }
            if (this.#closed) return;
            this.o.log?.(`Could not report events, retrying in ${wait / 1000}s`, String(failure));
            await sleep(wait, this.#giveUp.signal);
            wait = Math.min(wait * 2, MAX_RETRY_MS);
        }
    }
}

/**
 * Settles with the harness, or rejects once the run has been stopped for `graceMs` and the harness
 * still has not: a harness that ignores its signal must not hold the runner forever.
 */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            timer = setTimeout(() => reject(new Error('The harness did not stop')), graceMs);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        work.then(resolve, reject).finally(() => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        });
    });
}

type Outcome = {
    status: 'succeeded' | 'failed' | 'cancelled';
    output?: string;
    error?: string;
};

/** Claims queued runs from the API and executes them through a harness. */
export class Runner {
    readonly #o: Required<Omit<RunnerOptions, 'log' | 'soul' | 'kinds'>> &
        Pick<RunnerOptions, 'log' | 'soul' | 'kinds'>;
    readonly #active = new Map<string, AbortController>();
    readonly #polling = new AbortController();
    #loops: Promise<void>[] = [];

    constructor(options: RunnerOptions) {
        this.#o = {
            concurrency: 1,
            waitMs: 25_000,
            heartbeatMs: 15_000,
            flushMs: 250,
            retryMs: 1_000,
            runTimeoutMs: 30 * 60_000,
            flushTimeoutMs: 30_000,
            completeTimeoutMs: 60_000,
            ...options,
        };
    }

    start() {
        for (let i = 0; i < this.#o.concurrency; i++) this.#loops.push(this.#loop());
    }

    /** Stops claiming, aborts runs in flight, and waits for them to report. */
    async stop() {
        this.#polling.abort();
        for (const run of this.#active.values()) run.abort(SHUTDOWN);
        await Promise.all(this.#loops);
    }

    async #loop() {
        let backoff = 1_000;
        while (!this.#polling.signal.aborted) {
            try {
                await this.runOnce();
                backoff = 1_000;
            } catch (err) {
                if (this.#polling.signal.aborted) return;
                this.#o.log?.(`Runner error, retrying in ${backoff / 1000}s`, String(err));
                await sleep(backoff, this.#polling.signal);
                backoff = Math.min(backoff * 2, 60_000);
            }
        }
    }

    async claim(waitMs: number) {
        const res = await this.#o.api.runs.claim.$post(
            {
                json: {
                    runnerId: this.#o.runnerId,
                    harness: this.#o.harness.name,
                    waitMs,
                    ...(this.#o.kinds ? { kinds: this.#o.kinds } : {}),
                },
            },
            { init: { signal: this.#polling.signal } },
        );
        if (res.status === 204) return null;
        if (!res.ok) throw await ApiRequestError.from(res);
        return res.json();
    }

    /** Claims and executes one run; resolves false when nothing was queued within `waitMs`. */
    async runOnce(waitMs = this.#o.waitMs): Promise<boolean> {
        const claimed = await this.claim(waitMs);
        if (!claimed) return false;
        await this.execute(claimed);
        return true;
    }

    async execute(claimed: NonNullable<Claimed>) {
        const { api, harness, log } = this.#o;
        const { run } = claimed;
        const abort = new AbortController();
        this.#active.set(run.id, abort);
        // The first reason wins; aborting an aborted controller does nothing.
        const stop = (reason: string) => abort.abort(reason);
        const reporter = new Reporter({
            api,
            runId: run.id,
            flushMs: this.#o.flushMs,
            retryMs: this.#o.retryMs,
            onStop: stop,
            log,
        });
        const heartbeat = setInterval(
            () => void this.#heartbeat(run.id, stop),
            this.#o.heartbeatMs,
        );
        const timeout = setTimeout(() => stop(TIMED_OUT), this.#o.runTimeoutMs);
        log?.(`Running ${run.kind} run ${run.id}`);

        let outcome: Outcome;
        try {
            if (!claimed.agentToken) throw new Error('The API sent no agent token; update the API');
            const input: HarnessInput = {
                runId: run.id,
                kind: run.kind,
                prompt: run.prompt,
                session: claimed.session,
                history: claimed.history,
                automation: claimed.automation,
                soul: (await this.#o.soul?.()) ?? '',
                budgetUsd: run.budgetUsd,
                mcpServers: await this.#mcpServers(claimed.agentToken),
                signal: abort.signal,
                emit: (event) => reporter.push(event),
            };
            if (abort.signal.aborted) throw new Error('Run stopped before it started');
            const result = await untilStopped(harness.run(input), abort.signal, STOP_GRACE_MS);
            // A harness that finished with output finished the run, even if a stop raced it.
            outcome =
                abort.signal.aborted && result.output === null
                    ? this.#aborted(abort.signal.reason)
                    : { status: 'succeeded', ...(result.output ? { output: result.output } : {}) };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            outcome = abort.signal.aborted
                ? this.#aborted(abort.signal.reason)
                : { status: 'failed', error: message };
        } finally {
            clearInterval(heartbeat);
            clearTimeout(timeout);
            this.#active.delete(run.id);
        }

        if (abort.signal.reason === DELETED) {
            reporter.close();
            log?.(`Run ${run.id} was deleted; dropped it`);
            return;
        }
        if (outcome.status === 'failed' && outcome.error)
            reporter.push({ type: 'log', level: 'error', message: outcome.error });
        if (!(await reporter.flush(this.#o.flushTimeoutMs)))
            log?.(`Could not report the last ${reporter.pending} events of run ${run.id}`);
        await this.#complete(run.id, outcome);
        log?.(`Run ${run.id} ${outcome.status}`);
    }

    #aborted(reason: unknown): Outcome {
        if (reason === SHUTDOWN) return { status: 'failed', error: 'Runner shut down mid-run' };
        if (reason === TIMED_OUT) {
            const minutes = Math.round((this.#o.runTimeoutMs / 60_000) * 100) / 100;
            return {
                status: 'failed',
                error: `Stopped after ${minutes} minutes, the runner's time limit (RUN_TIMEOUT_MINUTES)`,
            };
        }
        return { status: 'cancelled' };
    }

    async #heartbeat(runId: string, stop: (reason: string) => void) {
        try {
            const res = await this.#o.api.runs[':id'].heartbeat.$post({ param: { id: runId } });
            if (res.status === 404) return stop(DELETED);
            if (!res.ok) throw await ApiRequestError.from(res);
            if ((await res.json()).cancelRequested) stop(CANCELLED);
        } catch (err) {
            this.#o.log?.('Heartbeat failed', String(err));
        }
    }

    /** Records the outcome, retrying through a brief outage so a finished run is not lost. */
    async #complete(runId: string, outcome: Outcome) {
        const deadline = Date.now() + this.#o.completeTimeoutMs;
        let wait = this.#o.retryMs;
        for (;;) {
            let failure: unknown;
            try {
                const res = await this.#o.api.runs[':id'].complete.$post({
                    param: { id: runId },
                    json: outcome,
                });
                // 409: the API already finished it (a cancel, the stale-run reaper); 404: deleted.
                if (res.ok || res.status === 409 || res.status === 404) return;
                failure = await ApiRequestError.from(res);
                if (!retryableStatus(res.status)) throw failure;
            } catch (err) {
                if (err === failure) throw err;
                failure = err;
            }
            if (Date.now() + wait > deadline) throw failure;
            this.#o.log?.(
                `Could not complete run ${runId}, retrying in ${wait / 1000}s`,
                String(failure),
            );
            await sleep(wait);
            wait = Math.min(wait * 2, MAX_RETRY_MS);
        }
    }

    async #mcpServers(agentToken: string): Promise<McpServerSpec[]> {
        const config = await unwrap(this.#o.api.agent.config.$get());
        const builtin: McpServerSpec = {
            name: config.builtinServer.name,
            transport: 'http',
            url: `${trimTrailingSlashes(this.#o.apiUrl)}${config.builtinServer.path}`,
            // The run's own scoped token: the runner's API token never reaches the agent.
            headers: { Authorization: `Bearer ${agentToken}` },
        };
        return [builtin, ...(config.mcpServers as McpServerSpec[])];
    }
}
