import { DAY_MS, extractPageLinks, TRASH_DAYS } from '@lyfestyle/shared';
import { advisoryLock, Prisma, type Db, type Tx } from '../db/client.js';
import { conflict, notFound } from '../lib/errors.js';
import { keyset, paginate } from '../lib/pagination.js';

/** Serialises page writes so `seq` order is commit order and pulls never skip a write. */
const PAGE_WRITE_LOCK = 0x1f5e0001;

const EXCERPT_LENGTH = 200;

/** Everything but the body, which can be a megabyte: lists carry an excerpt instead. */
const summaryColumns = {
    id: true,
    title: true,
    icon: true,
    version: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
} as const;

const columns = { ...summaryColumns, content: true } as const;

export interface Page {
    id: string;
    title: string;
    content: string;
    icon: string | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
}

export interface PageDraft {
    title?: string | undefined;
    content?: string | undefined;
    icon?: string | null | undefined;
}

/** A page as one device last saw it, pushed while syncing. */
export interface PageChange {
    id: string;
    /** The server version this edit was made on, or null for a page the device created. */
    baseVersion: number | null;
    title: string;
    content: string;
    icon: string | null;
    deleted: boolean;
}

export type ChangeResult =
    | { id: string; status: 'applied'; page: Page }
    | { id: string; status: 'conflict'; page: Page }
    /** The page was purged from the trash, so there is no server copy left to rebase on. */
    | { id: string; status: 'gone' };

export type PagesService = ReturnType<typeof createPagesService>;

export function createPagesService(db: Db, now: () => Date) {
    function write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        return db.$transaction(async (tx) => {
            await advisoryLock(tx, PAGE_WRITE_LOCK);
            return fn(tx);
        });
    }

    function find(tx: Tx, id: string): Promise<Page | null> {
        return tx.page.findUnique({ where: { id }, select: columns });
    }

    async function setLinks(tx: Tx, sourceId: string, content: string) {
        await tx.pageLink.deleteMany({ where: { sourceId } });
        const targets = extractPageLinks(content);
        if (targets.length) {
            await tx.pageLink.createMany({
                data: targets.map((targetId) => ({ sourceId, targetId })),
            });
        }
    }

    /** Adds the first `EXCERPT_LENGTH` characters of each page's body, cut in SQL. */
    async function withExcerpts<T extends { id: string }>(rows: T[]) {
        if (!rows.length) return [];
        const ids = Prisma.join(rows.map((r) => Prisma.sql`${r.id}::uuid`));
        const found = await db.$queryRaw<{ id: string; excerpt: string }[]>`
            select id, left(content, ${EXCERPT_LENGTH}::int) as excerpt from pages
            where id in (${ids})`;
        const excerpts = new Map(found.map((r) => [r.id, r.excerpt]));
        return rows.map((row) => ({ ...row, excerpt: excerpts.get(row.id) ?? '' }));
    }

    async function insert(tx: Tx, id: string | undefined, draft: PageDraft, deleted = false) {
        // Every page write holds PAGE_WRITE_LOCK, so nothing can insert this id in between.
        if (id && (await find(tx, id))) throw conflict(`Page ${id} already exists`);
        const at = now();
        const row = await tx.page.create({
            data: {
                ...(id ? { id } : {}),
                title: draft.title ?? '',
                content: draft.content ?? '',
                icon: draft.icon ?? null,
                createdAt: at,
                updatedAt: at,
                deletedAt: deleted ? at : null,
            },
            select: columns,
        });
        await setLinks(tx, row.id, row.content);
        return row;
    }

    async function save(tx: Tx, current: Page, next: PageDraft & { deleted?: boolean }) {
        const title = next.title ?? current.title;
        const content = next.content ?? current.content;
        const icon = next.icon === undefined ? current.icon : next.icon;
        const deleted = next.deleted ?? current.deletedAt !== null;
        if (
            title === current.title &&
            content === current.content &&
            icon === current.icon &&
            deleted === (current.deletedAt !== null)
        ) {
            return current;
        }
        const at = now();
        const [allocated] = await tx.$queryRaw<
            { seq: bigint }[]
        >`select nextval('page_seq') as seq`;
        const row = await tx.page.update({
            where: { id: current.id },
            data: {
                title,
                content,
                icon,
                deletedAt: deleted ? (current.deletedAt ?? at) : null,
                version: current.version + 1,
                seq: allocated!.seq,
                updatedAt: at,
            },
            select: columns,
        });
        if (content !== current.content) await setLinks(tx, current.id, content);
        return row;
    }

    async function live(tx: Tx, id: string, baseVersion?: number) {
        const current = await find(tx, id);
        if (!current || current.deletedAt) throw notFound('Page');
        if (baseVersion !== undefined && baseVersion !== current.version) {
            throw conflict('Page changed since baseVersion', { page: current });
        }
        return current;
    }

    async function get(id: string, { includeDeleted = false } = {}) {
        const page = await find(db, id);
        if (!page || (page.deletedAt && !includeDeleted)) throw notFound('Page');
        return page;
    }

    /** Applies one device's edit. A retried push whose content already landed is not a conflict. */
    function applyChange(change: PageChange): Promise<ChangeResult> {
        return write(async (tx) => {
            const current = await find(tx, change.id);
            if (!current) {
                // Edited on a server version of a page that has since been purged from the trash.
                // Inserting it would resurrect a page every other device has dropped.
                if (change.baseVersion !== null) return { id: change.id, status: 'gone' };
                const page = await insert(tx, change.id, change, change.deleted);
                return { id: change.id, status: 'applied', page };
            }
            const same =
                current.title === change.title &&
                current.content === change.content &&
                current.icon === change.icon &&
                (current.deletedAt !== null) === change.deleted;
            if (same) return { id: change.id, status: 'applied', page: current };
            if (change.baseVersion !== current.version) {
                return { id: change.id, status: 'conflict', page: current };
            }
            const page = await save(tx, current, change);
            return { id: change.id, status: 'applied', page };
        });
    }

    return {
        get,

        create(input: PageDraft & { id?: string | undefined }) {
            return write((tx) => insert(tx, input.id, input));
        },

        update(id: string, draft: PageDraft, baseVersion?: number) {
            return write(async (tx) => save(tx, await live(tx, id, baseVersion), draft));
        },

        append(id: string, markdown: string) {
            return write(async (tx) => {
                const current = await live(tx, id);
                const body = current.content.trimEnd();
                return save(tx, current, { content: body ? `${body}\n\n${markdown}` : markdown });
            });
        },

        remove(id: string, baseVersion?: number) {
            return write(async (tx) =>
                save(tx, await live(tx, id, baseVersion), { deleted: true }),
            );
        },

        restore(id: string) {
            return write(async (tx) => {
                const current = await find(tx, id);
                if (!current) throw notFound('Page');
                return save(tx, current, { deleted: false });
            });
        },

        /**
         * Hard-deletes pages that have sat in the trash for over `TRASH_DAYS`. A sync client that
         * has not pulled since then never sees those deletions; see "Offline sync" in docs/api.md.
         */
        purgeTrash(at: Date) {
            const before = new Date(at.getTime() - TRASH_DAYS * DAY_MS);
            return write(async (tx) => {
                const { count } = await tx.page.deleteMany({
                    where: { deletedAt: { lt: before } },
                });
                return count;
            });
        },

        async list(options: { limit: number; cursor?: string | undefined; deleted?: boolean }) {
            const page = keyset('updatedAt', options);
            const rows = await db.page.findMany({
                ...page,
                where: { deletedAt: options.deleted ? { not: null } : null, ...page.where },
                select: summaryColumns,
            });
            const { items, nextCursor } = paginate(rows, options.limit, 'updatedAt');
            return { items: await withExcerpts(items), nextCursor };
        },

        /** Full-text match over title and body, plus substring match on titles for type-ahead. */
        async search(q: string, limit: number) {
            // The generated tsvector column is outside Prisma's types, so ranking is raw SQL.
            const hits = await db.$queryRaw<{ id: string; excerpt: string }[]>`
                select id, left(content, ${EXCERPT_LENGTH}::int) as excerpt
                from pages, websearch_to_tsquery('english', ${q}) as query
                where deleted_at is null
                    and (search @@ query or title ilike ${`%${escapeLike(q)}%`})
                order by ts_rank(search, query) desc, updated_at desc
                limit ${limit}::int`;
            const rows = await db.page.findMany({
                where: { id: { in: hits.map((h) => h.id) } },
                select: summaryColumns,
            });
            const byId = new Map(rows.map((r) => [r.id, r]));
            return hits.flatMap((h) => {
                const page = byId.get(h.id);
                return page ? [{ ...page, excerpt: h.excerpt }] : [];
            });
        },

        async backlinks(id: string) {
            await get(id);
            const rows = await db.page.findMany({
                where: { deletedAt: null, links: { some: { targetId: id } } },
                select: summaryColumns,
                orderBy: { updatedAt: 'desc' },
            });
            return withExcerpts(rows);
        },

        /** Links out of a page, including ones whose target is deleted or not synced yet. */
        async links(id: string) {
            await get(id);
            const links = await db.pageLink.findMany({
                where: { sourceId: id },
                select: { targetId: true },
            });
            const targets = await db.page.findMany({
                where: { id: { in: links.map((l) => l.targetId) } },
                select: { id: true, title: true, icon: true, deletedAt: true },
            });
            const byId = new Map(targets.map((t) => [t.id, t]));
            return links.map(({ targetId }) => {
                const target = byId.get(targetId);
                return {
                    id: targetId,
                    title: target?.title ?? null,
                    icon: target?.icon ?? null,
                    exists: target !== undefined && target.deletedAt === null,
                };
            });
        },

        async graph() {
            const nodes = await db.page.findMany({
                where: { deletedAt: null },
                select: { id: true, title: true, icon: true },
            });
            const ids = new Set(nodes.map((n) => n.id));
            const links = await db.pageLink.findMany({
                where: { source: { deletedAt: null } },
                select: { sourceId: true, targetId: true },
            });
            const edges = links.map((l) => ({ source: l.sourceId, target: l.targetId }));
            return { nodes, edges: edges.filter((e) => ids.has(e.target)) };
        },

        /**
         * Applies a device's edits in order, each in a write of its own so a large push never holds
         * the page write lock, or one transaction, for all of them.
         */
        async applyChanges(changes: PageChange[]) {
            const results: ChangeResult[] = [];
            for (const change of changes) results.push(await applyChange(change));
            return results;
        },

        /** Every page written after `cursor`, deletions included, in write order. */
        async changesSince(cursor: number, limit: number) {
            const rows = await db.page.findMany({
                where: { seq: { gt: cursor } },
                select: { ...columns, seq: true },
                orderBy: { seq: 'asc' },
                take: limit + 1,
            });
            const batch = rows.slice(0, limit);
            return {
                pages: batch.map(({ seq: _seq, ...page }) => page),
                cursor: String(batch.at(-1)?.seq ?? cursor),
                hasMore: rows.length > limit,
            };
        },
    };
}

/** Escapes `%`, `_` and `\` so user text matches literally inside an `ilike` pattern. */
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
