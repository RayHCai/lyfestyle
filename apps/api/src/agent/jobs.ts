import { Cron } from 'croner';
import { and, asc, desc, eq, isNotNull, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs, runs } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { Patch } from '../lib/types.js';
import type { Run, RunsService } from './runs.js';

export interface JobInput {
    name: string;
    prompt: string;
    /** Five- or six-field cron expression, evaluated in `timezone`. */
    schedule: string;
    timezone?: string | undefined;
    enabled?: boolean | undefined;
}

type Job = typeof jobs.$inferSelect;

export function isTimeZone(zone: string): boolean {
    try {
        // oxlint-disable-next-line no-new -- the constructor throws on an unknown zone
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

function cron(schedule: string, timezone: string): Cron {
    if (!isTimeZone(timezone)) throw badRequest(`Unknown time zone: ${timezone}`);
    try {
        return new Cron(schedule, { timezone, paused: true });
    } catch (err) {
        throw badRequest(`Invalid cron schedule: ${(err as Error).message}`);
    }
}

const nextRun = (job: Pick<Job, 'schedule' | 'timezone' | 'enabled'>, from: Date) =>
    job.enabled ? cron(job.schedule, job.timezone).nextRun(from) : null;

export type JobsService = ReturnType<typeof createJobsService>;

export function createJobsService(deps: { db: Db; runs: RunsService; now: () => Date }) {
    const { db, now } = deps;

    async function find(id: string): Promise<Job> {
        const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
        if (!row) throw notFound('Job');
        return row;
    }

    return {
        async list() {
            const [rows, latest] = await Promise.all([
                db.select().from(jobs).orderBy(asc(jobs.name)),
                db
                    .selectDistinctOn([runs.jobId], {
                        jobId: runs.jobId,
                        id: runs.id,
                        status: runs.status,
                        createdAt: runs.createdAt,
                        finishedAt: runs.finishedAt,
                    })
                    .from(runs)
                    .where(isNotNull(runs.jobId))
                    .orderBy(runs.jobId, desc(runs.createdAt)),
            ]);
            const byJob = new Map(latest.map(({ jobId, ...run }) => [jobId, run]));
            return rows.map((job) => ({ ...job, lastRun: byJob.get(job.id) ?? null }));
        },

        async get(id: string) {
            const job = await find(id);
            const recentRuns = await db
                .select()
                .from(runs)
                .where(eq(runs.jobId, id))
                .orderBy(desc(runs.createdAt))
                .limit(20);
            return { ...job, recentRuns };
        },

        async create(input: JobInput) {
            const job = {
                ...input,
                timezone: input.timezone ?? 'UTC',
                enabled: input.enabled ?? true,
            };
            const [row] = await db
                .insert(jobs)
                .values({
                    ...job,
                    nextRunAt: nextRun(job, now()),
                    createdAt: now(),
                    updatedAt: now(),
                })
                .returning();
            return row!;
        },

        async update(id: string, patch: Patch<JobInput>) {
            const current = await find(id);
            const next = {
                name: patch.name ?? current.name,
                prompt: patch.prompt ?? current.prompt,
                schedule: patch.schedule ?? current.schedule,
                timezone: patch.timezone ?? current.timezone,
                enabled: patch.enabled ?? current.enabled,
            };
            const timing =
                next.schedule !== current.schedule ||
                next.timezone !== current.timezone ||
                next.enabled !== current.enabled;
            const [row] = await db
                .update(jobs)
                .set({
                    ...next,
                    ...(timing ? { nextRunAt: nextRun(next, now()) } : {}),
                    updatedAt: now(),
                })
                .where(eq(jobs.id, id))
                .returning();
            return row!;
        },

        async remove(id: string) {
            const [row] = await db.delete(jobs).where(eq(jobs.id, id)).returning();
            if (!row) throw notFound('Job');
            return row;
        },

        /** Runs a job now, outside its schedule. */
        async trigger(id: string) {
            const queued = await db.transaction(async (tx) => {
                const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
                if (!job) throw notFound('Job');
                if (await deps.runs.hasActiveRun(tx, id)) {
                    throw conflict('This job already has a run queued or in progress');
                }
                await tx.update(jobs).set({ lastRunAt: now() }).where(eq(jobs.id, id));
                return deps.runs.enqueue(tx, { kind: 'job', prompt: job.prompt, jobId: id });
            });
            deps.runs.announce([queued]);
            return queued.run;
        },

        /**
         * Queues one run per due job and moves it to its next slot. Slots missed while the API was
         * down collapse into one run, and a job whose last run is still going skips the slot.
         */
        async enqueueDue(at: Date): Promise<Run[]> {
            const queued = await db.transaction(async (tx) => {
                const due = await tx
                    .select()
                    .from(jobs)
                    .where(and(eq(jobs.enabled, true), lte(jobs.nextRunAt, at)))
                    .for('update', { skipLocked: true });
                const out = [];
                for (const job of due) {
                    const busy = await deps.runs.hasActiveRun(tx, job.id);
                    if (!busy) {
                        out.push(
                            await deps.runs.enqueue(tx, {
                                kind: 'job',
                                prompt: job.prompt,
                                jobId: job.id,
                            }),
                        );
                    }
                    await tx
                        .update(jobs)
                        .set({ nextRunAt: nextRun(job, at), ...(busy ? {} : { lastRunAt: at }) })
                        .where(eq(jobs.id, job.id));
                }
                return out;
            });
            deps.runs.announce(queued);
            return queued.map((q) => q.run);
        },
    };
}
