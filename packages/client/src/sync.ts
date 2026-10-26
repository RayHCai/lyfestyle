import { unwrap, type ApiClient } from './client.js';

/** A page as the API returns it. */
export interface ServerPage {
    id: string;
    title: string;
    content: string;
    icon: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
}

/** A page as this device holds it. */
export interface LocalPage {
    id: string;
    title: string;
    content: string;
    icon: string | null;
    deleted: boolean;
    /** The server version this copy builds on; null until the page first reaches the server. */
    baseVersion: number | null;
    /** True while this copy holds edits the server has not accepted yet. */
    dirty: boolean;
    /** Bumped on every local edit, so a sync can tell whether the page changed under it. */
    localRev: number;
    updatedAt: string;
}

/** Where a device keeps its pages: IndexedDB, SQLite through Tauri, or memory in tests. */
export interface LocalStore {
    get(id: string): Promise<LocalPage | undefined>;
    put(page: LocalPage): Promise<void>;
    all(): Promise<LocalPage[]>;
    dirty(): Promise<LocalPage[]>;
    getCursor(): Promise<string | null>;
    setCursor(cursor: string): Promise<void>;
}

export class MemoryStore implements LocalStore {
    readonly pages = new Map<string, LocalPage>();
    cursor: string | null = null;

    async get(id: string) {
        const page = this.pages.get(id);
        return page && { ...page };
    }
    async put(page: LocalPage) {
        this.pages.set(page.id, { ...page });
    }
    async all() {
        return [...this.pages.values()].map((p) => ({ ...p }));
    }
    async dirty() {
        return (await this.all()).filter((p) => p.dirty);
    }
    async getCursor() {
        return this.cursor;
    }
    async setCursor(cursor: string) {
        this.cursor = cursor;
    }
}

export type ConflictResolution =
    /** Take the server's copy and drop the local edit. */
    | { keep: 'server' }
    /** Overwrite the server's copy with the local edit on the next push. */
    | { keep: 'local' }
    /** Take the server's copy and keep the local edit as a new "conflicted copy" page. */
    | { keep: 'both' }
    | { merge: { title: string; content: string; icon: string | null } };

export type ConflictResolver = (
    local: LocalPage,
    server: ServerPage,
) => ConflictResolution | Promise<ConflictResolution>;

export interface SyncReport {
    pushed: number;
    pulled: number;
    conflicts: number;
}

export interface SyncEngineOptions {
    api: ApiClient;
    store: LocalStore;
    /** Defaults to keeping both copies, so no edit is ever lost silently. */
    resolve?: ConflictResolver;
    now?: () => Date;
    newId?: () => string;
}

const PUSH_BATCH = 100;
const PULL_BATCH = 500;

function same(local: LocalPage, server: ServerPage): boolean {
    return (
        local.title === server.title &&
        local.content === server.content &&
        local.icon === server.icon &&
        local.deleted === (server.deletedAt !== null)
    );
}

function fromServer(server: ServerPage, localRev: number): LocalPage {
    return {
        id: server.id,
        title: server.title,
        content: server.content,
        icon: server.icon,
        deleted: server.deletedAt !== null,
        baseVersion: server.version,
        dirty: false,
        localRev,
        updatedAt: server.updatedAt,
    };
}

/**
 * Offline-first pages: edits land in the local store at once and reach the API on `sync()`,
 * which pushes local edits, then pulls everything written since the last pull.
 */
export class SyncEngine {
    readonly #api: ApiClient;
    readonly #store: LocalStore;
    readonly #resolve: ConflictResolver;
    readonly #now: () => Date;
    readonly #newId: () => string;
    #running: Promise<SyncReport> | null = null;

    constructor(options: SyncEngineOptions) {
        this.#api = options.api;
        this.#store = options.store;
        this.#resolve = options.resolve ?? (() => ({ keep: 'both' }));
        this.#now = options.now ?? (() => new Date());
        this.#newId = options.newId ?? (() => crypto.randomUUID());
    }

    /** Creates a page (no id) or edits one, locally. */
    async save(input: {
        id?: string;
        title?: string;
        content?: string;
        icon?: string | null;
    }): Promise<LocalPage> {
        const current = input.id ? await this.#store.get(input.id) : undefined;
        const page: LocalPage = {
            id: input.id ?? this.#newId(),
            title: input.title ?? current?.title ?? '',
            content: input.content ?? current?.content ?? '',
            icon: input.icon === undefined ? (current?.icon ?? null) : input.icon,
            deleted: false,
            baseVersion: current?.baseVersion ?? null,
            dirty: true,
            localRev: (current?.localRev ?? 0) + 1,
            updatedAt: this.#now().toISOString(),
        };
        await this.#store.put(page);
        return page;
    }

    async remove(id: string): Promise<void> {
        const current = await this.#store.get(id);
        if (!current || current.deleted) return;
        await this.#store.put({
            ...current,
            deleted: true,
            dirty: true,
            localRev: current.localRev + 1,
            updatedAt: this.#now().toISOString(),
        });
    }

    /** One push-pull round. Calls made while a round runs share it. */
    sync(): Promise<SyncReport> {
        this.#running ??= this.#round().finally(() => {
            this.#running = null;
        });
        return this.#running;
    }

    /** Syncs now, then every `intervalMs` and whenever the browser comes back online. */
    startAutoSync(options: { intervalMs?: number; onError?: (err: unknown) => void } = {}) {
        const run = () => void this.sync().catch((err) => options.onError?.(err));
        const timer = setInterval(run, options.intervalMs ?? 30_000);
        const target = globalThis as {
            addEventListener?: EventTarget['addEventListener'];
            removeEventListener?: EventTarget['removeEventListener'];
        };
        target.addEventListener?.('online', run);
        run();
        return () => {
            clearInterval(timer);
            target.removeEventListener?.('online', run);
        };
    }

    async #round(): Promise<SyncReport> {
        const report: SyncReport = { pushed: 0, pulled: 0, conflicts: 0 };
        await this.#push(report);
        await this.#pull(report);
        if ((await this.#store.dirty()).length) await this.#push(report);
        return report;
    }

    async #push(report: SyncReport) {
        const dirty = await this.#store.dirty();
        for (let i = 0; i < dirty.length; i += PUSH_BATCH) {
            const batch = dirty.slice(i, i + PUSH_BATCH);
            const { results } = await unwrap(
                this.#api.sync.push.$post({
                    json: {
                        changes: batch.map((p) => ({
                            id: p.id,
                            baseVersion: p.baseVersion,
                            title: p.title,
                            content: p.content,
                            icon: p.icon,
                            deleted: p.deleted,
                        })),
                    },
                }),
            );
            for (const result of results) {
                const sent = batch.find((p) => p.id === result.id)!;
                if (result.status === 'applied') {
                    report.pushed++;
                    await this.#accept(sent, result.page);
                } else {
                    await this.#conflict(result.page, report);
                }
            }
        }
    }

    async #pull(report: SyncReport) {
        let cursor = (await this.#store.getCursor()) ?? '0';
        for (;;) {
            const page = await unwrap(
                this.#api.sync.pull.$get({ query: { cursor, limit: String(PULL_BATCH) } }),
            );
            for (const server of page.pages) {
                report.pulled++;
                const local = await this.#store.get(server.id);
                if (!local || !local.dirty || same(local, server)) {
                    await this.#store.put(fromServer(server, local?.localRev ?? 0));
                } else if (local.baseVersion === null || server.version > local.baseVersion) {
                    await this.#conflict(server, report);
                }
            }
            cursor = page.cursor;
            await this.#store.setCursor(cursor);
            if (!page.hasMore) return;
        }
    }

    /** The server took `sent`; keep any edit made while the push was in flight. */
    async #accept(sent: LocalPage, server: ServerPage) {
        const current = await this.#store.get(sent.id);
        if (!current || current.localRev === sent.localRev) {
            await this.#store.put(fromServer(server, sent.localRev));
        } else {
            await this.#store.put({ ...current, baseVersion: server.version });
        }
    }

    async #conflict(server: ServerPage, report: SyncReport) {
        const local = await this.#store.get(server.id);
        if (!local) return this.#store.put(fromServer(server, 0));
        report.conflicts++;
        const resolution = await this.#resolve(local, server);
        const rebased = {
            ...local,
            baseVersion: server.version,
            dirty: true,
            localRev: local.localRev + 1,
        };

        if ('merge' in resolution) {
            return this.#store.put({ ...rebased, ...resolution.merge, deleted: false });
        }
        if (resolution.keep === 'local') return this.#store.put(rebased);

        await this.#store.put(fromServer(server, local.localRev + 1));
        if (resolution.keep === 'both' && !local.deleted) {
            await this.#store.put({
                ...local,
                id: this.#newId(),
                title: `${local.title || 'Untitled'} (conflicted copy)`,
                baseVersion: null,
                dirty: true,
                localRev: 1,
                updatedAt: this.#now().toISOString(),
            });
        }
    }
}
