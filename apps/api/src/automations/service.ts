import type { Row } from '../db/client.js';
import { conflict, notFound } from '../lib/errors.js';
import { createDeploys } from './deploys.js';
import { createExecutor, type ExecutorDeps } from './executor.js';
import { createQueries } from './queries.js';
import { nextRun } from './schedule.js';

export type { DeployInput, ProposedBy } from './deploys.js';

type Automation = Row<'automation'>;

export type AutomationsService = ReturnType<typeof createAutomationsService>;

/**
 * Automations (ADR 0006): the deploy workflow in `deploys.ts`, execution in `executor.ts` (the
 * `ctx` helpers in `helpers.ts`, the child process in `sandbox.ts`), reads in `queries.ts`, and
 * here the scheduling and lifecycle that tie them together.
 */
export function createAutomationsService(deps: ExecutorDeps) {
    const { db, now } = deps;
    const deploys = createDeploys(deps);
    const queries = createQueries(deps);
    const executor = createExecutor(deps);

    async function find(id: string): Promise<Automation> {
        const row = await db.automation.findUnique({ where: { id } });
        if (!row) throw notFound('Automation');
        return row;
    }

    return {
        list: queries.list,
        get: queries.get,
        timeline: queries.timeline,

        propose: deploys.propose,
        deploys: deploys.list,
        deploy: deploys.get,
        approve: deploys.approve,
        reject: deploys.reject,

        /**
         * Pausing and resuming need no approval: neither changes what the code does. Pausing also
         * stops a run in progress, which is recorded as cancelled.
         */
        async setEnabled(id: string, enabled: boolean) {
            const current = await find(id);
            const updated = await db.automation.update({
                where: { id },
                data: {
                    enabled,
                    nextRunAt: nextRun({ ...current, enabled }, now()),
                    updatedAt: now(),
                },
            });
            if (!enabled) await executor.stop(id, 'The automation was paused');
            return updated;
        },

        async remove(id: string) {
            await find(id);
            // Stopped first, so its agent runs are cancelled while they still point at its run.
            await executor.stop(id, 'The automation was deleted');
            return db.automation.delete({ where: { id } });
        },

        /** Runs the approved code now, outside its schedule. */
        async trigger(id: string) {
            const run = await executor.start(await find(id), 'manual');
            if (!run) throw conflict('This automation is already running');
            return { ...run, costUsd: 0 };
        },

        /**
         * Starts every due automation and moves it to its next slot. Slots missed while the API
         * was down collapse into one run, and one still running skips the slot. One automation
         * that cannot be scheduled or started does not hold up the others.
         */
        async startDue(at: Date) {
            const { due, broken } = await db.$transaction(async (tx) => {
                const locked = await tx.$queryRaw<{ id: string }[]>`
                    select id from automations where enabled and next_run_at <= ${at}
                    for update skip locked`;
                const rows = await tx.automation.findMany({
                    where: { id: { in: locked.map((a) => a.id) } },
                });
                const due: Automation[] = [];
                const broken: { automation: Automation; error: string }[] = [];
                for (const automation of rows) {
                    let next: Date | null;
                    try {
                        next = nextRun(automation, at);
                    } catch (err) {
                        // Left alone it would come due on every tick; pause it until a new deploy.
                        await tx.automation.update({
                            where: { id: automation.id },
                            data: { enabled: false, nextRunAt: null, updatedAt: at },
                        });
                        broken.push({
                            automation,
                            error: `Paused: its schedule no longer works. ${(err as Error).message}`,
                        });
                        continue;
                    }
                    await tx.automation.update({
                        where: { id: automation.id },
                        data: { nextRunAt: next },
                    });
                    due.push(automation);
                }
                return { due, broken };
            });
            for (const { automation, error } of broken) {
                await executor.recordFailure(automation, error).catch((err: unknown) => {
                    console.error(`Could not record that automation ${automation.id} broke`, err);
                });
            }
            const started: Row<'automationRun'>[] = [];
            for (const automation of due) {
                try {
                    const run = await executor.start(automation, 'schedule');
                    if (run) started.push(run);
                } catch (err) {
                    console.error(`Could not start automation ${automation.id}`, err);
                }
            }
            return started;
        },

        /**
         * Fails runs an earlier process left `running`, which can never finish, and cancels the
         * agent runs they started. Call once at startup.
         */
        async recover(at: Date) {
            const orphans = await db.automationRun.updateManyAndReturn({
                where: { status: 'running', id: { notIn: executor.runIds() } },
                data: {
                    status: 'failed',
                    error: 'The API restarted during this run',
                    finishedAt: at,
                },
                select: { id: true },
            });
            await executor.cancelAgentRuns(orphans.map((r) => r.id));
            return orphans.length;
        },

        /** Stops every execution in this process; each is recorded as cancelled with `reason`. */
        stopAll: executor.stopAll,

        /** Resolves once nothing is executing; for tests and shutdown. */
        idle: executor.idle,
    };
}
