import { retryableStatus, trimTrailingSlashes } from './http.js';
import { TERMINAL_RUN_STATUSES, type RunEvent } from './run-events.js';

/** A failed `GET /runs/:id/stream` response, when the caller supplies no error of its own. */
export class StreamHttpError extends Error {
    constructor(
        readonly status: number,
        readonly body: string,
    ) {
        super(body || `HTTP ${status}`);
        this.name = 'StreamHttpError';
    }
}

export interface RunStreamOptions {
    baseUrl: string;
    token: string;
    runId: string;
    /** Resume after this event id instead of replaying the run from the start. */
    after?: number;
    signal?: AbortSignal;
    /** Failed attempts in a row to retry; any event received resets the count. Default 5. */
    retries?: number;
    /** Wait between attempts, in ms. Default 1000. */
    retryDelayMs?: number;
    fetch?: typeof fetch;
    /** Turns an error response into the error to throw; defaults to `StreamHttpError`. */
    toError?: (response: Response) => Promise<Error>;
}

/** Splits an SSE byte stream into `{ event, data }` frames. */
export async function* sseFrames(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
                const lines = buffer.slice(0, end).split('\n');
                buffer = buffer.slice(end + 2);
                const field = (name: string) =>
                    lines
                        .filter((l) => l.startsWith(`${name}:`))
                        .map((l) => l.slice(name.length + 1).replace(/^ /, ''));
                yield { event: field('event')[0] ?? 'message', data: field('data').join('\n') };
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Every event of a run as it happens, from `GET /runs/:id/stream`. Uses `fetch` rather than
 * `EventSource` so it can send the bearer token. A dropped connection, a stream that closes before
 * the run finishes, or a 5xx (an API redeploy) reconnects after the last event seen; a 4xx throws
 * at once. Ends after the run's terminal status event.
 */
export async function* streamRunEvents(options: RunStreamOptions): AsyncGenerator<RunEvent> {
    const send = options.fetch ?? fetch;
    const base = trimTrailingSlashes(options.baseUrl);
    const toError =
        options.toError ??
        (async (r: Response) => new StreamHttpError(r.status, await r.text().catch(() => '')));
    const { signal } = options;
    const allowed = options.retries ?? 5;
    let left = allowed;
    let after = options.after ?? 0;

    for (;;) {
        let failure: unknown;
        try {
            const response = await send(`${base}/runs/${options.runId}/stream?after=${after}`, {
                headers: { authorization: `Bearer ${options.token}`, accept: 'text/event-stream' },
                ...(signal ? { signal } : {}),
            });
            if (!response.ok || !response.body) {
                const error = await toError(response);
                if (!retryableStatus(response.status))
                    throw Object.assign(error, { [FATAL]: true });
                failure = error;
            } else {
                for await (const frame of sseFrames(response.body)) {
                    if (frame.event === 'ping' || !frame.data) continue;
                    const event = JSON.parse(frame.data) as RunEvent;
                    after = event.id;
                    left = allowed;
                    yield event;
                    if (event.type === 'status' && TERMINAL_RUN_STATUSES.includes(event.status))
                        return;
                }
                failure = new Error('The run event stream closed before the run finished');
            }
        } catch (err) {
            if (signal?.aborted || (err instanceof Error && FATAL in err)) throw err;
            failure = err;
        }
        if (left-- <= 0) throw failure;
        await delay(options.retryDelayMs ?? 1_000, signal);
    }
}

const FATAL = Symbol('fatal');

function delay(ms: number, signal: AbortSignal | undefined) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
    });
}
