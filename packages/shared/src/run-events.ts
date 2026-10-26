import { z } from 'zod';

export const contentBlock = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('thinking'), text: z.string() }),
    z.object({
        type: z.literal('tool_use'),
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
    }),
    z.object({
        type: z.literal('tool_result'),
        toolUseId: z.string(),
        content: z.string(),
        isError: z.boolean().optional(),
    }),
]);
export type ContentBlock = z.infer<typeof contentBlock>;

export const messageRole = z.enum(['user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof messageRole>;

export const runKind = z.enum(['chat', 'job']);
export type RunKind = z.infer<typeof runKind>;

export const runStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof runStatus>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export const logLevel = z.enum(['debug', 'info', 'warn', 'error']);

const tokens = z.number().int().nonnegative();

/** An event a harness reports while it executes a run. */
export const runEventInput = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('message'),
        role: z.enum(['assistant', 'tool']),
        content: z.array(contentBlock).min(1),
    }),
    z.object({
        type: z.literal('log'),
        level: logLevel,
        message: z.string(),
        data: z.unknown().optional(),
    }),
    z.object({
        type: z.literal('session'),
        harness: z.string().min(1),
        sessionId: z.string().min(1),
    }),
    z.object({
        type: z.literal('usage'),
        model: z.string().min(1),
        inputTokens: tokens,
        outputTokens: tokens,
        cacheReadTokens: tokens,
        cacheWriteTokens: tokens,
        costUsd: z.number().nonnegative(),
        durationMs: z.number().int().nonnegative().optional(),
        /** The harness session that spent it, so a resumed session's totals can be differenced. */
        sessionId: z.string().min(1).optional(),
    }),
]);

/** What one model has used so far, summed over a harness session's earlier runs. */
export interface ModelUsageTotals {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
}
export type RunEventInput = z.infer<typeof runEventInput>;

/** Written by the API itself whenever a run changes status. */
export interface StatusEvent {
    type: 'status';
    status: RunStatus;
    error?: string;
}

export type RunEventType = RunEventInput['type'] | 'status';

export type RunEvent = (RunEventInput | StatusEvent) & {
    id: number;
    runId: string;
    createdAt: string;
};
