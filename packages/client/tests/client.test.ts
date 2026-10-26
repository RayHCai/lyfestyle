import { createTestContext, TEST_TOKEN, TEST_URL, type TestContext } from '@lyfestyle/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ApiRequestError,
    createApiClient,
    MemoryStore,
    streamRunEvents,
    SyncEngine,
    unwrap,
    type ConflictResolver,
} from '../src/index.js';

let t: TestContext;
beforeAll(async () => {
    t = await createTestContext();
});
afterAll(() => t.close());

const options = () => ({ baseUrl: TEST_URL, token: TEST_TOKEN, fetch: t.fetch });

function device(resolve?: ConflictResolver, fetch = t.fetch) {
    const store = new MemoryStore();
    const api = createApiClient({ ...options(), fetch });
    return { store, engine: new SyncEngine({ api, store, ...(resolve ? { resolve } : {}) }) };
}

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

describe('sync engine', () => {
    it('carries a page written offline to another device', async () => {
        const laptop = device();
        const phone = device();
        const page = await laptop.engine.save({ title: 'Plane notes', content: 'offline' });
        expect(page).toMatchObject({ dirty: true, baseVersion: null });

        expect(await laptop.engine.sync()).toMatchObject({ pushed: 1, conflicts: 0 });
        expect(await laptop.store.get(page.id)).toMatchObject({ dirty: false, baseVersion: 1 });

        await phone.engine.sync();
        expect(await phone.store.get(page.id)).toMatchObject({
            title: 'Plane notes',
            dirty: false,
        });
    });

    it('pulls edits the agent made on the server', async () => {
        const laptop = device();
        const page = await laptop.engine.save({ title: 'Agent target' });
        await laptop.engine.sync();
        await t.call('POST', `/pages/${page.id}/append`, { content: 'added by the agent' });
        await laptop.engine.sync();
        expect(await laptop.store.get(page.id)).toMatchObject({
            content: 'added by the agent',
            baseVersion: 2,
        });
    });

    it('keeps both copies when two devices edit the same page offline', async () => {
        const laptop = device();
        const phone = device();
        const page = await laptop.engine.save({ title: 'Shared', content: 'v1' });
        await laptop.engine.sync();
        await phone.engine.sync();

        await laptop.engine.save({ id: page.id, content: 'laptop edit' });
        await phone.engine.save({ id: page.id, content: 'phone edit' });
        await laptop.engine.sync();
        const report = await phone.engine.sync();
        expect(report.conflicts).toBe(1);

        const phonePages = await phone.store.all();
        expect(phonePages.find((p) => p.id === page.id)).toMatchObject({
            content: 'laptop edit',
            dirty: false,
        });
        const copy = phonePages.find((p) => p.title === 'Shared (conflicted copy)');
        expect(copy).toMatchObject({ content: 'phone edit', dirty: false });

        await laptop.engine.sync();
        expect((await laptop.store.all()).some((p) => p.id === copy!.id)).toBe(true);
    });

    it('lets a resolver keep the local edit', async () => {
        const laptop = device();
        const phone = device(() => ({ keep: 'local' }));
        const page = await laptop.engine.save({ title: 'Mine wins', content: 'v1' });
        await laptop.engine.sync();
        await phone.engine.sync();
        await laptop.engine.save({ id: page.id, content: 'laptop' });
        await phone.engine.save({ id: page.id, content: 'phone' });
        await laptop.engine.sync();
        await phone.engine.sync();
        const server = (await t.call('GET', `/pages/${page.id}`)).body;
        expect(server).toMatchObject({ content: 'phone', version: 3 });
        expect(await phone.store.get(page.id)).toMatchObject({ dirty: false, baseVersion: 3 });
    });

    it('keeps an edit made while its push was in flight', async () => {
        let edit: (() => Promise<unknown>) | undefined;
        const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const res = await t.fetch(input, init);
            if (
                String(input instanceof Request ? input.url : input).includes('/sync/push') &&
                edit
            ) {
                await edit();
                edit = undefined;
            }
            return res;
        }) as typeof fetch;
        const laptop = device(undefined, slow);
        const page = await laptop.engine.save({ title: 'Racing', content: 'first' });
        edit = () => laptop.engine.save({ id: page.id, content: 'second' });
        await laptop.engine.sync();

        expect((await t.call('GET', `/pages/${page.id}`)).body.content).toBe('second');
        expect(await laptop.store.get(page.id)).toMatchObject({
            content: 'second',
            dirty: false,
            baseVersion: 2,
        });
    });

    it('propagates deletions', async () => {
        const laptop = device();
        const phone = device();
        const page = await laptop.engine.save({ title: 'Doomed' });
        await laptop.engine.sync();
        await phone.engine.sync();
        await laptop.engine.remove(page.id);
        await laptop.engine.sync();
        await phone.engine.sync();
        expect(await phone.store.get(page.id)).toMatchObject({ deleted: true, dirty: false });
    });

    it('shares one round between overlapping sync calls', async () => {
        const laptop = device();
        await laptop.engine.save({ title: 'Once' });
        const [a, b] = await Promise.all([laptop.engine.sync(), laptop.engine.sync()]);
        expect(a).toBe(b);
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
});
