import { lockRow, type Db, type Tx } from '../db/client.js';
import { conflict, notFound } from '../lib/errors.js';
import { keyset, paginate } from '../lib/pagination.js';
import type { RunsService } from './runs.js';

const TITLE_LENGTH = 80;

function titleFrom(text: string): string {
    const line = text.trim().split('\n')[0]!.trim();
    return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

export function createConversationsService(deps: { db: Db; runs: RunsService; now: () => Date }) {
    const { db, now } = deps;

    async function find(id: string) {
        const row = await db.conversation.findUnique({ where: { id } });
        if (!row) throw notFound('Conversation');
        return row;
    }

    /** Drops user message `from` and everything after it. Refused while a turn is in flight. */
    async function rewind(tx: Tx, id: string, from: string) {
        const at = await tx.message.findFirst({
            where: { id: from, conversationId: id, role: 'user' },
        });
        if (!at) throw notFound('Message');
        const busy = await tx.run.count({
            where: { conversationId: id, status: { in: ['queued', 'running'] } },
        });
        if (busy) throw conflict('Stop the turn in progress before editing the conversation');
        await tx.message.deleteMany({
            where: { conversationId: id, ordinal: { gte: at.ordinal } },
        });
    }

    return {
        async list(options: { limit: number; cursor?: string | undefined }) {
            const rows = await db.conversation.findMany(keyset('updatedAt', options));
            return paginate(rows, options.limit, 'updatedAt');
        },

        create(input: { title?: string | undefined }) {
            return db.conversation.create({
                data: { title: input.title ?? null, createdAt: now(), updatedAt: now() },
            });
        },

        /** The conversation with its full transcript and any turn still in flight. */
        async get(id: string) {
            const conversation = await find(id);
            const [transcript, active] = await Promise.all([
                db.message.findMany({ where: { conversationId: id }, orderBy: { ordinal: 'asc' } }),
                db.run.findMany({
                    where: { conversationId: id, status: { in: ['queued', 'running'] } },
                    orderBy: { createdAt: 'asc' },
                }),
            ]);
            return { ...conversation, messages: transcript, activeRuns: active };
        },

        async rename(id: string, title: string) {
            await find(id);
            return db.conversation.update({ where: { id }, data: { title, updatedAt: now() } });
        },

        /**
         * Deletes it with its messages and runs. A turn still queued or running is cancelled
         * first, so its stream ends and its runner, now answered 404, stops.
         */
        async remove(id: string) {
            await find(id);
            await deps.runs.cancelConversation(id);
            return db.conversation.delete({ where: { id } });
        },

        /**
         * Stores the user's message and queues the agent turn that answers it. With `from`, the
         * id of an earlier user message, the transcript is first cut back to before that message:
         * this is how a message is edited or a reply retried.
         */
        async send(id: string, text: string, from?: string) {
            const result = await db.$transaction(async (tx) => {
                await lockRow(tx, 'conversations', id);
                const conversation = await tx.conversation.findUnique({ where: { id } });
                if (!conversation) throw notFound('Conversation');
                if (from) await rewind(tx, id, from);
                const queued = await deps.runs.enqueue(tx, {
                    kind: 'chat',
                    prompt: text,
                    conversationId: id,
                });
                const message = await tx.message.create({
                    data: {
                        conversationId: id,
                        runId: queued.run.id,
                        role: 'user',
                        content: [{ type: 'text', text }],
                        createdAt: now(),
                    },
                });
                await tx.conversation.update({
                    where: { id },
                    data: {
                        updatedAt: now(),
                        title: conversation.title ?? titleFrom(text),
                        // The harness session remembers the dropped turns, so the next run starts
                        // a fresh one from what is left of the transcript.
                        ...(from ? { harness: null, harnessSessionId: null } : {}),
                    },
                });
                return { message, queued };
            });
            deps.runs.announce([result.queued]);
            return { message: result.message, run: result.queued.run };
        },
    };
}
