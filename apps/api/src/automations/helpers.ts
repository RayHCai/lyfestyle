import { z } from 'zod';
import type { Run, RunsService } from '../agent/runs.js';
import type { Config } from '../config.js';
import type { AutomationLog, Db, Prisma, Row } from '../db/client.js';
import { emailFields } from '../integrations/schema.js';
import type { Resend } from '../integrations/resend.js';
import { badRequest } from '../lib/errors.js';
import { notificationFields } from '../notifications/schema.js';
import type { NotificationsService } from '../notifications/service.js';

/** What the helpers reach in the API. */
export interface HelperDeps {
    db: Db;
    runs: RunsService;
    notifications: NotificationsService;
    resend: Resend;
    /** The agent tool registry, late-bound because the automation tools themselves live in it. */
    callTool: (name: string, input: unknown) => Promise<unknown>;
    config: Config;
}

/** The execution a helper call belongs to. */
export interface Execution {
    automation: Row<'automation'>;
    run: Row<'automationRun'>;
    /** Aborts once the run is over, whatever ended it; helpers stop waiting when it does. */
    signal: AbortSignal;
    log(level: AutomationLog['level'], message: string): void;
    /** Queues an agent run with what is left of the execution's shared budget. */
    enqueueAgent(prompt: string, budgetUsd: number | undefined): Promise<Run>;
}

export interface GuideLimits {
    budgetUsd: number;
    timeoutMs: number;
}

/**
 * One `ctx` helper. The host dispatches calls by `name`, the child builds `ctx` from the names, and
 * the agent's guide lists the `doc` lines, so a new helper is one entry in `HELPERS`.
 */
export interface Helper<S extends z.ZodType = z.ZodType> {
    /** Its path on ctx: `email` is `ctx.email`, `state.set` is `ctx.state.set`. */
    name: string;
    /** The positional arguments, as JSON delivered them: an `undefined` argument arrives as null. */
    args: S;
    doc(limits: GuideLimits): string;
    run(args: z.output<S>, x: Execution, deps: HelperDeps): Promise<unknown>;
}

const helper = <S extends z.ZodType>(h: Helper<S>): Helper<S> => h;

/** Dates become strings and class instances plain objects, as they would over HTTP. */
export const plain = (value: unknown): unknown =>
    value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);

const email = z.object({
    ...emailFields,
    // Unlike the email_send tool, an automation mails the user (NOTIFY_EMAIL) unless told otherwise.
    to: z.union([z.email(), emailFields.to]).optional(),
});

export const HELPERS: readonly Helper[] = [
    helper({
        name: 'email',
        args: z.tuple([email]),
        doc: () =>
            "ctx.email({ subject, text?, html?, to?, cc?, bcc?, replyTo? }): send email; to defaults to the user's own address.",
        async run([{ to, ...message }], x, deps) {
            const recipients = to ?? deps.config.notifyEmail;
            if (!recipients) throw badRequest('No recipient: pass `to`, or set NOTIFY_EMAIL');
            const sent = await deps.resend.send({
                ...message,
                to: typeof recipients === 'string' ? [recipients] : recipients,
            });
            x.log('info', `Emailed ${sent.to.join(', ')}: ${message.subject}`);
            return sent;
        },
    }),
    helper({
        name: 'notify',
        args: z.tuple([
            z.union([
                notificationFields.title.transform((title) => ({ title })),
                z.object(notificationFields),
            ]),
        ]),
        doc: () =>
            "ctx.notify({ title, body? }) or ctx.notify('title'): a desktop notification in the Lyfestyle app.",
        async run([message], x, deps) {
            const sent = await deps.notifications.create({
                ...message,
                source: x.automation.name,
                automationId: x.automation.id,
            });
            return { id: sent.id };
        },
    }),
    helper({
        name: 'agent',
        args: z.tuple([
            z.string().trim().min(1).max(100_000),
            z.object({ budgetUsd: z.number().positive().optional() }).nullish(),
        ]),
        doc: ({ budgetUsd }) =>
            `ctx.agent(prompt, { budgetUsd? }): run the Claude agent (with all Lyfestyle tools and the user's connectors) on the user's runner and wait for its final text. Use it only for work that needs judgement or the user's Gmail/Calendar; it is slow and costs money. All agent calls in one run share a $${budgetUsd.toFixed(2)} budget: each call gets what earlier calls have not spent or still hold (calls made in parallel split it), and a call fails once nothing is left.`,
        async run([prompt, options], x, deps) {
            const queued = await x.enqueueAgent(prompt, options?.budgetUsd);
            x.log('info', `Started agent run ${queued.id}`);
            const finished = await deps.runs.waitFor(queued.id, x.signal);
            if (!finished) throw new Error('Stopped while waiting for the agent');
            if (finished.status !== 'succeeded') {
                throw new Error(
                    `Agent run ${finished.status}${finished.error ? `: ${finished.error}` : ''}`,
                );
            }
            return finished.output ?? '';
        },
    }),
    helper({
        name: 'tool',
        args: z.tuple([z.string().min(1).max(200), z.unknown().optional()]),
        doc: () =>
            'ctx.tool(name, input): call a Lyfestyle tool directly (pages_*, todos_*, goals_*, canvas_*, ...), with the same input as the tool itself. Prefer this to ctx.agent when no judgement is needed. Tools that manage automations themselves (deploy, run, pause, delete) are not available to automation code.',
        run: ([name, input], _x, deps) => deps.callTool(name, input ?? {}),
    }),
    helper({
        name: 'state.set',
        args: z.tuple([z.unknown().optional()]),
        doc: () =>
            'ctx.state.get() / await ctx.state.set(value): JSON kept between runs, e.g. ids already seen. It starts as {}; set(null) resets it to {}.',
        async run([value], x, deps) {
            // What get() returns from now on, in this run and the next: the child adopts it.
            const state = (plain(value) ?? {}) as Prisma.InputJsonValue;
            await deps.db.automation.update({ where: { id: x.automation.id }, data: { state } });
            return state;
        },
    }),
];
