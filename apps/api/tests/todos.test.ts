import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../src/testing.js';
import { createTodosService } from '../src/todos/service.js';

let t: TestContext;
beforeAll(async () => {
    t = await createTestContext();
});
afterAll(() => t.close());

const titles = (items: { title: string }[]) => items.map((i) => i.title);

describe('planner', () => {
    it('files week todos under the Sunday and goals under the 1st', async () => {
        const week = await t.call('POST', '/todos', {
            title: 'Plan trip',
            scope: 'week',
            date: '2026-10-28',
        });
        expect(week.body).toMatchObject({ date: '2026-10-25', scope: 'week' });
        const goal = await t.call('POST', '/goals', { title: 'Run 50km', month: '2026-10-19' });
        expect(goal.body).toMatchObject({ month: '2026-10-01', color: '#6366f1' });
    });

    it('builds the board and carries unfinished work forward', async () => {
        const make = (title: string, scope: string, date: string) =>
            t.call('POST', '/todos', { title, scope, date });
        await make('Today task', 'day', '2026-11-10');
        await make('Tomorrow task', 'day', '2026-11-11');
        const late = await make('Yesterday unfinished', 'day', '2026-11-09');
        const done = await make('Yesterday finished', 'day', '2026-11-09');
        await t.call('PATCH', `/todos/${done.body.id}`, { completed: true });
        await make('Last week unfinished', 'week', '2026-11-03');
        await make('This week', 'week', '2026-11-12');
        await t.call('POST', '/goals', { title: 'Last month goal', month: '2026-10-01' });
        await t.call('POST', '/goals', {
            title: 'This month goal',
            month: '2026-11-01',
            color: '#f59e0b',
        });

        const board = (await t.call('GET', '/todos/board?today=2026-11-10')).body;
        expect(board).toMatchObject({
            today: '2026-11-10',
            weekStart: '2026-11-08',
            month: '2026-11-01',
        });
        expect(titles(board.day).sort()).toEqual(['Today task', 'Yesterday unfinished']);
        expect(board.day.find((d: { id: string }) => d.id === late.body.id).carriedOver).toBe(true);
        expect(titles(board.tomorrow)).toEqual(['Tomorrow task']);
        expect(titles(board.week).sort()).toEqual([
            'Last week unfinished',
            'Plan trip',
            'This week',
        ]);
        expect(titles(board.goals)).toEqual(
            expect.arrayContaining(['Last month goal', 'This month goal', 'Run 50km']),
        );
    });

    it('completes, reopens and moves todos', async () => {
        const todo = await t.call('POST', '/todos', {
            title: 'Move me',
            scope: 'day',
            date: '2026-11-01',
        });
        const done = await t.call('PATCH', `/todos/${todo.body.id}`, { completed: true });
        expect(done.body.completedAt).not.toBeNull();
        const reopened = await t.call('PATCH', `/todos/${todo.body.id}`, {
            completed: false,
            scope: 'week',
            date: '2026-11-04',
        });
        expect(reopened.body).toMatchObject({
            completedAt: null,
            scope: 'week',
            date: '2026-11-01',
        });
    });

    it('lists a date range and links todos to goals', async () => {
        const goal = await t.call('POST', '/goals', { title: 'Ship app', month: '2027-01-01' });
        await t.call('POST', '/todos', {
            title: 'Write API',
            scope: 'day',
            date: '2027-01-05',
            goalId: goal.body.id,
        });
        const list = await t.call('GET', '/todos?from=2027-01-01&to=2027-01-31');
        expect(list.body.items).toHaveLength(1);
        expect(list.body.items[0].goalId).toBe(goal.body.id);

        await t.call('DELETE', `/goals/${goal.body.id}`);
        const after = await t.call('GET', '/todos?from=2027-01-01&to=2027-01-31');
        expect(after.body.items[0].goalId).toBeNull();
    });

    it('rejects unknown goals and impossible dates', async () => {
        const res = await t.call('POST', '/todos', {
            title: 'x',
            scope: 'day',
            date: '2026-11-01',
            goalId: crypto.randomUUID(),
        });
        expect(res.status).toBe(404);
        expect((await t.call('GET', '/todos/board?today=2026-02-31')).status).toBe(400);
    });

    it('moves a week todo onto a day', async () => {
        const todo = await t.call('POST', '/todos', {
            title: 'Week to day',
            scope: 'week',
            date: '2026-12-09',
        });
        expect(todo.body.date).toBe('2026-12-06');
        const moved = await t.call('PATCH', `/todos/${todo.body.id}`, {
            scope: 'day',
            date: '2026-12-09',
        });
        expect(moved.body).toMatchObject({ scope: 'day', date: '2026-12-09' });
    });

    it('unlinks a todo from its goal with goalId null', async () => {
        const goal = await t.call('POST', '/goals', { title: 'Linked', month: '2026-12-01' });
        const todo = await t.call('POST', '/todos', {
            title: 'Linked todo',
            scope: 'day',
            date: '2026-12-02',
            goalId: goal.body.id,
        });
        const unlinked = await t.call('PATCH', `/todos/${todo.body.id}`, { goalId: null });
        expect(unlinked.status).toBe(200);
        expect(unlinked.body.goalId).toBeNull();
    });

    it('lists the week todos of a range that starts mid-week', async () => {
        const make = (title: string, scope: string, date: string) =>
            t.call('POST', '/todos', { title, scope, date });
        // 2027-03-10 is a Wednesday in the week of Sunday 2027-03-07.
        await make('This week (filed Sunday)', 'week', '2027-03-10');
        await make('Last week', 'week', '2027-03-03');
        await make('Monday, before the range', 'day', '2027-03-08');
        await make('Thursday', 'day', '2027-03-11');

        const list = (scope = '') =>
            t.call('GET', `/todos?from=2027-03-10&to=2027-03-12${scope}`).then((r) => r.body.items);
        expect(titles(await list())).toEqual(['This week (filed Sunday)', 'Thursday']);
        expect(titles(await list('&scope=week'))).toEqual(['This week (filed Sunday)']);
        expect(titles(await list('&scope=day'))).toEqual(['Thursday']);
    });

    it('answers 404 for a todo or goal that does not exist', async () => {
        for (const kind of ['todos', 'goals']) {
            const id = crypto.randomUUID();
            expect((await t.call('DELETE', `/${kind}/${id}`)).status).toBe(404);
            expect((await t.call('PATCH', `/${kind}/${id}`, { title: 'x' })).status).toBe(404);
        }
    });

    it('stamps new items with the injected clock', async () => {
        const at = new Date('2026-12-24T18:00:00.000Z');
        const todos = createTodosService(t.services.db, () => at);
        const todo = await todos.createTodo({ title: 'Clocked', scope: 'day', date: '2026-12-24' });
        expect(todo).toMatchObject({ createdAt: at, updatedAt: at, position: at.getTime() });
        const goal = await todos.createGoal({ title: 'Clocked goal', month: '2026-12-01' });
        expect(goal).toMatchObject({ createdAt: at, updatedAt: at, position: at.getTime() });
    });
});
