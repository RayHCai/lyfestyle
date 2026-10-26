import { pageLink } from '@lyfestyle/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../src/testing.js';

let t: TestContext;
beforeAll(async () => {
    t = await createTestContext();
});
afterAll(() => t.close());

async function createPage(body: Record<string, unknown>) {
    const res = await t.call('POST', '/pages', body);
    expect(res.status).toBe(201);
    return res.body;
}

describe('auth', () => {
    it('rejects requests without the bearer token', async () => {
        const res = await t.app.request('/pages');
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('unauthorized');
    });

    it('leaves the health check open', async () => {
        expect((await t.app.request('/health')).status).toBe(200);
    });
});

describe('pages', () => {
    it('creates, reads, updates and versions a page', async () => {
        const page = await createPage({ title: 'Reading list', content: '# Books', icon: '📚' });
        expect(page).toMatchObject({ title: 'Reading list', version: 1, deletedAt: null });

        const updated = await t.call('PATCH', `/pages/${page.id}`, {
            content: '# Books\n\n- Dune',
            baseVersion: 1,
        });
        expect(updated.body).toMatchObject({ version: 2, content: '# Books\n\n- Dune' });

        const unchanged = await t.call('PATCH', `/pages/${page.id}`, { title: 'Reading list' });
        expect(unchanged.body.version).toBe(2);

        const got = await t.call('GET', `/pages/${page.id}`);
        expect(got.body).toMatchObject({ id: page.id, icon: '📚', version: 2 });
    });

    it('rejects a stale baseVersion with the current page', async () => {
        const page = await createPage({ title: 'Stale' });
        await t.call('PATCH', `/pages/${page.id}`, { content: 'one' });
        const res = await t.call('PATCH', `/pages/${page.id}`, { content: 'two', baseVersion: 1 });
        expect(res.status).toBe(409);
        expect(res.body.error.details.page).toMatchObject({ version: 2, content: 'one' });
    });

    it('accepts a client-chosen id once', async () => {
        const id = crypto.randomUUID();
        expect((await t.call('POST', '/pages', { id, title: 'Mine' })).status).toBe(201);
        expect((await t.call('POST', '/pages', { id, title: 'Again' })).status).toBe(409);
    });

    it('soft-deletes, hides and restores', async () => {
        const page = await createPage({ title: 'Ephemeral' });
        expect((await t.call('DELETE', `/pages/${page.id}`)).body.deletedAt).not.toBeNull();
        expect((await t.call('GET', `/pages/${page.id}`)).status).toBe(404);

        const trash = await t.call('GET', '/pages?deleted=true');
        expect(trash.body.items.map((p: { id: string }) => p.id)).toContain(page.id);

        const restored = await t.call('POST', `/pages/${page.id}/restore`);
        expect(restored.body.deletedAt).toBeNull();
    });

    it('appends markdown to the end of a page', async () => {
        const page = await createPage({ title: 'Log', content: 'first\n' });
        const res = await t.call('POST', `/pages/${page.id}/append`, { content: 'second' });
        expect(res.body.content).toBe('first\n\nsecond');
    });

    it('lists newest first with a working cursor', async () => {
        const first = await t.call('GET', '/pages?limit=2');
        expect(first.body.items).toHaveLength(2);
        expect(first.body.nextCursor).toBeTruthy();
        const second = await t.call('GET', `/pages?limit=2&cursor=${first.body.nextCursor}`);
        const ids = [...first.body.items, ...second.body.items].map((p: { id: string }) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(first.body.items[0].excerpt).toBeTypeOf('string');
    });

    it('searches titles and bodies', async () => {
        await createPage({ title: 'Sourdough starter', content: 'Feed it flour and water daily.' });
        await createPage({ title: 'Groceries', content: 'Buy rye flour for the bread.' });

        const byBody = await t.call('GET', '/pages?q=flour');
        expect(byBody.body.items.map((p: { title: string }) => p.title).sort()).toEqual([
            'Groceries',
            'Sourdough starter',
        ]);

        const byPrefix = await t.call('GET', '/pages?q=Sourd');
        expect(byPrefix.body.items[0].title).toBe('Sourdough starter');
    });
});

describe('links', () => {
    it('tracks links, backlinks and cycles', async () => {
        const a = await createPage({ title: 'A' });
        const b = await createPage({ title: 'B', content: `Back to ${pageLink(a.id, 'A')}` });
        const ghost = crypto.randomUUID();
        await t.call('PATCH', `/pages/${a.id}`, {
            content: `${pageLink(b.id, 'B')} and ${pageLink(ghost, 'not synced yet')} and ${pageLink(a.id, 'me')}`,
        });

        const links = await t.call('GET', `/pages/${a.id}/links`);
        expect(links.body.items).toEqual(
            expect.arrayContaining([
                { id: b.id, title: 'B', icon: null, exists: true },
                { id: ghost, title: null, icon: null, exists: false },
                { id: a.id, title: 'A', icon: null, exists: true },
            ]),
        );

        const backlinks = await t.call('GET', `/pages/${a.id}/backlinks`);
        expect(backlinks.body.items.map((p: { id: string }) => p.id).sort()).toEqual(
            [a.id, b.id].sort(),
        );

        const graph = await t.call('GET', '/pages/graph');
        expect(graph.body.edges).toEqual(
            expect.arrayContaining([
                { source: a.id, target: b.id },
                { source: b.id, target: a.id },
            ]),
        );
        expect(graph.body.edges).not.toContainEqual({ source: a.id, target: ghost });
    });

    it('drops a deleted page out of backlinks', async () => {
        const target = await createPage({ title: 'Target' });
        const source = await createPage({ content: pageLink(target.id, 'Target') });
        await t.call('DELETE', `/pages/${source.id}`);
        const backlinks = await t.call('GET', `/pages/${target.id}/backlinks`);
        expect(backlinks.body.items).toEqual([]);
    });
});

describe('sync', () => {
    const change = (over: Record<string, unknown>) => ({
        id: crypto.randomUUID(),
        baseVersion: null,
        title: 'Offline note',
        content: 'written on a plane',
        icon: null,
        deleted: false,
        ...over,
    });

    it('pulls every write after a cursor, deletions included', async () => {
        const start = (await t.call('GET', '/sync/pull?limit=1000')).body.cursor;
        const page = await createPage({ title: 'Pulled' });
        await t.call('DELETE', `/pages/${page.id}`);

        const pulled = await t.call('GET', `/sync/pull?cursor=${start}`);
        expect(pulled.body.pages).toHaveLength(1);
        expect(pulled.body.pages[0]).toMatchObject({ id: page.id, version: 2 });
        expect(pulled.body.pages[0].deletedAt).not.toBeNull();
        expect(Number(pulled.body.cursor)).toBeGreaterThan(Number(start));

        const empty = await t.call('GET', `/sync/pull?cursor=${pulled.body.cursor}`);
        expect(empty.body).toMatchObject({ pages: [], hasMore: false, cursor: pulled.body.cursor });
    });

    it('pages through a backlog with hasMore', async () => {
        const start = (await t.call('GET', '/sync/pull?limit=1000')).body.cursor;
        for (const title of ['one', 'two', 'three']) await createPage({ title });
        const first = await t.call('GET', `/sync/pull?cursor=${start}&limit=2`);
        expect(first.body).toMatchObject({ hasMore: true });
        const rest = await t.call('GET', `/sync/pull?cursor=${first.body.cursor}&limit=2`);
        expect(rest.body).toMatchObject({ hasMore: false });
        expect(
            [...first.body.pages, ...rest.body.pages].map((p: { title: string }) => p.title),
        ).toEqual(['one', 'two', 'three']);
    });

    it('applies new pages and edits on the right base', async () => {
        const created = change({});
        const push = await t.call('POST', '/sync/push', { changes: [created] });
        expect(push.body.results[0]).toMatchObject({ status: 'applied', page: { version: 1 } });

        const edited = { ...created, baseVersion: 1, content: 'landed' };
        const again = await t.call('POST', '/sync/push', { changes: [edited] });
        expect(again.body.results[0]).toMatchObject({ status: 'applied', page: { version: 2 } });
    });

    it('treats a retried push as applied rather than a conflict', async () => {
        const created = change({});
        await t.call('POST', '/sync/push', { changes: [created] });
        const retry = await t.call('POST', '/sync/push', { changes: [created] });
        expect(retry.body.results[0]).toMatchObject({ status: 'applied', page: { version: 1 } });
    });

    it('reports a conflict with the server copy when the base moved', async () => {
        const created = change({});
        await t.call('POST', '/sync/push', { changes: [created] });
        await t.call('PATCH', `/pages/${created.id}`, { content: 'edited by the agent' });

        const stale = { ...created, baseVersion: 1, content: 'edited offline' };
        const res = await t.call('POST', '/sync/push', { changes: [stale] });
        expect(res.body.results[0]).toMatchObject({
            status: 'conflict',
            page: { version: 2, content: 'edited by the agent' },
        });
    });

    it('syncs a deletion and a resurrection', async () => {
        const created = change({});
        await t.call('POST', '/sync/push', { changes: [created] });
        const del = await t.call('POST', '/sync/push', {
            changes: [{ ...created, baseVersion: 1, deleted: true }],
        });
        expect(del.body.results[0].page.deletedAt).not.toBeNull();
        const back = await t.call('POST', '/sync/push', {
            changes: [{ ...created, baseVersion: 2, deleted: false }],
        });
        expect(back.body.results[0].page).toMatchObject({ version: 3, deletedAt: null });
    });

    it('validates pushed changes', async () => {
        const res = await t.call('POST', '/sync/push', { changes: [{ id: 'nope' }] });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
    });
});
