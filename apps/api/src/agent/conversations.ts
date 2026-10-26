import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations, messages, runs } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { decodeCursor, paginate } from '../lib/pagination.js';
import type { RunsService } from './runs.js';

const TITLE_LENGTH = 80;

function titleFrom(text: string): string {
    const line = text.trim().split('\n')[0]!.trim();
    return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

export type ConversationsService = ReturnType<typeof createConversationsService>;

export function createConversationsService(deps: { db: Db; runs: RunsService; now: () => Date }) {
    const { db, now } = deps;

    async function find(id: string) {
        const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
        if (!row) throw notFound('Conversation');
        return row;
    }

    return {
        async list(options: { limit: number; cursor?: string | undefined }) {
            const after = decodeCursor(options.cursor);
            const rows = await db
                .select()
                .from(conversations)
                .where(
                    after
                        ? sql`(${conversations.updatedAt}, ${conversations.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`
                        : undefined,
                )
                .orderBy(desc(conversations.updatedAt), desc(conversations.id))
                .limit(options.limit + 1);
            return paginate(rows, options.limit, (r) => ({ at: r.updatedAt, id: r.id }));
        },

        async create(input: { title?: string | undefined }) {
            const [row] = await db
                .insert(conversations)
                .values({ title: input.title ?? null, createdAt: now(), updatedAt: now() })
                .returning();
            return row!;
        },

        /** The conversation with its full transcript and any turn still in flight. */
        async get(id: string) {
            const conversation = await find(id);
            const [transcript, active] = await Promise.all([
                db
                    .select()
                    .from(messages)
                    .where(eq(messages.conversationId, id))
                    .orderBy(asc(messages.ordinal)),
                db
                    .select()
                    .from(runs)
                    .where(
                        and(
                            eq(runs.conversationId, id),
                            inArray(runs.status, ['queued', 'running']),
                        ),
                    )
                    .orderBy(asc(runs.createdAt)),
            ]);
            return { ...conversation, messages: transcript, activeRuns: active };
        },

        async rename(id: string, title: string) {
            await find(id);
            const [row] = await db
                .update(conversations)
                .set({ title, updatedAt: now() })
                .where(eq(conversations.id, id))
                .returning();
            return row!;
        },

        async remove(id: string) {
            const [row] = await db
                .delete(conversations)
                .where(eq(conversations.id, id))
                .returning();
            if (!row) throw notFound('Conversation');
            return row;
        },

        /** Stores the user's message and queues the agent turn that answers it. */
        async send(id: string, text: string) {
            const result = await db.transaction(async (tx) => {
                const [conversation] = await tx
                    .select()
                    .from(conversations)
                    .where(eq(conversations.id, id))
                    .for('update');
                if (!conversation) throw notFound('Conversation');
                const queued = await deps.runs.enqueue(tx, {
                    kind: 'chat',
                    prompt: text,
                    conversationId: id,
                });
                const [message] = await tx
                    .insert(messages)
                    .values({
                        conversationId: id,
                        runId: queued.run.id,
                        role: 'user',
                        content: [{ type: 'text', text }],
                        createdAt: now(),
                    })
                    .returning();
                await tx
                    .update(conversations)
                    .set({ updatedAt: now(), title: conversation.title ?? titleFrom(text) })
                    .where(eq(conversations.id, id));
                return { message: message!, queued };
            });
            deps.runs.announce([result.queued]);
            return { message: result.message, run: result.queued.run };
        },
    };
}
