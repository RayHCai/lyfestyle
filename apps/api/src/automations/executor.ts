import { TERMINAL_RUN_STATUSES } from '@lyfestyle/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AutomationLog, Prisma, Row } from '../db/client.js';
import { badRequest } from '../lib/errors.js';
import { HELPERS, plain, type Execution, type HelperDeps } from './helpers.js';
import { runInSandbox, SandboxError } from './sandbox.js';

type Automation = Row<'automation'>;
type AutomationRun = Row<'automationRun'>;

export interface ExecutorDeps extends HelperDeps {
    now: () => Date;
}

const MAX_LOGS = 500;
const MAX_LOG_CHARS = 4000;
const MAX_OUTPUT_CHARS = 100_000;

// A Map, so a crafted name such as `constructor` finds nothing rather than Object's own.
const helpers = new Map(HELPERS.map((h) => [h.name, h]));
const helperNames = HELPERS.map((h) => h.name);

interface Outcome {
    status: 'succeeded' | 'failed' | 'cancelled';
    output?: string;
    error?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type Executor = ReturnType<typeof createExecutor>;

/** Starts, tracks and stops executions of automation code, and records how each ended. */
export function createExecutor(deps: ExecutorDeps) {
    const { db, runs, config, now } = deps;
    /** Executions in this process, by automation id. The API is a single replica (ADR 0003). */
    const active = new Map<
        string,
        { runId: string; abort: AbortController; done: Promise<void> }
    >();

    async function notifyFailure(automation: Automation, error: string) {
        await deps.notifications.create({
            title: `${automation.name} failed`,
            body: error.split('\n')[0]?.slice(0, 300),
            source: automation.name,
            automationId: automation.id,
        });
    }

    /** Cancels the agent runs these automation runs started that have not finished. */
    async function cancelAgentRuns(automationRunIds: string[]) {
        if (!automationRunIds.length) return;
        const open = await db.run.findMany({
            where: {
                automationRunId: { in: automationRunIds },
                status: { notIn: [...TERMINAL_RUN_STATUSES] },
            },
            select: { id: true },
        });
        for (const { id } of open) {
            await runs.cancel(id).catch((err: unknown) => {
                console.error(`Could not cancel agent run ${id}`, err);
            });
        }
    }

    /**
     * What an execution's next agent run may spend: the shared budget less what its finished
     * agent runs spent and what its unfinished ones may still spend.
     */
    async function budgetLeft(automationRunId: string) {
        const agentRuns = await db.run.findMany({
            where: { automationRunId },
            select: { id: true, status: true, budgetUsd: true },
        });
        const finished = agentRuns.filter((r) => TERMINAL_RUN_STATUSES.includes(r.status));
        const held = agentRuns
            .filter((r) => !TERMINAL_RUN_STATUSES.includes(r.status))
            .reduce((sum, r) => sum + r.budgetUsd, 0);
        return config.runBudgetUsd - held - (await runs.costOf(finished.map((r) => r.id)));
    }

    async function enqueueAgent(
        run: AutomationRun,
        signal: AbortSignal,
        prompt: string,
        budgetUsd: number | undefined,
    ) {
        if (signal.aborted) throw new Error('The run is over');
        const left = await budgetLeft(run.id);
        if (left < 0.01) {
            throw badRequest(
                `No budget left: this run's agent calls have spent or hold all of its $${config.runBudgetUsd.toFixed(2)}`,
            );
        }
        const queued = await db.$transaction((tx) =>
            runs.enqueue(tx, {
                kind: 'automation',
                prompt,
                automationRunId: run.id,
                budgetUsd: Math.min(budgetUsd ?? left, left),
            }),
        );
        runs.announce([queued]);
        return queued.run;
    }

    async function call(x: Execution, method: string, args: unknown[]) {
        const helper = helpers.get(method);
        if (!helper) throw badRequest(`No helper ctx.${method}`);
        // A call that lands after the run ended must not act for it any more.
        if (x.signal.aborted) throw new Error('The run is over');
        const parsed = helper.args.safeParse(args);
        if (!parsed.success) {
            throw badRequest(
                `Invalid arguments to ctx.${method}: ${z.prettifyError(parsed.error)}`,
            );
        }
        return plain(await helper.run(parsed.data, x, deps));
    }

    async function execute(automation: Automation, run: AutomationRun, abort: AbortController) {
        const logs: AutomationLog[] = [];
        let over = false;
        const log = (level: AutomationLog['level'], text: string) => {
            if (over) return;
            if (logs.length === MAX_LOGS) {
                logs.push({ at: now().toISOString(), level: 'warn', message: 'Log truncated' });
            }
            if (logs.length > MAX_LOGS) return;
            logs.push({ at: now().toISOString(), level, message: text.slice(0, MAX_LOG_CHARS) });
        };

        let budget: Promise<unknown> = Promise.resolve();
        const enqueues = new Set<Promise<unknown>>();
        const x: Execution = {
            automation,
            run,
            signal: abort.signal,
            log,
            enqueueAgent(prompt, budgetUsd) {
                // One at a time, so calls made in parallel each see what the earlier ones hold.
                const queued = budget.then(() =>
                    enqueueAgent(run, abort.signal, prompt, budgetUsd),
                );
                budget = queued.catch(() => {});
                // Tracked before anyone awaits it, so the cleanup below cannot miss the run.
                enqueues.add(budget);
                return queued;
            },
        };

        let outcome: Outcome;
        try {
            const { output } = await runInSandbox({
                code: automation.code,
                automation: {
                    id: automation.id,
                    name: automation.name,
                    version: automation.version,
                    timezone: automation.timezone,
                    runId: run.id,
                    trigger: run.trigger,
                    startedAt: run.startedAt.toISOString(),
                },
                state: automation.state,
                helpers: helperNames,
                host: { log, call: (method, args) => call(x, method, args) },
                timeoutMs: config.automationTimeoutMs,
                signal: abort.signal,
            });
            outcome = {
                status: 'succeeded',
                ...(output ? { output: output.slice(0, MAX_OUTPUT_CHARS) } : {}),
            };
        } catch (err) {
            outcome =
                err instanceof SandboxError && err.kind === 'aborted'
                    ? { status: 'cancelled', error: err.message }
                    : { status: 'failed', error: message(err) };
        }

        // Helpers still going (a ctx.agent waiting for its run) stop with the code.
        abort.abort('The run is over');
        try {
            await Promise.all(enqueues);
            // Agent runs it left behind would otherwise keep spending with nobody waiting for them.
            await cancelAgentRuns([run.id]);
        } catch (err) {
            console.error(`Could not cancel the agent runs of automation run ${run.id}`, err);
        }
        over = true;

        try {
            // Conditional, so a run recover() already gave up on stays as it was marked.
            await db.automationRun.updateMany({
                where: { id: run.id, status: 'running' },
                data: {
                    status: outcome.status,
                    output: outcome.output ?? null,
                    error: outcome.error ?? null,
                    logs: logs as unknown as Prisma.InputJsonArray,
                    finishedAt: now(),
                },
            });
            // Cancelled runs were stopped on purpose (deleted, paused, shut down): no one to tell.
            if (outcome.status === 'failed') await notifyFailure(automation, outcome.error ?? '');
        } catch (err) {
            console.error(`Could not record automation run ${run.id}`, err);
        }
    }

    return {
        /**
         * Creates the run row and starts the code in the background; resolves null if the
         * automation is already running here. The caller holds no lock.
         */
        async start(automation: Automation, trigger: AutomationRun['trigger']) {
            if (active.has(automation.id)) return null;
            // Claimed in memory before the insert so a concurrent trigger cannot start a second one.
            const runId = randomUUID();
            const abort = new AbortController();
            let release = () => {};
            const done = new Promise<void>((resolve) => (release = resolve));
            active.set(automation.id, { runId, abort, done });
            try {
                // One transaction, so a failure cannot leave a `running` row nothing will finish.
                const run = await db.$transaction(async (tx) => {
                    const created = await tx.automationRun.create({
                        data: {
                            id: runId,
                            automationId: automation.id,
                            version: automation.version,
                            trigger,
                            startedAt: now(),
                        },
                    });
                    await tx.automation.update({
                        where: { id: automation.id },
                        data: { lastRunAt: created.startedAt },
                    });
                    return created;
                });
                void execute(automation, run, abort)
                    .catch((err: unknown) => console.error(`Automation run ${run.id} broke`, err))
                    .finally(() => {
                        active.delete(automation.id);
                        release();
                    });
                return run;
            } catch (err) {
                active.delete(automation.id);
                release();
                throw err;
            }
        },

        /** Records a run that never started, e.g. because its schedule broke, and says so. */
        async recordFailure(automation: Automation, error: string) {
            const at = now();
            await db.automationRun.create({
                data: {
                    automationId: automation.id,
                    version: automation.version,
                    trigger: 'schedule',
                    status: 'failed',
                    error,
                    startedAt: at,
                    finishedAt: at,
                },
            });
            await notifyFailure(automation, error);
        },

        cancelAgentRuns,

        /** The automation runs executing in this process. */
        runIds: () => [...active.values()].map((a) => a.runId),

        /** Stops an automation's execution, if any, and waits for it to be recorded as cancelled. */
        async stop(automationId: string, reason: string) {
            const execution = active.get(automationId);
            if (!execution) return;
            execution.abort.abort(reason);
            await execution.done;
        },

        /** Stops every execution in this process and waits for each to record its outcome. */
        async stopAll(reason: string) {
            const running = [...active.values()];
            for (const a of running) a.abort.abort(reason);
            await Promise.all(running.map((a) => a.done));
        },

        /** Resolves once nothing is executing; for tests and shutdown. */
        async idle() {
            while (active.size) await Promise.all([...active.values()].map((a) => a.done));
        },
    };
}
