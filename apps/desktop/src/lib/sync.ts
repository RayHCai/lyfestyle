import { storage, readJSON } from './storage';
import type { Api, ApiPageChange, ApiSyncPage } from './api';
import { TRASH_DAYS } from './types';
import { id as newId } from './util';

/** A page as this device holds it. Its body is a file beside the index, `<id>.md`. */
export interface LocalPage {
    id: string;
    title: string;
    icon: string | null;
    createdAt: number;
    updatedAt: number;
    /** Set while the page is in the trash. */
    deletedAt: number | null;
    /** The server version this copy builds on; null until the page first reaches the server. */
    baseVersion: number | null;
    /** Holds edits the server has not accepted yet. */
    dirty: boolean;
    /** Bumped on every local edit, so a push can tell whether the page changed under it. */
    localRev: number;
}

interface Index {
    /** `GET /sync/pull` cursor: everything up to it is already here. */
    cursor: string;
    /** When the last pull finished. After the trash window the server may have purged pages
     *  without a change to pull, so a stale index pulls everything again. */
    pulledAt: number;
    pages: LocalPage[];
}

export interface SyncHooks {
    /** The pages changed. `content` names pages whose body was replaced from the server. */
    change(pages: LocalPage[], content: string[]): void;
    /** A round finished: null when it reached the server, else why not. */
    result(error: unknown): void;
}

const PUSH_BATCH = 100;
/** Under the API's 10 MiB limit on a `/sync/push` body, with room for the envelope. */
const PUSH_BYTES = 8 * 1024 * 1024;
/** The API's `pageFields` limits, in string length. */
const MAX_CONTENT = 1_000_000;
const MAX_TITLE = 500;
const PULL_BATCH = 500;
/** Quiet time after the last edit before its batch is pushed. */
const PUSH_DELAY = 1500;
const DAY = 24 * 60 * 60 * 1000;

/** One folder per server, e.g. `sync/api.example.com`; storage keys may not hold `:` or `..`. */
function rootFor(baseUrl: string) {
    let host = baseUrl;
    try {
        host = new URL(baseUrl).host;
    } catch {
        /* not a URL; sanitise it as is */
    }
    return `sync/${host.replace(/[^a-z0-9.-]/gi, '_').replace(/\.{2,}/g, '_') || 'api'}`;
}

const ms = (iso: string) => new Date(iso).getTime();

function fromServer(page: ApiSyncPage, localRev: number): LocalPage {
    return {
        id: page.id,
        title: page.title,
        icon: page.icon,
        createdAt: ms(page.createdAt),
        updatedAt: ms(page.updatedAt),
        deletedAt: page.deletedAt ? ms(page.deletedAt) : null,
        baseVersion: page.version,
        dirty: false,
        localRev,
    };
}

/**
 * API mode's documents: a local copy of every page, edited first and pushed to the API in
 * batches. Edits made offline wait in the copy until a round reaches the server again. The
 * protocol is "Offline sync" in docs/api.md; a conflict keeps both versions.
 */
export class PageSync {
    readonly #api: Api;
    readonly #root: string;
    readonly #hooks: SyncHooks;
    readonly #index: Index;
    readonly #pages: Map<string, LocalPage>;
    /** Bodies read or written this session; the rest stay on disk until asked for. */
    readonly #bodies = new Map<string, string>();
    /** Disk writes, in order, so the index on disk is always the latest one queued. */
    #writes: Promise<unknown> = Promise.resolve();
    /** Pages dropped since the last save, whose bodies it deletes. */
    readonly #removed: string[] = [];
    #running: Promise<void> | null = null;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #closed = false;

    private constructor(api: Api, root: string, index: Index, hooks: SyncHooks) {
        this.#api = api;
        this.#root = root;
        this.#index = index;
        this.#hooks = hooks;
        this.#pages = new Map(index.pages.map((p) => [p.id, p]));
    }

    static async open(api: Api, hooks: SyncHooks): Promise<PageSync> {
        const root = rootFor(api.baseUrl);
        const index = await readJSON<Index>(`${root}/index.json`, {
            cursor: '0',
            pulledAt: 0,
            pages: [],
        });
        return new PageSync(api, root, index, hooks);
    }

    /** Stops scheduled pushes; the copy on disk stays for the next session. */
    close() {
        this.#closed = true;
        clearTimeout(this.#timer);
    }

    /** Every page, trashed ones included, most recently edited first. */
    list(): LocalPage[] {
        return [...this.#pages.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /** Pages with edits the server has not accepted yet. */
    pending(): number {
        let n = 0;
        for (const p of this.#pages.values()) if (p.dirty) n++;
        return n;
    }

    async read(id: string): Promise<string> {
        const cached = this.#bodies.get(id);
        if (cached !== undefined) return cached;
        const body = (await storage.read(this.#bodyKey(id))) ?? '';
        this.#bodies.set(id, body);
        return body;
    }

    create(title: string): Promise<LocalPage> {
        return this.edit(newId(), { title, content: '' });
    }

    /** Applies an edit to the local copy at once and schedules a push. */
    async edit(
        id: string,
        patch: { title?: string; content?: string; deleted?: boolean },
    ): Promise<LocalPage> {
        const now = Date.now();
        const current = this.#pages.get(id);
        const page: LocalPage = {
            ...(current ?? {
                id,
                title: '',
                icon: null,
                createdAt: now,
                deletedAt: null,
                baseVersion: null,
                localRev: 0,
            }),
            updatedAt: now,
            dirty: true,
        };
        page.localRev++;
        if (patch.title !== undefined) page.title = patch.title;
        if (patch.deleted !== undefined)
            page.deletedAt = patch.deleted ? (page.deletedAt ?? now) : null;
        this.#pages.set(id, page);
        const bodies: string[] = [];
        if (patch.content !== undefined || !current) {
            this.#bodies.set(id, patch.content ?? '');
            bodies.push(id);
        }
        this.#hooks.change(this.list(), []);
        this.#schedule();
        await this.#save(bodies);
        return page;
    }

    /** One push-pull round. Calls made while a round runs share it; it never throws. */
    sync(): Promise<void> {
        this.#running ??= this.#round().finally(() => {
            this.#running = null;
        });
        return this.#running;
    }

    #schedule() {
        clearTimeout(this.#timer);
        if (this.#closed) return;
        this.#timer = setTimeout(() => {
            // A running round may have read its dirty list before this edit; go after it.
            if (this.#running) this.#schedule();
            else void this.sync();
        }, PUSH_DELAY);
    }

    async #round() {
        const content = new Set<string>();
        const tooLarge = new Set<string>();
        let error: unknown = null;
        try {
            await this.#push(content, tooLarge);
            await this.#pull(content);
            // Conflicted copies, and edits made while the pull ran.
            if (this.pending()) await this.#push(content, tooLarge);
            if (tooLarge.size) {
                error = new Error(
                    `Too large to sync, kept on this device only: ${[...tooLarge].join(', ')}`,
                );
            }
        } catch (e) {
            error = e;
        }
        if (this.#closed) return;
        this.#hooks.change(this.list(), [...content]);
        this.#hooks.result(error);
    }

    /** Pushes every dirty page in batches under the API's body limit. A page over the API's page
     *  limits stays dirty here and is named in `tooLarge`, so it cannot hold up the rest. */
    async #push(content: Set<string>, tooLarge: Set<string>) {
        const encoder = new TextEncoder();
        let batch: { sent: LocalPage; change: ApiPageChange }[] = [];
        let bytes = 0;
        const flush = async () => {
            if (!batch.length) return;
            const sending = batch;
            batch = [];
            bytes = 0;
            const { results } = await this.#api.syncPush(sending.map((b) => b.change));
            const written: string[] = [];
            for (const result of results) {
                const sent = sending.find((b) => b.sent.id === result.id)?.sent;
                if (!sent) continue;
                if (result.status === 'applied') this.#accept(sent, result.page);
                else if (result.status === 'gone') this.#gone(sent);
                else written.push(...(await this.#conflict(result.page, content)));
            }
            await this.#save(written, this.#removed.splice(0));
        };

        for (const page of this.list().filter((p) => p.dirty)) {
            const sent = { ...page };
            const change: ApiPageChange = {
                id: sent.id,
                baseVersion: sent.baseVersion,
                title: sent.title,
                content: await this.read(sent.id),
                icon: sent.icon,
                deleted: sent.deletedAt !== null,
            };
            // The push validates every change, so one oversized page would fail its whole batch.
            if (change.content.length > MAX_CONTENT || change.title.length > MAX_TITLE) {
                tooLarge.add(sent.title || 'Untitled');
                continue;
            }
            // JSON escaping can grow a body, so count the change as it will be sent.
            const json = encoder.encode(JSON.stringify(change)).length;
            if (batch.length >= PUSH_BATCH || bytes + json > PUSH_BYTES) await flush();
            batch.push({ sent, change });
            bytes += json;
        }
        await flush();
    }

    /** The server purged a page this device still had (it sat in the trash too long). A trashed
     *  copy goes too; a live edit is kept and pushed again as a new page under the same id. */
    #gone(sent: LocalPage) {
        const current = this.#pages.get(sent.id);
        if (!current) return;
        if (current.deletedAt !== null) {
            this.#pages.delete(sent.id);
            this.#bodies.delete(sent.id);
            this.#removed.push(sent.id);
            return;
        }
        this.#pages.set(sent.id, {
            ...current,
            baseVersion: null,
            dirty: true,
            localRev: current.localRev + 1,
        });
    }

    /** The server took `sent`; keep any edit made while the push was in flight. */
    #accept(sent: LocalPage, server: ApiSyncPage) {
        const current = this.#pages.get(sent.id);
        if (!current || current.localRev === sent.localRev) {
            this.#pages.set(sent.id, fromServer(server, sent.localRev));
        } else {
            this.#pages.set(sent.id, { ...current, baseVersion: server.version });
        }
    }

    /** Someone else wrote first. The server's copy keeps the id; a live local edit becomes a
     *  new "conflicted copy" page, so no edit is lost. Answers the pages whose body changed. */
    async #conflict(server: ApiSyncPage, content: Set<string>): Promise<string[]> {
        const local = this.#pages.get(server.id);
        const body = local ? await this.read(server.id) : '';
        this.#pages.set(server.id, fromServer(server, (local?.localRev ?? 0) + 1));
        this.#bodies.set(server.id, server.content);
        content.add(server.id);
        if (!local || local.deletedAt !== null) return [server.id];
        const now = Date.now();
        const copy: LocalPage = {
            ...local,
            id: newId(),
            title: `${local.title || 'Untitled'} (conflicted copy)`,
            createdAt: now,
            updatedAt: now,
            baseVersion: null,
            dirty: true,
            localRev: 1,
        };
        this.#pages.set(copy.id, copy);
        this.#bodies.set(copy.id, body);
        return [server.id, copy.id];
    }

    async #same(local: LocalPage, server: ApiSyncPage) {
        return (
            local.title === server.title &&
            local.icon === server.icon &&
            (local.deletedAt !== null) === (server.deletedAt !== null) &&
            (await this.read(local.id)) === server.content
        );
    }

    async #pull(content: Set<string>) {
        const full = Date.now() - this.#index.pulledAt > TRASH_DAYS * DAY;
        let cursor = full ? '0' : this.#index.cursor;
        const seen = new Set<string>();
        for (;;) {
            const batch = await this.#api.syncPull(cursor, PULL_BATCH);
            const written: string[] = [];
            for (const server of batch.pages) {
                seen.add(server.id);
                const local = this.#pages.get(server.id);
                if (local?.dirty && !(await this.#same(local, server))) {
                    if (local.baseVersion === null || server.version > local.baseVersion) {
                        written.push(...(await this.#conflict(server, content)));
                    }
                    continue;
                }
                if (local && !local.dirty && server.version <= (local.baseVersion ?? 0)) continue;
                if (local && (await this.read(server.id)) !== server.content) {
                    content.add(server.id);
                }
                this.#pages.set(server.id, fromServer(server, local?.localRev ?? 0));
                this.#bodies.set(server.id, server.content);
                written.push(server.id);
            }
            cursor = batch.cursor;
            this.#index.cursor = cursor;
            await this.#save(written);
            if (!batch.hasMore) break;
        }

        // Mirror the server's trash purge, which leaves nothing behind to pull.
        const purgeBefore = Date.now() - TRASH_DAYS * DAY;
        const gone = this.list().filter(
            (p) =>
                !p.dirty &&
                ((full && !seen.has(p.id)) || (p.deletedAt !== null && p.deletedAt < purgeBefore)),
        );
        for (const p of gone) {
            this.#pages.delete(p.id);
            this.#bodies.delete(p.id);
        }
        this.#index.pulledAt = Date.now();
        await this.#save(
            [],
            gone.map((p) => p.id),
        );
    }

    #bodyKey(id: string) {
        return `${this.#root}/${id}.md`;
    }

    /** Queues writes of these bodies, deletes of those, then the index as it is now. */
    #save(bodies: string[], removed: string[] = []) {
        const files = bodies.map((id) => [this.#bodyKey(id), this.#bodies.get(id) ?? ''] as const);
        const index = JSON.stringify({ ...this.#index, pages: [...this.#pages.values()] });
        const next = this.#writes.then(async () => {
            await Promise.all([
                ...files.map(([key, body]) => storage.write(key, body)),
                ...removed.map((id) => storage.del(this.#bodyKey(id))),
            ]);
            await storage.write(`${this.#root}/index.json`, index);
        });
        this.#writes = next.catch(() => undefined);
        return next;
    }
}
