import {
    TERMINAL_RUN_STATUSES,
    type ModelUsageTotals,
    type RunEvent,
    type RunEventInput,
    type RunKind,
    type RunStatus,
} from '@lyfestyle/shared';
import { and, asc, desc, eq, gt, inArray, lt, notExists, sql, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import { conversations, jobs, messages, runEvents, runs, usageRecords } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { topics, type Notifier } from '../lib/notifier.js';
import { decodeCursor, paginate } from '../lib/pagination.js';

/** Serialises claims so two runners never take two turns of one conversation at once. */
const CLAIM_LOCK = 0x1f5e0002;

export type Run = typeof runs.$inferSelect;

export interface NewRun {
    kind: RunKind;
    prompt: string;
    conversationId?: string | null;
    jobId?: string | null;
}

export interface RunFilter {
    status?: RunStatus | undefined;
    kind?: RunKind | undefined;
    jobId?: string | undefined;
    conversationId?: string | undefined;
    limit: number;
    cursor?: string | undefined;
}

type StoredEvent = { type: string; data: Record<string, unknown> };

const ACTIVE: RunStatus[] = ['queued', 'running'];

function toEvent(row: typeof runEvents.$inferSelect): RunEvent {
    return {
        ...row.data,
        type: row.type,
        id: row.id,
        runId: row.runId,
        createdAt: row.createdAt.toISOString(),
    } as RunEvent;
}

function split({
    type,
    ...data
}: RunEventInput | { type: 'status'; status: RunStatus; error?: string }): StoredEvent {
    return { type, data };
}

export type RunsService = ReturnType<typeof createRunsService>;

export function createRunsService(deps: {
    db: Db;
    notifier: Notifier;
    now: () => Date;
    staleAfterMs: number;
}) {
    const { db, notifier, now } = deps;

    async function insertEvents(tx: Db, runId: string, events: StoredEvent[]) {
        if (!events.length) return [];
        const rows = await tx
            .insert(runEvents)
            .values(events.map((e) => ({ runId, ...e, createdAt: now() })))
            .returning();
        return rows.map(toEvent);
    }

    const statusEvent = (status: RunStatus, error?: string | null): StoredEvent =>
        split({ type: 'status', status, ...(error ? { error } : {}) });

    function publish(runId: string, events: RunEvent[]) {
        if (events.length) notifier.emit(topics.run(runId), events);
    }

    async function lockRun(tx: Db, id: string): Promise<Run> {
        const [run] = await tx.select().from(runs).where(eq(runs.id, id)).for('update');
        if (!run) throw notFound('Run');
        return run;
    }

    async function claim(input: { runnerId: string; harness: string }) {
        const result = await db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK})`);
            const busy = alias(runs, 'busy');
            const [next] = await tx
                .select({ id: runs.id })
                .from(runs)
                .where(
                    and(
                        eq(runs.status, 'queued'),
                        notExists(
                            tx
                                .select({ id: busy.id })
                                .from(busy)
                                .where(
                                    and(
                                        eq(busy.conversationId, runs.conversationId),
                                        eq(busy.status, 'running'),
                                    ),
                                ),
                        ),
                    ),
                )
                .orderBy(asc(runs.createdAt))
                .limit(1);
            if (!next) return null;
            const [run] = await tx
                .update(runs)
                .set({
                    status: 'running',
                    runnerId: input.runnerId,
                    harness: input.harness,
                    startedAt: now(),
                    heartbeatAt: now(),
                })
                .where(eq(runs.id, next.id))
                .returning();
            const events = await insertEvents(tx, run!.id, [statusEvent('running')]);
            return { run: run!, events };
        });
        if (!result) return null;
        publish(result.run.id, result.events);
        return context(result.run);
    }

    function sessionUsage(sessionId: string): Promise<ModelUsageTotals[]> {
        const sum = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)::float8`;
        return db
            .select({
                model: usageRecords.model,
                inputTokens: sum(usageRecords.inputTokens),
                outputTokens: sum(usageRecords.outputTokens),
                cacheReadTokens: sum(usageRecords.cacheReadTokens),
                cacheWriteTokens: sum(usageRecords.cacheWriteTokens),
                costUsd: sum(usageRecords.costUsd),
            })
            .from(usageRecords)
            .where(eq(usageRecords.sessionId, sessionId))
            .groupBy(usageRecords.model);
    }

    /** What a harness needs to pick a run up: the conversation so far, or the job it came from. */
    async function context(run: Run) {
        const [conversation] = run.conversationId
            ? await db.select().from(conversations).where(eq(conversations.id, run.conversationId))
            : [];
        const transcript = run.conversationId
            ? await db
                  .select({ role: messages.role, content: messages.content, runId: messages.runId })
                  .from(messages)
                  .where(eq(messages.conversationId, run.conversationId))
                  .orderBy(asc(messages.ordinal))
            : [];
        const cut = transcript.findIndex((m) => m.runId === run.id);
        const history = (cut === -1 ? transcript : transcript.slice(0, cut)).map(
            ({ role, content }) => ({ role, content }),
        );
        const [job] = run.jobId
            ? await db
                  .select({ id: jobs.id, name: jobs.name })
                  .from(jobs)
                  .where(eq(jobs.id, run.jobId))
            : [];
        const sessionId = conversation?.harness ? conversation.harnessSessionId : null;
        return {
            run,
            session: sessionId
                ? {
                      harness: conversation!.harness!,
                      sessionId,
                      usage: await sessionUsage(sessionId),
                  }
                : null,
            history,
            job: job ?? null,
        };
    }

    async function events(
        runId: string,
        options: { after?: number | undefined; type?: string | undefined; limit: number },
    ) {
        const rows = await db
            .select()
            .from(runEvents)
            .where(
                and(
                    eq(runEvents.runId, runId),
                    options.after ? gt(runEvents.id, options.after) : undefined,
                    options.type ? eq(runEvents.type, options.type) : undefined,
                ),
            )
            .orderBy(asc(runEvents.id))
            .limit(options.limit);
        return rows.map(toEvent);
    }

    return {
        /** Adds a queued run inside the caller's transaction; `announce` it once that commits. */
        async enqueue(tx: Db, input: NewRun) {
            const [run] = await tx
                .insert(runs)
                .values({
                    kind: input.kind,
                    prompt: input.prompt,
                    conversationId: input.conversationId ?? null,
                    jobId: input.jobId ?? null,
                    createdAt: now(),
                })
                .returning();
            const queued = await insertEvents(tx, run!.id, [statusEvent('queued')]);
            return { run: run!, events: queued };
        },

        announce(queued: { run: Run; events: RunEvent[] }[]) {
            for (const { run, events } of queued) publish(run.id, events);
            if (queued.length) notifier.emit(topics.runQueued);
        },

        hasActiveRun(tx: Db, jobId: string) {
            return tx
                .select({ id: runs.id })
                .from(runs)
                .where(and(eq(runs.jobId, jobId), inArray(runs.status, ACTIVE)))
                .limit(1)
                .then((rows) => rows.length > 0);
        },

        claim,

        /** Long-polls for a run; resolves null once `waitMs` passes with nothing queued. */
        async claimWait(
            input: { runnerId: string; harness: string },
            waitMs: number,
            signal?: AbortSignal,
        ) {
            const deadline = Date.now() + waitMs;
            for (;;) {
                const stopWaiting = new AbortController();
                const woke = notifier.wait(
                    topics.runQueued,
                    Math.max(0, deadline - Date.now()),
                    stopWaiting.signal,
                );
                const claimed = await claim(input);
                if (claimed || Date.now() >= deadline || signal?.aborted) {
                    stopWaiting.abort();
                    return claimed;
                }
                const onAbort = () => stopWaiting.abort();
                signal?.addEventListener('abort', onAbort, { once: true });
                await woke;
                signal?.removeEventListener('abort', onAbort);
            }
        },

        /** Records what a harness reported; answers whether the run should stop. */
        async report(runId: string, input: RunEventInput[]) {
            const { run, written } = await db.transaction(async (tx) => {
                const run = await lockRun(tx, runId);
                if (run.status !== 'running') throw conflict(`Run is ${run.status}, not running`);
                for (const event of input) {
                    if (event.type === 'message' && run.conversationId) {
                        await tx.insert(messages).values({
                            conversationId: run.conversationId,
                            runId,
                            role: event.role,
                            content: event.content,
                            createdAt: now(),
                        });
                    } else if (event.type === 'session' && run.conversationId) {
                        await tx
                            .update(conversations)
                            .set({ harness: event.harness, harnessSessionId: event.sessionId })
                            .where(eq(conversations.id, run.conversationId));
                    } else if (event.type === 'usage') {
                        await tx.insert(usageRecords).values({
                            runId,
                            kind: run.kind,
                            conversationId: run.conversationId,
                            jobId: run.jobId,
                            harness: run.harness ?? 'unknown',
                            sessionId: event.sessionId ?? null,
                            model: event.model,
                            inputTokens: event.inputTokens,
                            outputTokens: event.outputTokens,
                            cacheReadTokens: event.cacheReadTokens,
                            cacheWriteTokens: event.cacheWriteTokens,
                            costUsd: event.costUsd,
                            durationMs: event.durationMs ?? null,
                            createdAt: now(),
                        });
                    }
                }
                if (run.conversationId && input.some((e) => e.type === 'message')) {
                    await tx
                        .update(conversations)
                        .set({ updatedAt: now() })
                        .where(eq(conversations.id, run.conversationId));
                }
                const written = await insertEvents(tx, runId, input.map(split));
                await tx.update(runs).set({ heartbeatAt: now() }).where(eq(runs.id, runId));
                return { run, written };
            });
            publish(runId, written);
            return { cancelRequested: run.cancelRequested };
        },

        async heartbeat(runId: string) {
            const [run] = await db
                .update(runs)
                .set({ heartbeatAt: now() })
                .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
                .returning({ status: runs.status, cancelRequested: runs.cancelRequested });
            if (run) return run;
            const [current] = await db
                .select({ status: runs.status })
                .from(runs)
                .where(eq(runs.id, runId));
            if (!current) throw notFound('Run');
            return { status: current.status, cancelRequested: true };
        },

        async complete(
            runId: string,
            result: {
                status: 'succeeded' | 'failed' | 'cancelled';
                output?: string | undefined;
                error?: string | undefined;
            },
        ) {
            const { run, written } = await db.transaction(async (tx) => {
                const current = await lockRun(tx, runId);
                if (current.status !== 'running') {
                    throw conflict(`Run is ${current.status}, not running`);
                }
                const [run] = await tx
                    .update(runs)
                    .set({
                        status: result.status,
                        output: result.output ?? null,
                        error: result.error ?? null,
                        finishedAt: now(),
                    })
                    .where(eq(runs.id, runId))
                    .returning();
                const written = await insertEvents(tx, runId, [
                    statusEvent(result.status, result.error),
                ]);
                return { run: run!, written };
            });
            publish(runId, written);
            return run;
        },

        /** Drops a queued run outright; asks a running one to stop at its next report. */
        async cancel(runId: string) {
            const { run, written } = await db.transaction(async (tx) => {
                const current = await lockRun(tx, runId);
                if (current.status === 'queued') {
                    const [run] = await tx
                        .update(runs)
                        .set({ status: 'cancelled', cancelRequested: true, finishedAt: now() })
                        .where(eq(runs.id, runId))
                        .returning();
                    return {
                        run: run!,
                        written: await insertEvents(tx, runId, [statusEvent('cancelled')]),
                    };
                }
                if (current.status === 'running' && !current.cancelRequested) {
                    const [run] = await tx
                        .update(runs)
                        .set({ cancelRequested: true })
                        .where(eq(runs.id, runId))
                        .returning();
                    const log = split({
                        type: 'log',
                        level: 'info',
                        message: 'Cancellation requested',
                    });
                    return { run: run!, written: await insertEvents(tx, runId, [log]) };
                }
                return { run: current, written: [] };
            });
            publish(runId, written);
            return run;
        },

        /** Fails runs whose runner went quiet, so a crashed laptop does not wedge a conversation. */
        async reapStale(at: Date) {
            const cutoff = new Date(at.getTime() - deps.staleAfterMs);
            const reaped = await db.transaction(async (tx) => {
                const error = 'Runner stopped reporting';
                const rows = await tx
                    .update(runs)
                    .set({ status: 'failed', error, finishedAt: at })
                    .where(and(eq(runs.status, 'running'), lt(runs.heartbeatAt, cutoff)))
                    .returning({ id: runs.id });
                const out: { id: string; events: RunEvent[] }[] = [];
                for (const { id } of rows) {
                    out.push({
                        id,
                        events: await insertEvents(tx, id, [statusEvent('failed', error)]),
                    });
                }
                return out;
            });
            for (const { id, events: written } of reaped) publish(id, written);
            return reaped.map((r) => r.id);
        },

        async get(runId: string) {
            const [run] = await db.select().from(runs).where(eq(runs.id, runId));
            if (!run) throw notFound('Run');
            const [usage] = await db
                .select({
                    inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)::float8`,
                    outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::float8`,
                    cacheReadTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)::float8`,
                    cacheWriteTokens: sql<number>`coalesce(sum(${usageRecords.cacheWriteTokens}), 0)::float8`,
                    costUsd: sql<number>`coalesce(sum(${usageRecords.costUsd}), 0)::float8`,
                })
                .from(usageRecords)
                .where(eq(usageRecords.runId, runId));
            return { ...run, usage: usage! };
        },

        async list(filter: RunFilter) {
            const after = decodeCursor(filter.cursor);
            const rows = await db
                .select()
                .from(runs)
                .where(
                    and(
                        filter.status ? eq(runs.status, filter.status) : undefined,
                        filter.kind ? eq(runs.kind, filter.kind) : undefined,
                        filter.jobId ? eq(runs.jobId, filter.jobId) : undefined,
                        filter.conversationId
                            ? eq(runs.conversationId, filter.conversationId)
                            : undefined,
                        after
                            ? sql`(${runs.createdAt}, ${runs.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`
                            : undefined,
                    ),
                )
                .orderBy(desc(runs.createdAt), desc(runs.id))
                .limit(filter.limit + 1);
            return paginate(rows, filter.limit, (r) => ({ at: r.createdAt, id: r.id }));
        },

        events,

        subscribe(runId: string, listener: (events: RunEvent[]) => void) {
            return notifier.on(topics.run(runId), (payload) => listener(payload as RunEvent[]));
        },

        isTerminal(event: RunEvent) {
            return event.type === 'status' && TERMINAL_RUN_STATUSES.includes(event.status);
        },
    };
}
