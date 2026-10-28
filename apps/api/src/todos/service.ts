import { addDays, monthStart, weekStart } from '@lyfestyle/shared';
import { fromDay, type Db, type Row, type TodoScope } from '../db/client.js';
import { notFound } from '../lib/errors.js';
import type { Patch } from '../lib/types.js';

export type { TodoScope } from '../db/client.js';

export interface TodoInput {
    title: string;
    notes?: string | null | undefined;
    scope: TodoScope;
    /** Any day; week todos are stored against the Sunday that starts that week. */
    date: string;
    goalId?: string | null | undefined;
    position?: number | undefined;
}

export type TodoPatch = Patch<TodoInput> & { completed?: boolean | undefined };

export interface GoalInput {
    title: string;
    notes?: string | null | undefined;
    /** Any day of the goal's month. */
    month: string;
    color?: string | undefined;
    position?: number | undefined;
}

export type GoalPatch = Patch<GoalInput> & { completed?: boolean | undefined };

const normalizeDate = (scope: TodoScope, date: string) =>
    fromDay(scope === 'week' ? weekStart(date) : date);

const completion = (completed: boolean | undefined, now: Date) =>
    completed === undefined ? {} : { completedAt: completed ? now : null };

/** Unfinished items from an earlier period come back with the current one. */
function withCarry<T>(rows: T[], dateOf: (row: T) => string, current: string) {
    return rows.map((row) => ({ ...row, carriedOver: dateOf(row) < current }));
}

export type TodosService = ReturnType<typeof createTodosService>;

export function createTodosService(db: Db, now: () => Date) {
    const order = [{ position: 'asc' }, { createdAt: 'asc' }] as const;

    /** The period starting `start`, plus anything left unfinished from earlier ones. */
    function openOrIn<F extends 'date' | 'month'>(field: F, start: string) {
        const day = fromDay(start);
        return {
            OR: [
                { [field]: day } as Record<F, Date>,
                { [field]: { lt: day }, completedAt: null } as Record<F, { lt: Date }> & {
                    completedAt: null;
                },
            ],
        };
    }

    async function findTodo(id: string): Promise<Row<'todo'>> {
        const row = await db.todo.findUnique({ where: { id } });
        if (!row) throw notFound('Todo');
        return row;
    }

    async function findGoal(id: string): Promise<Row<'goal'>> {
        const row = await db.goal.findUnique({ where: { id } });
        if (!row) throw notFound('Goal');
        return row;
    }

    return {
        /** Today, tomorrow, this week and this month, as of the caller's local `today`. */
        async board(today: string) {
            const week = weekStart(today);
            const month = monthStart(today);
            const [day, tomorrow, weekly, monthly] = await Promise.all([
                db.todo.findMany({
                    where: { scope: 'day', ...openOrIn('date', today) },
                    orderBy: [...order],
                }),
                db.todo.findMany({
                    where: { scope: 'day', date: fromDay(addDays(today, 1)) },
                    orderBy: [...order],
                }),
                db.todo.findMany({
                    where: { scope: 'week', ...openOrIn('date', week) },
                    orderBy: [...order],
                }),
                db.goal.findMany({ where: openOrIn('month', month), orderBy: [...order] }),
            ]);
            return {
                today,
                weekStart: week,
                month,
                day: withCarry(day, (r) => r.date, today),
                tomorrow: withCarry(tomorrow, (r) => r.date, addDays(today, 1)),
                week: withCarry(weekly, (r) => r.date, week),
                goals: withCarry(monthly, (r) => r.month, month),
            };
        },

        /** Day todos dated in the range, and week todos for every week that overlaps it. */
        listTodos(filter: { from: string; to: string; scope?: TodoScope | undefined }) {
            const to = fromDay(filter.to);
            const day = { scope: 'day', date: { gte: fromDay(filter.from), lte: to } };
            // A week todo is dated by its Sunday, which falls before `from` in a mid-week range.
            const week = { scope: 'week', date: { gte: fromDay(weekStart(filter.from)), lte: to } };
            return db.todo.findMany({
                where:
                    filter.scope === 'day'
                        ? day
                        : filter.scope === 'week'
                          ? week
                          : { OR: [day, week] },
                orderBy: [{ date: 'asc' }, ...order],
            });
        },

        async createTodo(input: TodoInput) {
            if (input.goalId) await findGoal(input.goalId);
            const at = now();
            return db.todo.create({
                data: {
                    title: input.title,
                    notes: input.notes ?? null,
                    scope: input.scope,
                    date: normalizeDate(input.scope, input.date),
                    goalId: input.goalId ?? null,
                    position: input.position ?? at.getTime(),
                    createdAt: at,
                    updatedAt: at,
                },
            });
        },

        async updateTodo(id: string, patch: TodoPatch) {
            const current = await findTodo(id);
            if (patch.goalId) await findGoal(patch.goalId);
            const scope = patch.scope ?? current.scope;
            const at = now();
            return db.todo.update({
                where: { id },
                data: {
                    ...(patch.title === undefined ? {} : { title: patch.title }),
                    ...(patch.notes === undefined ? {} : { notes: patch.notes }),
                    ...(patch.goalId === undefined ? {} : { goalId: patch.goalId }),
                    ...(patch.position === undefined ? {} : { position: patch.position }),
                    scope,
                    date: normalizeDate(scope, patch.date ?? current.date),
                    ...completion(patch.completed, at),
                    updatedAt: at,
                },
            });
        },

        async deleteTodo(id: string) {
            await findTodo(id);
            return db.todo.delete({ where: { id } });
        },

        listGoals(filter: { from: string; to: string }) {
            return db.goal.findMany({
                where: {
                    month: { gte: fromDay(monthStart(filter.from)), lte: fromDay(filter.to) },
                },
                orderBy: [{ month: 'asc' }, ...order],
            });
        },

        createGoal(input: GoalInput) {
            const at = now();
            return db.goal.create({
                data: {
                    title: input.title,
                    notes: input.notes ?? null,
                    month: fromDay(monthStart(input.month)),
                    position: input.position ?? at.getTime(),
                    ...(input.color ? { color: input.color } : {}),
                    createdAt: at,
                    updatedAt: at,
                },
            });
        },

        async updateGoal(id: string, patch: GoalPatch) {
            await findGoal(id);
            const at = now();
            return db.goal.update({
                where: { id },
                data: {
                    ...(patch.title === undefined ? {} : { title: patch.title }),
                    ...(patch.notes === undefined ? {} : { notes: patch.notes }),
                    ...(patch.month === undefined
                        ? {}
                        : { month: fromDay(monthStart(patch.month)) }),
                    ...(patch.color === undefined ? {} : { color: patch.color }),
                    ...(patch.position === undefined ? {} : { position: patch.position }),
                    ...completion(patch.completed, at),
                    updatedAt: at,
                },
            });
        },

        async deleteGoal(id: string) {
            await findGoal(id);
            return db.goal.delete({ where: { id } });
        },
    };
}
