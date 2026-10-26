import { isoDate } from '@lyfestyle/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';

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

const range = z.object({ from: isoDate, to: isoDate });
const byId = validate('param', z.object({ id: z.uuid() }));

export const todosRoutes = ({ todos }: Services) =>
    new Hono()
        .basePath('/todos')
        .get('/board', validate('query', z.object({ today: isoDate })), async (c) =>
            c.json(await todos.board(c.req.valid('query').today)),
        )
        .get(
            '/',
            validate('query', range.extend({ scope: todoFields.scope.optional() })),
            async (c) => c.json({ items: await todos.listTodos(c.req.valid('query')) }),
        )
        .post('/', validate('json', todoInput), async (c) =>
            c.json(await todos.createTodo(c.req.valid('json')), 201),
        )
        .patch('/:id', byId, validate('json', todoPatch), async (c) =>
            c.json(await todos.updateTodo(c.req.valid('param').id, c.req.valid('json'))),
        )
        .delete('/:id', byId, async (c) => c.json(await todos.deleteTodo(c.req.valid('param').id)));

export const goalsRoutes = ({ todos }: Services) =>
    new Hono()
        .basePath('/goals')
        .get('/', validate('query', range), async (c) =>
            c.json({ items: await todos.listGoals(c.req.valid('query')) }),
        )
        .post('/', validate('json', goalInput), async (c) =>
            c.json(await todos.createGoal(c.req.valid('json')), 201),
        )
        .patch('/:id', byId, validate('json', goalPatch), async (c) =>
            c.json(await todos.updateGoal(c.req.valid('param').id, c.req.valid('json'))),
        )
        .delete('/:id', byId, async (c) => c.json(await todos.deleteGoal(c.req.valid('param').id)));
