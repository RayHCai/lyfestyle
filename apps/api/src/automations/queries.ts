import type { AutomationRunStatus, Db, Row } from '../db/client.js';
import { notFound } from '../lib/errors.js';
import { slotsBetween } from './schedule.js';

type AutomationRun = Row<'automationRun'>;

/** What the automation list shows of each one's newest run. */
interface LastRun {
    id: string;
    automationId: string;
    status: AutomationRunStatus;
    startedAt: Date;
    finishedAt: Date | null;
}

/** Reads over automations and their runs. */
export function createQueries(deps: { db: Db; now: () => Date }) {
    const { db, now } = deps;

    async function withCost<T extends AutomationRun>(rows: T[]) {
        if (!rows.length) return [];
        const agentRuns = await db.run.findMany({
            where: { automationRunId: { in: rows.map((r) => r.id) } },
            select: { id: true, automationRunId: true },
        });
        const groups = await db.usageRecord.groupBy({
            by: ['runId'],
            where: { runId: { in: agentRuns.map((r) => r.id) } },
            _sum: { costUsd: true },
        });
        const byRun = new Map(groups.map(({ runId, _sum: sum }) => [runId, sum.costUsd ?? 0]));
        const cost = new Map<string, number>();
        for (const r of agentRuns) {
            const parent = r.automationRunId!;
            cost.set(parent, (cost.get(parent) ?? 0) + (byRun.get(r.id) ?? 0));
        }
        return rows.map((row) => ({ ...row, costUsd: cost.get(row.id) ?? 0 }));
    }

    return {
        withCost,

        async list() {
            const [automations, latest] = await Promise.all([
                db.automation.findMany({
                    orderBy: { name: 'asc' },
                    omit: { code: true, state: true },
                }),
                // The newest run of each, without logs or output, which can run to megabytes: the
                // app polls this list. Prisma would load every run to apply `take` itself.
                db.$queryRaw<LastRun[]>`
                    select r.id, a.id as "automationId", r.status,
                           r.started_at as "startedAt", r.finished_at as "finishedAt"
                    from automations a
                    cross join lateral (
                        select id, status, started_at, finished_at from automation_runs
                        where automation_id = a.id
                        order by started_at desc
                        limit 1
                    ) r`,
            ]);
            const last = new Map(latest.map(({ automationId, ...run }) => [automationId, run]));
            return automations.map((automation) => ({
                ...automation,
                lastRun: last.get(automation.id) ?? null,
            }));
        },

        async get(id: string) {
            const automation = await db.automation.findUnique({ where: { id } });
            if (!automation) throw notFound('Automation');
            const recent = await db.automationRun.findMany({
                where: { automationId: id },
                orderBy: { startedAt: 'desc' },
                take: 20,
            });
            return { ...automation, recentRuns: await withCost(recent) };
        },

        /** Runs that started in [from, to), and the scheduled slots still ahead in that window. */
        async timeline(from: Date, to: Date) {
            const [rows, automations] = await Promise.all([
                db.automationRun.findMany({
                    where: { startedAt: { gte: from, lt: to } },
                    orderBy: { startedAt: 'asc' },
                    include: { automation: { select: { name: true } } },
                    take: 2000,
                }),
                db.automation.findMany({
                    where: { enabled: true },
                    select: { id: true, name: true, schedule: true, timezone: true, enabled: true },
                }),
            ]);
            const start = new Date(Math.max(from.getTime(), now().getTime()));
            const slots = (a: (typeof automations)[number]) => {
                try {
                    return slotsBetween(a, start, to);
                } catch {
                    // A stored schedule that no longer parses; the scheduler pauses it when due.
                    return [];
                }
            };
            const upcoming = automations
                .flatMap((a) => slots(a).map((at) => ({ automationId: a.id, name: a.name, at })))
                .sort((a, b) => a.at.getTime() - b.at.getTime());
            const costed = await withCost(rows);
            return {
                runs: costed.map(({ automation, ...run }) => ({ ...run, name: automation.name })),
                upcoming,
            };
        },
    };
}
