import {
    TERMINAL_RUN_STATUSES,
    type ModelUsageTotals,
    type RunEvent,
    type RunEventInput,
    type RunKind,
    type RunStatus,
} from '@lyfestyle/shared';
import { advisoryLock, lockRow, type Db, type Prisma, type Row, type Tx } from '../db/client.js';
import type { SecretBox } from '../lib/crypto.js';
import { conflict, notFound } from '../lib/errors.js';
import { topics, type Notifier } from '../lib/notifier.js';
import { keyset, paginate } from '../lib/pagination.js';

/** Serialises claims so two runners never take two turns of one conversation at once. */
const CLAIM_LOCK = 0x1f5e0002;

/** A backstop only: an agent token stops working as soon as its run is no longer running. */
const AGENT_TOKEN_TTL_MS = 24 * 60 * 60_000;

/** Backlog rows read per query when following a run. */
const FOLLOW_PAGE = 500;

export type Run = Row<'run'>;

interface NewRun {
    kind: RunKind;
    prompt: string;
    conversationId?: string | null;
    automationRunId?: string | null;
    /** Defaults to the API's `RUN_BUDGET_USD`, and never exceeds it. */
    budgetUsd?: number;
}

interface RunFilter {
    status?: RunStatus | undefined;
    kind?: RunKind | undefined;
    automationRunId?: string | undefined;
    conversationId?: string | undefined;
    limit: number;
    cursor?: string | undefined;
}

interface ClaimInput {
    runnerId: string;
    harness: string;
    /** Only runs of these kinds; every kind when unset. */
    kinds?: RunKind[] | undefined;
}

type StoredEvent = { type: string; data: Record<string, unknown> };

const usageSums = {
    inputTokens: true,
    outputTokens: true,
    cacheReadTokens: true,
    cacheWriteTokens: true,
    costUsd: true,
} as const;

const totalsOf = (sum: { [K in keyof typeof usageSums]: number | null }) => ({
    inputTokens: sum.inputTokens ?? 0,
    outputTokens: sum.outputTokens ?? 0,
    cacheReadTokens: sum.cacheReadTokens ?? 0,
    cacheWriteTokens: sum.cacheWriteTokens ?? 0,
    costUsd: sum.costUsd ?? 0,
});

function toEvent(row: Row<'runEvent'>): RunEvent {
    return {
        ...row.data,
        type: row.type,
        id: row.id,
        runId: row.runId,
        createdAt: row.createdAt.toISOString(),
    } as RunEvent;
}

const ended = (status: RunStatus) => TERMINAL_RUN_STATUSES.includes(status);

const isTerminal = (event: RunEvent) => event.type === 'status' && ended(event.status);

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
    secrets: SecretBox;
    now: () => Date;
    staleAfterMs: number;
    budgetUsd: number;
}) {
    const { db, notifier, now } = deps;

    async function insertEvents(tx: Tx, runId: string, events: StoredEvent[]) {
        if (!events.length) return [];
        const rows = await tx.runEvent.createManyAndReturn({
            data: events.map((e) => ({
                runId,
                type: e.type,
                data: e.data as Prisma.InputJsonObject,
                createdAt: now(),
            })),
        });
        return rows.map(toEvent);
    }

    const statusEvent = (status: RunStatus, error?: string | null): StoredEvent =>
        split({ type: 'status', status, ...(error ? { error } : {}) });

    function publish(runId: string, events: RunEvent[]) {
        if (events.length) notifier.emit(topics.run(runId), events);
    }

    /** A turn ending can free its conversation's next queued turn, so wake waiting claims. */
    function finished(runs: { id: string; events: RunEvent[] }[]) {
        for (const { id, events } of runs) publish(id, events);
        if (runs.length) notifier.emit(topics.runQueued);
    }

    async function lockRun(tx: Tx, id: string): Promise<Run> {
        await lockRow(tx, 'runs', id);
        const run = await tx.run.findUnique({ where: { id } });
        if (!run) throw notFound('Run');
        return run;
    }

    async function claim(input: ClaimInput) {
        const result = await db.$transaction(async (tx) => {
            await advisoryLock(tx, CLAIM_LOCK);
            const next = await tx.run.findFirst({
                where: {
                    status: 'queued',
                    ...(input.kinds ? { kind: { in: input.kinds } } : {}),
                    OR: [
                        { conversationId: null },
                        { conversation: { runs: { none: { status: 'running' } } } },
                    ],
                },
                orderBy: { createdAt: 'asc' },
                select: { id: true },
            });
            if (!next) return null;
            const run = await tx.run.update({
                where: { id: next.id },
                data: {
                    status: 'running',
                    runnerId: input.runnerId,
                    harness: input.harness,
                    startedAt: now(),
                    heartbeatAt: now(),
                },
            });
            const events = await insertEvents(tx, run.id, [statusEvent('running')]);
            return { run, events };
        });
        if (!result) return null;
        publish(result.run.id, result.events);
        return {
            ...(await context(result.run)),
            // What the harness gives the agent for the lyfestyle MCP server: it reaches only the
            // tools, and only while this run is running.
            agentToken: deps.secrets.sign(
                { kind: 'agent', runId: result.run.id },
                AGENT_TOKEN_TTL_MS,
            ),
        };
    }

    async function sessionUsage(sessionId: string): Promise<ModelUsageTotals[]> {
        const groups = await db.usageRecord.groupBy({
            by: ['model'],
            where: { sessionId },
            _sum: usageSums,
        });
        return groups.map(({ model, _sum: sum }) => ({ model, ...totalsOf(sum) }));
    }

    /** What a harness needs to pick a run up: the conversation so far, or the automation behind it. */
    async function context(run: Run) {
        const conversation = run.conversationId
            ? await db.conversation.findUnique({ where: { id: run.conversationId } })
            : null;
        const transcript = run.conversationId
            ? await db.message.findMany({
                  where: { conversationId: run.conversationId },
                  select: { role: true, content: true, runId: true, ordinal: true },
                  orderBy: { ordinal: 'asc' },
              })
            : [];
        // Earlier turns can still be answering while this one waits, so their replies land after
        // this turn's message: leave out this turn and those queued after it, not a suffix.
        const start = transcript.find((m) => m.runId === run.id && m.role === 'user')?.ordinal;
        const later = new Set<string | null>([run.id]);
        for (const m of transcript) {
            if (m.role === 'user' && start !== undefined && m.ordinal > start) later.add(m.runId);
        }
        later.delete(null);
        const history = transcript
            .filter((m) => !later.has(m.runId))
            .map(({ role, content }) => ({ role, content }));
        const automation = run.automationRunId
            ? ((
                  await db.automationRun.findUnique({
                      where: { id: run.automationRunId },
                      select: { automation: { select: { id: true, name: true } } },
                  })
              )?.automation ?? null)
            : null;
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
            automation,
        };
    }

    /** What the matching runs have reported spending. */
    async function spent(where: Prisma.RunWhereInput, tx: Tx = db) {
        const { _sum: sum } = await tx.usageRecord.aggregate({
            where: { run: where },
            _sum: { costUsd: true },
        });
        return sum.costUsd ?? 0;
    }

    async function automationOf(tx: Tx, run: Run) {
        if (!run.automationRunId) return null;
        const parent = await tx.automationRun.findUnique({
            where: { id: run.automationRunId },
            select: { automationId: true },
        });
        return parent?.automationId ?? null;
    }

    async function events(
        runId: string,
        options: { after?: number | undefined; type?: string | undefined; limit: number },
    ) {
        const rows = await db.runEvent.findMany({
            where: {
                runId,
                ...(options.after ? { id: { gt: options.after } } : {}),
                ...(options.type ? { type: options.type } : {}),
            },
            orderBy: { id: 'asc' },
            take: options.limit,
        });
        return rows.map(toEvent);
    }

    /** Drops a queued run outright; asks a running one to stop at its next report. */
    async function cancel(runId: string) {
        const { run, written } = await db.$transaction(async (tx) => {
            const current = await lockRun(tx, runId);
            if (current.status === 'queued') {
                const run = await tx.run.update({
                    where: { id: runId },
                    data: { status: 'cancelled', cancelRequested: true, finishedAt: now() },
                });
                return {
                    run,
                    written: await insertEvents(tx, runId, [statusEvent('cancelled')]),
                };
            }
            if (current.status === 'running' && !current.cancelRequested) {
                const run = await tx.run.update({
                    where: { id: runId },
                    data: { cancelRequested: true },
                });
                const log = split({
                    type: 'log',
                    level: 'info',
                    message: 'Cancellation requested',
                });
                return { run, written: await insertEvents(tx, runId, [log]) };
            }
            return { run: current, written: [] };
        });
        if (ended(run.status)) finished([{ id: runId, events: written }]);
        else publish(runId, written);
        return run;
    }

    return {
        /** Adds a queued run inside the caller's transaction; `announce` it once that commits. */
        async enqueue(tx: Tx, input: NewRun) {
            const run = await tx.run.create({
                data: {
                    kind: input.kind,
                    prompt: input.prompt,
                    conversationId: input.conversationId ?? null,
                    automationRunId: input.automationRunId ?? null,
                    budgetUsd: Math.min(input.budgetUsd ?? deps.budgetUsd, deps.budgetUsd),
                    createdAt: now(),
                },
            });
            const queued = await insertEvents(tx, run.id, [statusEvent('queued')]);
            return { run, events: queued };
        },

        announce(queued: { run: Run; events: RunEvent[] }[]) {
            for (const { run, events } of queued) publish(run.id, events);
            if (queued.length) notifier.emit(topics.runQueued);
        },

        /**
         * Long-polls for a run; resolves null once `waitMs` passes with nothing queued, or as soon
         * as `signal` aborts, so a runner that hung up is never handed a run.
         */
        async claimWait(input: ClaimInput, waitMs: number, signal?: AbortSignal) {
            const deadline = Date.now() + waitMs;
            for (;;) {
                if (signal?.aborted) return null;
                const stopWaiting = new AbortController();
                const woke = notifier.wait(
                    topics.runQueued,
                    Math.max(0, deadline - Date.now()),
                    stopWaiting.signal,
                );
                const claimed = await claim(input);
                if (claimed || Date.now() >= deadline) {
                    stopWaiting.abort();
                    return claimed;
                }
                const onAbort = () => stopWaiting.abort();
                signal?.addEventListener('abort', onAbort, { once: true });
                await woke;
                signal?.removeEventListener('abort', onAbort);
            }
        },

        /** The run an agent token was minted for, while that run is running; otherwise null. */
        async authorize(token: string): Promise<{ id: string; kind: RunKind } | null> {
            const payload = deps.secrets.verify<{ kind?: unknown; runId?: unknown }>(token);
            if (payload?.kind !== 'agent' || typeof payload.runId !== 'string') return null;
            const run = await db.run.findUnique({
                where: { id: payload.runId },
                select: { id: true, kind: true, status: true },
            });
            return run?.status === 'running' ? { id: run.id, kind: run.kind } : null;
        },

        /**
         * Records what a harness reported; answers whether the run should stop, which it should
         * once its usage passes its budget, or once the agent runs of its automation run together
         * pass `RUN_BUDGET_USD`.
         */
        async report(runId: string, input: RunEventInput[]) {
            const { run, written, sharedSpent } = await db.$transaction(async (tx) => {
                const run = await lockRun(tx, runId);
                if (run.status !== 'running') throw conflict(`Run is ${run.status}, not running`);
                for (const event of input) {
                    if (event.type === 'message' && run.conversationId) {
                        await tx.message.create({
                            data: {
                                conversationId: run.conversationId,
                                runId,
                                role: event.role,
                                content: event.content as unknown as Prisma.InputJsonArray,
                                createdAt: now(),
                            },
                        });
                    } else if (event.type === 'session' && run.conversationId) {
                        await tx.conversation.update({
                            where: { id: run.conversationId },
                            data: { harness: event.harness, harnessSessionId: event.sessionId },
                        });
                    } else if (event.type === 'usage') {
                        await tx.usageRecord.create({
                            data: {
                                runId,
                                kind: run.kind,
                                conversationId: run.conversationId,
                                automationId: await automationOf(tx, run),
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
                            },
                        });
                    }
                }
                if (run.conversationId && input.some((e) => e.type === 'message')) {
                    await tx.conversation.update({
                        where: { id: run.conversationId },
                        data: { updatedAt: now() },
                    });
                }
                const stored = input.map(split);
                const stop = (message: string) =>
                    stored.push(split({ type: 'log', level: 'warn', message }));
                let cancelRequested = run.cancelRequested;
                let sharedSpent = 0;
                if (!cancelRequested && input.some((e) => e.type === 'usage')) {
                    const own = await spent({ id: runId }, tx);
                    if (run.automationRunId) {
                        sharedSpent = await spent({ automationRunId: run.automationRunId }, tx);
                    }
                    if (own > run.budgetUsd) {
                        cancelRequested = true;
                        stop(
                            `Stopped: spent $${own.toFixed(2)} of a $${run.budgetUsd.toFixed(2)} budget`,
                        );
                    } else if (sharedSpent > deps.budgetUsd) {
                        cancelRequested = true;
                        stop(
                            `Stopped: the agent runs of this automation run spent $${sharedSpent.toFixed(2)} of their shared $${deps.budgetUsd.toFixed(2)} budget`,
                        );
                    }
                }
                const written = await insertEvents(tx, runId, stored);
                await tx.run.update({
                    where: { id: runId },
                    data: { heartbeatAt: now(), cancelRequested },
                });
                return { run: { ...run, cancelRequested }, written, sharedSpent };
            });
            publish(runId, written);
            if (run.automationRunId && sharedSpent > deps.budgetUsd) {
                // One sibling at a time, after this run's lock is released: two runs crossing the
                // shared budget together must not deadlock on each other's rows.
                const siblings = await db.run.findMany({
                    where: {
                        automationRunId: run.automationRunId,
                        id: { not: runId },
                        status: { in: ['queued', 'running'] },
                    },
                    select: { id: true },
                });
                for (const { id } of siblings) await cancel(id);
            }
            return { cancelRequested: run.cancelRequested };
        },

        async heartbeat(runId: string) {
            const [run] = await db.run.updateManyAndReturn({
                where: { id: runId, status: 'running' },
                data: { heartbeatAt: now() },
                select: { status: true, cancelRequested: true },
            });
            if (run) return run;
            const current = await db.run.findUnique({
                where: { id: runId },
                select: { status: true },
            });
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
            const { run, written } = await db.$transaction(async (tx) => {
                const current = await lockRun(tx, runId);
                if (current.status !== 'running') {
                    throw conflict(`Run is ${current.status}, not running`);
                }
                const run = await tx.run.update({
                    where: { id: runId },
                    data: {
                        status: result.status,
                        output: result.output ?? null,
                        error: result.error ?? null,
                        finishedAt: now(),
                    },
                });
                const written = await insertEvents(tx, runId, [
                    statusEvent(result.status, result.error),
                ]);
                return { run, written };
            });
            finished([{ id: runId, events: written }]);
            return run;
        },

        cancel,

        /**
         * Cancels every queued or running turn of a conversation outright, so its streams and a
         * runner's next report see it end before the conversation is deleted.
         */
        async cancelConversation(conversationId: string) {
            const stopped = await db.$transaction(async (tx) => {
                const rows = await tx.run.updateManyAndReturn({
                    where: { conversationId, status: { in: ['queued', 'running'] } },
                    data: { status: 'cancelled', cancelRequested: true, finishedAt: now() },
                    select: { id: true },
                });
                const out: { id: string; events: RunEvent[] }[] = [];
                for (const { id } of rows) {
                    out.push({
                        id,
                        events: await insertEvents(tx, id, [statusEvent('cancelled')]),
                    });
                }
                return out;
            });
            finished(stopped);
            return stopped.map((r) => r.id);
        },

        /** Fails runs whose runner went quiet, so a crashed laptop does not wedge a conversation. */
        async reapStale(at: Date) {
            const cutoff = new Date(at.getTime() - deps.staleAfterMs);
            const reaped = await db.$transaction(async (tx) => {
                const error = 'Runner stopped reporting';
                const rows = await tx.run.updateManyAndReturn({
                    where: { status: 'running', heartbeatAt: { lt: cutoff } },
                    data: { status: 'failed', error, finishedAt: at },
                    select: { id: true },
                });
                const out: { id: string; events: RunEvent[] }[] = [];
                for (const { id } of rows) {
                    out.push({
                        id,
                        events: await insertEvents(tx, id, [statusEvent('failed', error)]),
                    });
                }
                return out;
            });
            finished(reaped);
            return reaped.map((r) => r.id);
        },

        async get(runId: string) {
            const run = await db.run.findUnique({ where: { id: runId } });
            if (!run) throw notFound('Run');
            const { _sum: usage } = await db.usageRecord.aggregate({
                where: { runId },
                _sum: usageSums,
            });
            return { ...run, usage: totalsOf(usage) };
        },

        async list(filter: RunFilter) {
            const page = keyset('createdAt', filter);
            const rows = await db.run.findMany({
                ...page,
                where: {
                    ...(filter.status ? { status: filter.status } : {}),
                    ...(filter.kind ? { kind: filter.kind } : {}),
                    ...(filter.automationRunId ? { automationRunId: filter.automationRunId } : {}),
                    ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
                    ...page.where,
                },
            });
            return paginate(rows, filter.limit, 'createdAt');
        },

        events,

        /**
         * Every event of the run after `after`, stored and live, in id order with none skipped or
         * repeated. Ends after the terminal status, or when `signal` aborts. Yields null after
         * `idleMs` without an event, so a stream can send a keepalive.
         */
        async *follow(
            runId: string,
            after: number,
            options: { signal: AbortSignal; idleMs: number },
        ): AsyncGenerator<RunEvent | null> {
            const { signal, idleMs } = options;
            // Subscribed before the first read, so every event is in the backlog, the live buffer
            // or both; anything at or below the cursor has been sent already.
            const live: RunEvent[] = [];
            let wake = () => {};
            const off = notifier.on(topics.run(runId), (payload) => {
                live.push(...(payload as RunEvent[]));
                wake();
            });
            const poke = () => wake();
            signal.addEventListener('abort', poke);
            let cursor = after;
            try {
                const run = await db.run.findUnique({
                    where: { id: runId },
                    select: { status: true },
                });
                if (!run) return;
                for (;;) {
                    // Live events wait in their buffer until the backlog is read to its end, so
                    // the cursor never passes rows a later page would have returned.
                    const page = await events(runId, { after: cursor, limit: FOLLOW_PAGE });
                    for (const event of page) {
                        cursor = event.id;
                        yield event;
                        if (isTerminal(event)) return;
                    }
                    if (page.length < FOLLOW_PAGE) break;
                    if (signal.aborted) return;
                }
                // It had ended before the backlog was read, so this client resumed after the end.
                if (ended(run.status)) return;
                while (!signal.aborted) {
                    const ready = live.splice(0).sort((a, b) => a.id - b.id);
                    for (const event of ready) {
                        if (event.id <= cursor) continue;
                        cursor = event.id;
                        yield event;
                        if (isTerminal(event)) return;
                    }
                    if (live.length) continue;
                    const woke = await new Promise<boolean>((resolve) => {
                        const timer = setTimeout(() => resolve(false), idleMs);
                        wake = () => {
                            clearTimeout(timer);
                            resolve(true);
                        };
                        if (signal.aborted) wake();
                    });
                    wake = () => {};
                    if (!woke) yield null;
                }
            } finally {
                off();
                signal.removeEventListener('abort', poke);
            }
        },

        /** Resolves with the run once it ends, or null if `signal` aborts first. */
        async waitFor(runId: string, signal: AbortSignal): Promise<Run | null> {
            let wake = () => {};
            const poke = () => wake();
            const off = notifier.on(topics.run(runId), poke);
            signal.addEventListener('abort', poke);
            try {
                while (!signal.aborted) {
                    // Armed before the read, so an event landing in between still wakes us.
                    const woke = new Promise<void>((resolve) => (wake = resolve));
                    const run = await db.run.findUnique({ where: { id: runId } });
                    if (!run) throw notFound('Run');
                    if (ended(run.status)) return run;
                    await woke;
                }
                return null;
            } finally {
                off();
                signal.removeEventListener('abort', poke);
            }
        },

        /** What these runs have spent together, e.g. the agent runs of one automation run. */
        costOf: (runIds: string[]) => spent({ id: { in: runIds } }),
    };
}
