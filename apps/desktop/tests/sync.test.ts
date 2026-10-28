import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api, ApiChangeResult, ApiPageChange, ApiSyncPage } from '../src/lib/api';
import { PageSync, type SyncHooks } from '../src/lib/sync';

// Outside Tauri, storage falls back to localStorage; a Map stands in for the disk.
const disk = new Map<string, string>();
vi.stubGlobal('localStorage', {
    getItem: (k: string) => disk.get(k) ?? null,
    setItem: (k: string, v: string) => void disk.set(k, v),
    removeItem: (k: string) => void disk.delete(k),
    key: (i: number) => [...disk.keys()][i] ?? null,
    get length() {
        return disk.size;
    },
});

type Row = ApiSyncPage & { seq: number };

/** The API's `/sync` semantics (apps/api/src/pages/service.ts) over a Map. */
class FakeServer {
    readonly baseUrl = 'http://localhost:3000';
    pages = new Map<string, Row>();
    online = true;
    /** Changes per push request, in order. */
    pushes: number[] = [];
    #seq = 0;

    write(id: string, patch: Partial<ApiSyncPage>): Row {
        const current = this.pages.get(id);
        const now = new Date().toISOString();
        const row: Row = {
            id,
            title: '',
            content: '',
            icon: null,
            createdAt: now,
            deletedAt: null,
            ...current,
            ...patch,
            version: (current?.version ?? 0) + 1,
            seq: ++this.#seq,
            updatedAt: now,
        };
        this.pages.set(id, row);
        return row;
    }

    async syncPush(changes: ApiPageChange[]): Promise<{ results: ApiChangeResult[] }> {
        if (!this.online) throw new Error('Cannot reach the API');
        if (JSON.stringify({ changes }).length > 10 * 1024 * 1024) throw new Error('413');
        if (changes.some((c) => c.content.length > 1_000_000)) throw new Error('400');
        this.pushes.push(changes.length);
        return { results: changes.map((c) => this.#apply(c)) };
    }

    async syncPull(cursor: string, limit: number) {
        if (!this.online) throw new Error('Cannot reach the API');
        const rows = [...this.pages.values()]
            .filter((p) => p.seq > Number(cursor))
            .sort((a, b) => a.seq - b.seq);
        const batch = rows.slice(0, limit);
        return {
            pages: batch.map(page),
            cursor: String(batch.at(-1)?.seq ?? cursor),
            hasMore: rows.length > limit,
        };
    }

    #apply(c: ApiPageChange): ApiChangeResult {
        const current = this.pages.get(c.id);
        const deletedAt = c.deleted ? (current?.deletedAt ?? new Date().toISOString()) : null;
        const next = { title: c.title, content: c.content, icon: c.icon, deletedAt };
        if (!current) {
            if (c.baseVersion !== null) return { id: c.id, status: 'gone' };
            return { id: c.id, status: 'applied', page: page(this.write(c.id, next)) };
        }
        const same =
            current.title === c.title &&
            current.content === c.content &&
            current.icon === c.icon &&
            (current.deletedAt !== null) === c.deleted;
        if (same) return { id: c.id, status: 'applied', page: page(current) };
        if (c.baseVersion !== current.version) {
            return { id: c.id, status: 'conflict', page: page(current) };
        }
        return { id: c.id, status: 'applied', page: page(this.write(c.id, next)) };
    }
}

const page = ({ seq: _seq, ...p }: Row): ApiSyncPage => p;

let server: FakeServer;
let error: unknown;
let changedBodies: string[];
const hooks: SyncHooks = {
    change: (_pages, content) => {
        changedBodies.push(...content);
    },
    result: (e) => {
        error = e;
    },
};
const open = () => PageSync.open(server as unknown as Api, hooks);

beforeEach(() => {
    disk.clear();
    server = new FakeServer();
    error = null;
    changedBodies = [];
});

describe('PageSync', () => {
    it('keeps offline edits on disk and pushes them on reconnect', async () => {
        server.online = false;
        let sync = await open();
        const doc = await sync.create('Plane notes');
        await sync.edit(doc.id, { content: 'written offline' });
        await sync.sync();
        expect(error).not.toBeNull();
        expect(sync.pending()).toBe(1);
        expect(server.pages.size).toBe(0);

        sync.close();
        sync = await open();
        expect(await sync.read(doc.id)).toBe('written offline');
        expect(sync.pending()).toBe(1);

        server.online = true;
        await sync.sync();
        expect(error).toBeNull();
        expect(sync.pending()).toBe(0);
        expect(server.pages.get(doc.id)?.content).toBe('written offline');
        sync.close();
    });

    it('pulls edits made elsewhere and flags the changed body', async () => {
        const sync = await open();
        const doc = await sync.create('Notes');
        await sync.sync();
        server.write(doc.id, { content: 'edited by the agent' });
        await sync.sync();
        expect(await sync.read(doc.id)).toBe('edited by the agent');
        expect(changedBodies).toContain(doc.id);
        sync.close();
    });

    it('keeps both versions on a conflict', async () => {
        const sync = await open();
        const doc = await sync.create('Notes');
        await sync.sync();
        server.online = false;
        await sync.edit(doc.id, { content: 'mine' });
        server.write(doc.id, { content: 'theirs' });
        server.online = true;
        await sync.sync();

        expect(await sync.read(doc.id)).toBe('theirs');
        const copy = sync.list().find((p) => p.title === 'Notes (conflicted copy)');
        expect(copy).toBeDefined();
        expect(server.pages.get(copy!.id)?.content).toBe('mine');
        expect(sync.pending()).toBe(0);
        sync.close();
    });

    it('batches pushes by count and by size', async () => {
        server.online = false;
        const sync = await open();
        for (let i = 0; i < 250; i++) await sync.create(`page ${i}`);
        server.online = true;
        await sync.sync();
        expect(server.pushes).toEqual([100, 100, 50]);

        const big = 'x'.repeat(900_000);
        for (let i = 0; i < 12; i++) {
            const doc = await sync.create(`big ${i}`);
            await sync.edit(doc.id, { content: big });
        }
        server.pushes = [];
        await sync.sync();
        expect(server.pushes.length).toBeGreaterThan(1);
        expect(sync.pending()).toBe(0);
        sync.close();
    });

    it('holds back a page over the limits without blocking the rest', async () => {
        const sync = await open();
        const huge = await sync.create('huge');
        await sync.edit(huge.id, { content: 'y'.repeat(1_000_001) });
        const small = await sync.create('small');
        await sync.sync();
        expect(server.pages.has(small.id)).toBe(true);
        expect(server.pages.has(huge.id)).toBe(false);
        expect(sync.pending()).toBe(1);
        expect(String(error)).toContain('huge');
        sync.close();
    });

    it('handles pages the server purged', async () => {
        const sync = await open();
        const trashed = await sync.create('trashed');
        const live = await sync.create('live');
        await sync.sync();
        server.online = false;
        await sync.edit(trashed.id, { deleted: true });
        await sync.edit(live.id, { content: 'kept' });
        server.online = true;
        server.pages.delete(trashed.id);
        server.pages.delete(live.id);
        await sync.sync();

        expect(sync.list().some((p) => p.id === trashed.id)).toBe(false);
        expect(server.pages.get(live.id)?.content).toBe('kept');
        sync.close();
    });

    it('keeps an edit made while a push is in flight', async () => {
        const sync = await open();
        const doc = await sync.create('race');
        await sync.sync();
        const round = sync.sync();
        await sync.edit(doc.id, { content: 'typed mid-push' });
        await round;
        await sync.sync();
        expect(server.pages.get(doc.id)?.content).toBe('typed mid-push');
        sync.close();
    });
});
