import { describe, expect, it } from 'vitest';
import { StreamHttpError, streamRunEvents, type RunEvent } from '../src/index.js';

const event = (id: number, extra: Partial<RunEvent> = {}) =>
    ({
        id,
        runId: 'r',
        createdAt: '2026-10-28T00:00:00.000Z',
        type: 'log',
        level: 'info',
        message: `e${id}`,
        ...extra,
    }) as RunEvent;

const sse = (...events: RunEvent[]) =>
    new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
    });

/** A fetch that answers each attempt from `replies` in turn and records the URLs it was given. */
function scripted(replies: (() => Response | Promise<Response>)[]) {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
        urls.push(url);
        const next = replies.shift();
        if (!next) throw new Error('no more replies');
        return next();
    }) as unknown as typeof globalThis.fetch;
    return { fetch, urls };
}

const options = { baseUrl: 'http://api.test/', token: 't', runId: 'r', retryDelayMs: 0 };

async function collect(stream: AsyncGenerator<RunEvent>) {
    const out: number[] = [];
    for await (const e of stream) out.push(e.id);
    return out;
}

describe('streamRunEvents', () => {
    it('resumes after the last event when the stream closes before the run ends', async () => {
        const { fetch, urls } = scripted([
            () => sse(event(1), event(2)),
            () => sse(event(3, { type: 'status', status: 'succeeded' })),
        ]);
        expect(await collect(streamRunEvents({ ...options, fetch }))).toEqual([1, 2, 3]);
        expect(urls).toEqual([
            'http://api.test/runs/r/stream?after=0',
            'http://api.test/runs/r/stream?after=2',
        ]);
    });

    it('retries a 5xx, which is what an API redeploy looks like', async () => {
        const { fetch } = scripted([
            () => new Response('down', { status: 502 }),
            () => sse(event(1, { type: 'status', status: 'failed' })),
        ]);
        expect(await collect(streamRunEvents({ ...options, fetch }))).toEqual([1]);
    });

    it('throws a 4xx at once', async () => {
        const { fetch, urls } = scripted([() => new Response('nope', { status: 404 })]);
        await expect(collect(streamRunEvents({ ...options, fetch }))).rejects.toBeInstanceOf(
            StreamHttpError,
        );
        expect(urls).toHaveLength(1);
    });

    it('gives up after the retries run out, but any progress resets the count', async () => {
        // Two progress-making closes in a row would exhaust `retries: 1` without the reset.
        const { fetch } = scripted([
            () => sse(event(1)),
            () => sse(event(2)),
            () => sse(),
            () => sse(),
        ]);
        await expect(collect(streamRunEvents({ ...options, fetch, retries: 1 }))).rejects.toThrow(
            'closed before the run finished',
        );
    });
});
