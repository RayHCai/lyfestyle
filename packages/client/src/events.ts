import { TERMINAL_RUN_STATUSES, type RunEvent } from '@lyfestyle/shared';
import { ApiRequestError, type ClientOptions } from './client.js';

export interface StreamOptions extends ClientOptions {
    runId: string;
    /** Resume after this event id instead of replaying the run from the start. */
    after?: number;
    signal?: AbortSignal;
    /** How many dropped connections to retry before giving up. */
    retries?: number;
}

/** Splits an SSE byte stream into `{ event, data }` frames. */
async function* frames(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
}

/**
 * Every event of a run as it happens, from `GET /runs/:id/stream`. Uses `fetch` rather than
 * `EventSource` so it can send the bearer token, and reconnects from the last event it saw.
 * Ends after the run's terminal status event.
 */
export async function* streamRunEvents(options: StreamOptions): AsyncGenerator<RunEvent> {
    const send = options.fetch ?? fetch;
    const base = options.baseUrl.replace(/\/+$/, '');
    let after = options.after ?? 0;
    let retries = options.retries ?? 5;

    for (;;) {
        try {
            const response = await send(`${base}/runs/${options.runId}/stream?after=${after}`, {
                headers: { authorization: `Bearer ${options.token}`, accept: 'text/event-stream' },
                ...(options.signal ? { signal: options.signal } : {}),
            });
            if (!response.ok || !response.body) throw await ApiRequestError.from(response);
            for await (const frame of frames(response.body)) {
                if (frame.event === 'ping' || !frame.data) continue;
                const event = JSON.parse(frame.data) as RunEvent;
                after = event.id;
                yield event;
                if (event.type === 'status' && TERMINAL_RUN_STATUSES.includes(event.status)) return;
            }
        } catch (err) {
            if (options.signal?.aborted || err instanceof ApiRequestError || retries-- <= 0)
                throw err;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
    }
}
