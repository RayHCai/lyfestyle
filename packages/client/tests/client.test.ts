import { createTestContext, TEST_TOKEN, TEST_URL, type TestContext } from '@lyfestyle/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiRequestError, createApiClient, streamRunEvents, unwrap } from '../src/index.js';

let t: TestContext;
beforeAll(async () => {
    t = await createTestContext();
});
afterAll(() => t.close());

const options = () => ({ baseUrl: TEST_URL, token: TEST_TOKEN, fetch: t.fetch });

describe('typed client', () => {
    it('reaches every route group with types', async () => {
        const api = createApiClient(options());
        const page = await unwrap(api.pages.$post({ json: { title: 'Typed' } }));
        expect(page.version).toBe(1);
        const got = await unwrap(api.pages[':id'].$get({ param: { id: page.id } }));
        expect(got.title).toBe('Typed');
        const board = await unwrap(api.todos.board.$get({ query: { today: '2026-10-26' } }));
        expect(board.day).toEqual([]);
        const status = await unwrap(api.integrations.$get());
        expect(status.canvas.connected).toBe(false);
    });

    it('throws the API error as ApiRequestError', async () => {
        const api = createApiClient(options());
        const err = await unwrap(
            api.pages[':id'].$get({ param: { id: crypto.randomUUID() } }),
        ).catch((e) => e);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect(err).toMatchObject({ status: 404, code: 'not_found' });
    });
});

describe('run streams', () => {
    it('follows a run to its end', async () => {
        const convo = (await t.call('POST', '/conversations', {})).body;
        const run = (await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'hi' }))
            .body.run;
        const seen: string[] = [];
        const following = (async () => {
            for await (const event of streamRunEvents({ ...options(), runId: run.id }))
                seen.push(event.type);
        })();

        await t.call('POST', '/runs/claim', { runnerId: 'r', harness: 'fake' });
        await t.call('POST', `/runs/${run.id}/events`, {
            events: [
                { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            ],
        });
        await t.call('POST', `/runs/${run.id}/complete`, { status: 'succeeded' });
        await following;
        expect(seen).toEqual(['status', 'status', 'message', 'status']);
    });

    it('throws an unknown run as ApiRequestError without retrying', async () => {
        const stream = streamRunEvents({ ...options(), runId: crypto.randomUUID() });
        const err = await stream.next().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect(err).toMatchObject({ status: 404, code: 'not_found' });
    });
});
