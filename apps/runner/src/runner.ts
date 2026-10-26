import { ApiRequestError, unwrap, type ApiClient } from '@lyfestyle/client';
import type { RunEventInput } from '@lyfestyle/shared';
import type { Harness, HarnessInput, McpServerSpec } from './harness.js';

export interface RunnerOptions {
    api: ApiClient;
    harness: Harness;
    runnerId: string;
    /** Where the harness reaches the API's own MCP server, and the token it sends there. */
    apiUrl: string;
    apiToken: string;
    concurrency?: number;
    waitMs?: number;
    heartbeatMs?: number;
    flushMs?: number;
    log?: (message: string, data?: unknown) => void;
}

type Claimed = Awaited<ReturnType<Runner['claim']>>;

const SHUTDOWN = 'shutdown';
const CANCELLED = 'cancelled';

/** Buffers a run's events and posts them in batches, noticing when the API wants the run stopped. */
class Reporter {
    #buffer: RunEventInput[] = [];
    #sending: Promise<void> = Promise.resolve();
    #timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly api: ApiClient,
        private readonly runId: string,
        private readonly flushMs: number,
        private readonly onStop: () => void,
    ) {}

    push(event: RunEventInput) {
        this.#buffer.push(event);
        this.#timer ??= setTimeout(() => void this.flush().catch(() => {}), this.flushMs);
    }

    flush(): Promise<void> {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        const events = this.#buffer.splice(0);
        if (!events.length) return this.#sending;
        this.#sending = this.#sending.then(async () => {
            for (let i = 0; i < events.length; i += 200) {
                const res = await this.api.runs[':id'].events.$post({
                    param: { id: this.runId },
                    json: { events: events.slice(i, i + 200) },
                });
                if (res.status === 409) return this.onStop();
                if (!res.ok) throw await ApiRequestError.from(res);
                if ((await res.json()).cancelRequested) this.onStop();
            }
        });
        return this.#sending;
    }
}

/** Claims queued runs from the API and executes them through a harness. */
export class Runner {
    readonly #o: Required<Omit<RunnerOptions, 'log'>> & Pick<RunnerOptions, 'log'>;
    readonly #active = new Map<string, AbortController>();
    readonly #polling = new AbortController();
    #loops: Promise<void>[] = [];

    constructor(options: RunnerOptions) {
        this.#o = { concurrency: 1, waitMs: 25_000, heartbeatMs: 15_000, flushMs: 250, ...options };
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
                await new Promise((resolve) => setTimeout(resolve, backoff));
                backoff = Math.min(backoff * 2, 60_000);
            }
        }
    }

    async claim(waitMs: number) {
        const res = await this.#o.api.runs.claim.$post(
            { json: { runnerId: this.#o.runnerId, harness: this.#o.harness.name, waitMs } },
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
        await this.execute(claimed!);
        return true;
    }

    async execute(claimed: NonNullable<Claimed>) {
        const { api, harness } = this.#o;
        const { run } = claimed;
        const abort = new AbortController();
        this.#active.set(run.id, abort);
        const stop = () => abort.abort(CANCELLED);
        const reporter = new Reporter(api, run.id, this.#o.flushMs, stop);
        const heartbeat = setInterval(async () => {
            try {
                const beat = await unwrap(
                    api.runs[':id'].heartbeat.$post({ param: { id: run.id } }),
                );
                if (beat.cancelRequested) stop();
            } catch (err) {
                this.#o.log?.('Heartbeat failed', String(err));
            }
        }, this.#o.heartbeatMs);
        this.#o.log?.(`Running ${run.kind} run ${run.id}`);

        let outcome: {
            status: 'succeeded' | 'failed' | 'cancelled';
            output?: string;
            error?: string;
        };
        try {
            const input: HarnessInput = {
                runId: run.id,
                kind: run.kind,
                prompt: run.prompt,
                session: claimed.session,
                history: claimed.history,
                job: claimed.job,
                mcpServers: await this.#mcpServers(),
                signal: abort.signal,
                emit: (event) => reporter.push(event),
            };
            const result = await harness.run(input);
            outcome = abort.signal.aborted
                ? this.#aborted(abort.signal.reason)
                : { status: 'succeeded', ...(result.output ? { output: result.output } : {}) };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            outcome = abort.signal.aborted
                ? this.#aborted(abort.signal.reason)
                : { status: 'failed', error: message };
            if (!abort.signal.aborted) reporter.push({ type: 'log', level: 'error', message });
        } finally {
            clearInterval(heartbeat);
            this.#active.delete(run.id);
        }

        try {
            await reporter.flush();
        } catch (err) {
            this.#o.log?.('Could not report final events', String(err));
        }
        const done = await api.runs[':id'].complete.$post({ param: { id: run.id }, json: outcome });
        if (!done.ok && done.status !== 409) throw await ApiRequestError.from(done);
        this.#o.log?.(`Run ${run.id} ${outcome.status}`);
    }

    #aborted(reason: unknown) {
        return reason === SHUTDOWN
            ? ({ status: 'failed', error: 'Runner shut down mid-run' } as const)
            : ({ status: 'cancelled' } as const);
    }

    async #mcpServers(): Promise<McpServerSpec[]> {
        const config = await unwrap(this.#o.api.agent.config.$get());
        const builtin: McpServerSpec = {
            name: config.builtinServer.name,
            transport: 'http',
            url: `${this.#o.apiUrl.replace(/\/+$/, '')}${config.builtinServer.path}`,
            headers: { Authorization: `Bearer ${this.#o.apiToken}` },
        };
        return [builtin, ...(config.mcpServers as McpServerSpec[])];
    }
}
