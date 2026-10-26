import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../src/testing.js';

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
});
