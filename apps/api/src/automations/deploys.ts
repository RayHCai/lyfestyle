import { lockRow, type Db, type DeployOrigin, type Row } from '../db/client.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { checkSchedule, nextRun } from './schedule.js';

export interface DeployInput {
    /** Omitted for a new automation. */
    automationId?: string | undefined;
    name: string;
    description?: string | undefined;
    schedule: string;
    timezone?: string | undefined;
    code: string;
}

/** Who proposed a deploy: the kind of agent run and its id, or `user` with no run. */
export interface ProposedBy {
    kind: DeployOrigin;
    runId: string | null;
}

/** The deployed version a proposal would replace (after approval, the one it became). */
const withCurrent = {
    automation: {
        select: { version: true, name: true, schedule: true, timezone: true, code: true },
    },
} as const;

/** Proposals and their approval: the only way code reaches an automation (ADR 0006). */
export function createDeploys(deps: { db: Db; now: () => Date }) {
    const { db, now } = deps;

    return {
        /**
         * Proposes a new automation or a new version of one. Nothing runs until the user approves
         * it. A newer proposal supersedes: older pending ones for the same automation are rejected.
         */
        async propose(input: DeployInput, origin: ProposedBy) {
            const timezone = input.timezone ?? 'UTC';
            checkSchedule(input.schedule, timezone, now());
            if (!/\bexport\s+default\b/.test(input.code)) {
                throw badRequest('The code must `export default` a function that takes ctx');
            }
            return db.$transaction(async (tx) => {
                if (input.automationId) {
                    // Serialises proposals for one automation, so exactly one stays pending.
                    await lockRow(tx, 'automations', input.automationId);
                    const exists = await tx.automation.findUnique({
                        where: { id: input.automationId },
                        select: { id: true },
                    });
                    if (!exists) throw notFound('Automation');
                    await tx.automationDeploy.updateMany({
                        where: { automationId: input.automationId, status: 'pending' },
                        data: { status: 'rejected', decidedAt: now() },
                    });
                }
                return tx.automationDeploy.create({
                    data: {
                        automationId: input.automationId ?? null,
                        name: input.name,
                        description: input.description ?? '',
                        schedule: input.schedule,
                        timezone,
                        code: input.code,
                        origin: origin.kind,
                        runId: origin.runId,
                        createdAt: now(),
                    },
                });
            });
        },

        /** Proposals with the version each would replace, newest first. */
        async list(status?: Row<'automationDeploy'>['status']) {
            const rows = await db.automationDeploy.findMany({
                where: status ? { status } : {},
                orderBy: { createdAt: 'desc' },
                take: 100,
                include: withCurrent,
            });
            return rows.map(({ automation, ...deploy }) => ({ ...deploy, current: automation }));
        },

        /** One proposal, e.g. for the prompt the chat shows where the agent made it. */
        async get(deployId: string) {
            const row = await db.automationDeploy.findUnique({
                where: { id: deployId },
                include: withCurrent,
            });
            if (!row) throw notFound('Deploy');
            const { automation, ...deploy } = row;
            return { ...deploy, current: automation };
        },

        async approve(deployId: string) {
            return db.$transaction(async (tx) => {
                const target = await tx.automationDeploy.findUnique({
                    where: { id: deployId },
                    select: { automationId: true },
                });
                if (!target) throw notFound('Deploy');
                // The automation before the deploy, the order propose() takes them in, so the two
                // cannot deadlock. A deploy's automationId only changes when this approves it.
                if (target.automationId) await lockRow(tx, 'automations', target.automationId);
                await lockRow(tx, 'automation_deploys', deployId);
                const deploy = await tx.automationDeploy.findUniqueOrThrow({
                    where: { id: deployId },
                });
                if (deploy.status !== 'pending') throw conflict(`This deploy is ${deploy.status}`);
                const at = now();
                const fields = {
                    name: deploy.name,
                    description: deploy.description,
                    schedule: deploy.schedule,
                    timezone: deploy.timezone,
                    code: deploy.code,
                    updatedAt: at,
                };
                await tx.automationDeploy.update({
                    where: { id: deployId },
                    data: { status: 'approved', decidedAt: at },
                });
                if (!deploy.automationId) {
                    const automation = await tx.automation.create({
                        data: {
                            ...fields,
                            enabled: true,
                            nextRunAt: nextRun({ ...fields, enabled: true }, at),
                            createdAt: at,
                        },
                    });
                    await tx.automationDeploy.update({
                        where: { id: deployId },
                        data: { automationId: automation.id },
                    });
                    return automation;
                }
                const current = await tx.automation.findUniqueOrThrow({
                    where: { id: deploy.automationId },
                });
                return tx.automation.update({
                    where: { id: current.id },
                    data: {
                        ...fields,
                        version: current.version + 1,
                        nextRunAt: nextRun({ ...fields, enabled: current.enabled }, at),
                    },
                });
            });
        },

        async reject(deployId: string) {
            const [row] = await db.automationDeploy.updateManyAndReturn({
                where: { id: deployId, status: 'pending' },
                data: { status: 'rejected', decidedAt: now() },
            });
            if (row) return row;
            const deploy = await db.automationDeploy.findUnique({ where: { id: deployId } });
            if (!deploy) throw notFound('Deploy');
            throw conflict(`This deploy is ${deploy.status}`);
        },
    };
}
