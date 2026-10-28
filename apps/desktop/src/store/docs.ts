/**
 * Documents, behind one interface with two backends. Local mode keeps markdown files beside
 * `documents/index.json`, a file the agent's tool server (`mcp.rs`) also rewrites mid-turn. API
 * mode keeps a local copy of the API's pages (`lib/sync.ts`) that pushes and pulls in the
 * background, so documents work offline.
 */
import { describeError } from '../lib/api';
import { storage, writeJSON } from '../lib/storage';
import { dropDoc, parseIndex, putDoc } from '../lib/stored';
import type { LocalPage, PageSync, SyncHooks } from '../lib/sync';
import type { DocMeta } from '../lib/types';
import { id as newId } from '../lib/util';
import { getPages } from './backend';
import type { DocsSlice, Slice } from './state';

type SetState = Parameters<Slice<DocsSlice>>[0];

const INDEX = 'documents/index.json';
const docKey = (id: string) => `documents/${id}.md`;
/** Characters of a trashed document shown in the trash, as the API's `excerpt`. */
const EXCERPT = 200;
/** How both backends title the copy that keeps an edit which lost a conflict. */
const COPY = ' (conflicted copy)';
const conflictNotice = (title: string) =>
    `A document changed elsewhere while you were editing it. Your version is saved as "${title}".`;

/** What the slice needs from a backend; each mode implements it once. */
interface DocBackend {
    create(title: string): Promise<DocMeta>;
    rename(id: string, title: string): Promise<void>;
    remove(id: string): Promise<void>;
    read(id: string): Promise<string>;
    write(id: string, markdown: string): Promise<void>;
    /** Brings the list up to date with changes made behind the app's back. */
    reload(): Promise<void>;
}

/** Editor saves still waiting out their debounce. */
const pendingSaves = new Set<() => void>();

/** Registers an editor's pending save so `flushEdits` can run it early. Returns the unregister. */
export function trackPendingSave(flush: () => void): () => void {
    pendingSaves.add(flush);
    return () => {
        pendingSaves.delete(flush);
    };
}

/** Saves what the editor holds before a reload or sync reads the documents, so typing that races
 *  an agent edit ends as a conflicted copy instead of overwriting the agent's text afterwards. */
export function flushEdits(): void {
    for (const flush of pendingSaves) flush();
}

/** Index reads and writes, one at a time, so this app's own changes cannot interleave. */
let indexQueue: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
    const next = indexQueue.then(fn);
    indexQueue = next.catch(() => undefined);
    return next;
}

const readIndex = async () => parseIndex(await storage.read(INDEX));

/** Applies `change` to the index as it is on disk now, never to the list in memory: the agent's
 *  tool server may have added, changed or removed entries since this app last read it. */
const updateIndex = (change: (disk: DocMeta[]) => Promise<DocMeta[]> | DocMeta[]) =>
    queued(async () => {
        const next = await change(await readIndex());
        await writeJSON(INDEX, next);
        return next;
    });

/** Local mode's first read of the documents: an unreadable index is reported, not emptied. */
export async function loadLocalDocs(): Promise<Pick<DocsSlice, 'docs' | 'docsError'>> {
    try {
        return { docs: await queued(readIndex), docsError: null };
    } catch (e) {
        return { docs: [], docsError: describeError(e) };
    }
}

const fromPage = (p: LocalPage): DocMeta => ({
    id: p.id,
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
});

/** API mode's view of the page copy. */
export const pageState = (all: LocalPage[]) => ({
    docs: all.filter((p) => p.deletedAt === null).map(fromPage),
    unsynced: all.filter((p) => p.dirty).length,
});

/** How the page copy reports to the store. Reports for a copy that is no longer active (the mode
 *  or the API changed) are dropped. */
export function pageSyncHooks(set: SetState, baseUrl: string, active: () => boolean): SyncHooks {
    return {
        change(all, content) {
            if (!active()) return;
            set((s) => {
                const docRevisions = { ...s.docRevisions };
                for (const id of content) docRevisions[id] = (docRevisions[id] ?? 0) + 1;
                // A conflict keeps the edit made here as a new page; say where it went. A copy
                // made long ago on another device is only news to this one, not a conflict.
                const known = new Set(s.docs.map((d) => d.id));
                const copy = all.find(
                    (p) =>
                        !known.has(p.id) &&
                        p.deletedAt === null &&
                        p.title.endsWith(COPY) &&
                        Date.now() - p.createdAt < 60_000,
                );
                return {
                    ...pageState(all),
                    docRevisions,
                    ...(copy ? { notice: conflictNotice(copy.title) } : {}),
                };
            });
        },
        result(error) {
            if (!active()) return;
            if (error) set({ docsError: `Not synced: ${describeError(error)}` });
            else set({ docsError: null, api: { state: 'ok', url: baseUrl } });
        },
    };
}

export const docsSlice: Slice<DocsSlice> = (set, get) => {
    const local: DocBackend = {
        async create(title) {
            const now = Date.now();
            const meta: DocMeta = { id: newId(), title, createdAt: now, updatedAt: now };
            const docs = await updateIndex(async (disk) => {
                await storage.write(docKey(meta.id), '');
                return putDoc(disk, meta);
            });
            set({ docs, docsError: null });
            return meta;
        },
        async rename(id, title) {
            const docs = await updateIndex((disk) => {
                const entry = disk.find((d) => d.id === id);
                return entry ? putDoc(disk, { ...entry, title, updatedAt: Date.now() }) : disk;
            });
            set({ docs });
        },
        async remove(id) {
            const docs = await updateIndex(async (disk) => {
                await storage.del(docKey(id));
                return dropDoc(disk, id);
            });
            set({ docs });
        },
        read: async (id) => (await storage.read(docKey(id))) ?? '',
        async write(id, markdown) {
            // The version the editor started from; newer on disk means the agent wrote it since.
            const known = get().docs.find((d) => d.id === id);
            // Deleted here while a save was pending: the delete wins.
            if (!known) return;
            const conflict: { copy?: DocMeta } = {};
            const docs = await updateIndex(async (disk) => {
                const now = Date.now();
                const entry = disk.find((d) => d.id === id);
                if (!entry || entry.updatedAt > known.updatedAt) {
                    // Changed or deleted by the agent since: keep both versions, the agent's under
                    // the id and this one as a new document.
                    const copy: DocMeta = {
                        id: newId(),
                        title: `${(entry ?? known).title || 'Untitled'}${COPY}`,
                        createdAt: now,
                        updatedAt: now,
                    };
                    conflict.copy = copy;
                    await storage.write(docKey(copy.id), markdown);
                    return putDoc(disk, copy);
                }
                await storage.write(docKey(id), markdown);
                return putDoc(disk, { ...entry, updatedAt: now });
            });
            set({ docs, docsError: null });
            const { copy } = conflict;
            if (copy) {
                set((s) => ({
                    docRevisions: { ...s.docRevisions, [id]: (s.docRevisions[id] ?? 0) + 1 },
                    notice: conflictNotice(copy.title),
                }));
            }
        },
        async reload() {
            let disk: DocMeta[];
            try {
                disk = await queued(readIndex);
            } catch (e) {
                set({ docsError: describeError(e) });
                return;
            }
            set((s) => {
                const docRevisions = { ...s.docRevisions };
                for (const d of disk) {
                    const known = s.docs.find((x) => x.id === d.id);
                    if (known && d.updatedAt > known.updatedAt)
                        docRevisions[d.id] = (docRevisions[d.id] ?? 0) + 1;
                }
                return { docs: disk, docRevisions, docsError: null };
            });
        },
    };

    const synced = (pages: PageSync): DocBackend => ({
        create: async (title) => fromPage(await pages.create(title)),
        async rename(id, title) {
            await pages.edit(id, { title });
        },
        async remove(id) {
            await pages.edit(id, { deleted: true });
            await get().loadTrash();
        },
        read: (id) => pages.read(id),
        async write(id, markdown) {
            await pages.edit(id, { content: markdown });
        },
        reload: () => pages.sync(),
    });

    const backend = () => {
        const pages = getPages();
        return pages ? synced(pages) : local;
    };

    return {
        docs: [],
        trash: [],
        unsynced: 0,
        docsError: null,
        docRevisions: {},

        async reloadFiles() {
            flushEdits();
            await backend().reload();
        },
        createDoc: (title = 'Untitled') => backend().create(title),
        renameDoc: (id, title) => backend().rename(id, title),
        deleteDoc: (id) => backend().remove(id),
        readDoc: (id) => backend().read(id),
        writeDoc: (id, markdown) => backend().write(id, markdown),

        async loadTrash() {
            const pages = getPages();
            if (!pages) return;
            const trashed = pages
                .list()
                .filter((p) => p.deletedAt !== null)
                .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
            const trash = await Promise.all(
                trashed.map(async (p) => ({
                    ...fromPage(p),
                    deletedAt: p.deletedAt ?? p.updatedAt,
                    // Code points, as the API's excerpt counts them.
                    excerpt: Array.from((await pages.read(p.id)).slice(0, EXCERPT * 2))
                        .slice(0, EXCERPT)
                        .join(''),
                })),
            );
            if (getPages() === pages) set({ trash });
        },

        async restoreDoc(id) {
            const pages = getPages();
            if (!pages) throw new Error('The trash needs the Lyfestyle API');
            const meta = fromPage(await pages.edit(id, { deleted: false }));
            await get().loadTrash();
            return meta;
        },
    };
};
