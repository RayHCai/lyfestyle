import { isoDate } from '@lyfestyle/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { byId, validate } from '../lib/validate.js';
import type { Services } from '../services.js';
import { dateRange, goalInput, goalPatch, todoInput, todoPatch } from './schema.js';

export const todosRoutes = ({ todos }: Services) =>
    new Hono()
        .basePath('/todos')
        .get('/board', validate('query', z.object({ today: isoDate })), async (c) =>
            c.json(await todos.board(c.req.valid('query').today)),
        )
        .get(
            '/',
            validate('query', dateRange.extend({ scope: todoPatch.shape.scope })),
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
        .get('/', validate('query', dateRange), async (c) =>
            c.json({ items: await todos.listGoals(c.req.valid('query')) }),
        )
        .post('/', validate('json', goalInput), async (c) =>
            c.json(await todos.createGoal(c.req.valid('json')), 201),
        )
        .patch('/:id', byId, validate('json', goalPatch), async (c) =>
            c.json(await todos.updateGoal(c.req.valid('param').id, c.req.valid('json'))),
        )
        .delete('/:id', byId, async (c) => c.json(await todos.deleteGoal(c.req.valid('param').id)));
