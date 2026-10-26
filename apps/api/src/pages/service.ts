import { extractPageLinks } from '@lyfestyle/shared';
import { and, asc, desc, eq, gt, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pageLinks, pages } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { decodeCursor, paginate } from '../lib/pagination.js';
import { escapeLike } from '../lib/validate.js';

/** Serialises page writes so `seq` order is commit order and pulls never skip a write. */
const PAGE_WRITE_LOCK = 0x1f5e0001;

const columns = {
    id: pages.id,
    title: pages.title,
    content: pages.content,
    icon: pages.icon,
    version: pages.version,
    createdAt: pages.createdAt,
    updatedAt: pages.updatedAt,
    deletedAt: pages.deletedAt,
};

const summaryColumns = {
    id: pages.id,
    title: pages.title,
    icon: pages.icon,
    excerpt: sql<string>`left(${pages.content}, 200)`,
    version: pages.version,
    createdAt: pages.createdAt,
    updatedAt: pages.updatedAt,
    deletedAt: pages.deletedAt,
};

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
    { id: string; status: 'applied'; page: Page } | { id: string; status: 'conflict'; page: Page };

export type PagesService = ReturnType<typeof createPagesService>;

export function createPagesService(db: Db) {
    function write<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        return db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(${PAGE_WRITE_LOCK})`);
            return fn(tx);
        });
    }

    async function find(tx: Db, id: string): Promise<Page | undefined> {
        const [row] = await tx.select(columns).from(pages).where(eq(pages.id, id));
        return row;
    }

    async function setLinks(tx: Db, sourceId: string, content: string) {
        await tx.delete(pageLinks).where(eq(pageLinks.sourceId, sourceId));
        const targets = extractPageLinks(content);
        if (targets.length) {
            await tx.insert(pageLinks).values(targets.map((targetId) => ({ sourceId, targetId })));
        }
    }

    async function insert(tx: Db, id: string | undefined, draft: PageDraft, deleted = false) {
        const [row] = await tx
            .insert(pages)
            .values({
                ...(id ? { id } : {}),
                title: draft.title ?? '',
                content: draft.content ?? '',
                icon: draft.icon ?? null,
                deletedAt: deleted ? new Date() : null,
            })
            .onConflictDoNothing()
            .returning(columns);
        if (!row) throw conflict(`Page ${id} already exists`);
        await setLinks(tx, row.id, row.content);
        return row;
    }

    async function save(tx: Db, current: Page, next: PageDraft & { deleted?: boolean }) {
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
        const now = new Date();
        const [row] = await tx
            .update(pages)
            .set({
                title,
                content,
                icon,
                deletedAt: deleted ? (current.deletedAt ?? now) : null,
                version: current.version + 1,
                seq: sql`nextval('page_seq')`,
                updatedAt: now,
            })
            .where(eq(pages.id, current.id))
            .returning(columns);
        if (content !== current.content) await setLinks(tx, current.id, content);
        return row!;
    }

    async function live(tx: Db, id: string, baseVersion?: number) {
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

        async list(options: { limit: number; cursor?: string | undefined; deleted?: boolean }) {
            const after = decodeCursor(options.cursor);
            const rows = await db
                .select(summaryColumns)
                .from(pages)
                .where(
                    and(
                        options.deleted ? isNotNull(pages.deletedAt) : isNull(pages.deletedAt),
                        after
                            ? sql`(${pages.updatedAt}, ${pages.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`
                            : undefined,
                    ),
                )
                .orderBy(desc(pages.updatedAt), desc(pages.id))
                .limit(options.limit + 1);
            return paginate(rows, options.limit, (r) => ({ at: r.updatedAt, id: r.id }));
        },

        /** Full-text match over title and body, plus substring match on titles for type-ahead. */
        search(q: string, limit: number) {
            const query = sql`websearch_to_tsquery('english', ${q})`;
            return db
                .select(summaryColumns)
                .from(pages)
                .where(
                    and(
                        isNull(pages.deletedAt),
                        or(
                            sql`${pages.search} @@ ${query}`,
                            ilike(pages.title, `%${escapeLike(q)}%`),
                        ),
                    ),
                )
                .orderBy(desc(sql`ts_rank(${pages.search}, ${query})`), desc(pages.updatedAt))
                .limit(limit);
        },

        async backlinks(id: string) {
            await get(id);
            return db
                .select(summaryColumns)
                .from(pageLinks)
                .innerJoin(pages, eq(pages.id, pageLinks.sourceId))
                .where(and(eq(pageLinks.targetId, id), isNull(pages.deletedAt)))
                .orderBy(desc(pages.updatedAt));
        },

        /** Links out of a page, including ones whose target is deleted or not synced yet. */
        async links(id: string) {
            await get(id);
            const rows = await db
                .select({
                    id: pageLinks.targetId,
                    title: pages.title,
                    icon: pages.icon,
                    deletedAt: pages.deletedAt,
                })
                .from(pageLinks)
                .leftJoin(pages, eq(pages.id, pageLinks.targetId))
                .where(eq(pageLinks.sourceId, id));
            return rows.map((r) => ({
                id: r.id,
                title: r.title,
                icon: r.icon,
                exists: r.title !== null && r.deletedAt === null,
            }));
        },

        async graph() {
            const nodes = await db
                .select({ id: pages.id, title: pages.title, icon: pages.icon })
                .from(pages)
                .where(isNull(pages.deletedAt));
            const ids = new Set(nodes.map((n) => n.id));
            const edges = await db
                .select({ source: pageLinks.sourceId, target: pageLinks.targetId })
                .from(pageLinks)
                .innerJoin(pages, eq(pages.id, pageLinks.sourceId))
                .where(isNull(pages.deletedAt));
            return { nodes, edges: edges.filter((e) => ids.has(e.target)) };
        },

        /** Applies one device's edit. A retried push whose content already landed is not a conflict. */
        applyChange(change: PageChange): Promise<ChangeResult> {
            return write(async (tx) => {
                const current = await find(tx, change.id);
                if (!current) {
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
        },

        /** Every page written after `cursor`, deletions included, in write order. */
        async changesSince(cursor: number, limit: number) {
            const rows = await db
                .select({ ...columns, seq: pages.seq })
                .from(pages)
                .where(gt(pages.seq, cursor))
                .orderBy(asc(pages.seq))
                .limit(limit + 1);
            const batch = rows.slice(0, limit);
            return {
                pages: batch.map(({ seq: _seq, ...page }) => page),
                cursor: String(batch.at(-1)?.seq ?? cursor),
                hasMore: rows.length > limit,
            };
        },
    };
}
