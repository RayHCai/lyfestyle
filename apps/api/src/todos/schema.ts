import { isoDate } from '@lyfestyle/shared';
import { z } from 'zod';

/** Todo and goal fields, shared by the HTTP routes and the agent's tools. */
export const todoFields = {
    title: z.string().trim().min(1).max(500),
    notes: z.string().max(10_000).nullable(),
    scope: z.enum(['day', 'week']),
    date: isoDate,
    goalId: z.uuid().nullable(),
    position: z.number().finite(),
    completed: z.boolean(),
};

export const goalFields = {
    title: z.string().trim().min(1).max(500),
    notes: z.string().max(10_000).nullable(),
    month: isoDate,
    color: z.string().trim().min(1).max(32),
    position: z.number().finite(),
    completed: z.boolean(),
};

export const todoInput = z.object({
    title: todoFields.title,
    notes: todoFields.notes.optional(),
    scope: todoFields.scope,
    date: todoFields.date,
    goalId: todoFields.goalId.optional(),
    position: todoFields.position.optional(),
});

export const todoPatch = z.object(todoFields).partial();

export const goalInput = z.object({
    title: goalFields.title,
    notes: goalFields.notes.optional(),
    month: goalFields.month,
    color: goalFields.color.optional(),
    position: goalFields.position.optional(),
});

export const goalPatch = z.object(goalFields).partial();

export const dateRange = z.object({ from: isoDate, to: isoDate });
