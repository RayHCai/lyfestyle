import { addDays, monthStart, weekStart } from '@lyfestyle/shared';
import { and, asc, eq, gte, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { goals, todos } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import type { Patch } from '../lib/types.js';

export type TodoScope = 'day' | 'week';

type Todo = typeof todos.$inferSelect;
type Goal = typeof goals.$inferSelect;

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
    scope === 'week' ? weekStart(date) : date;

const completion = (completed: boolean | undefined, now: Date) =>
    completed === undefined ? {} : { completedAt: completed ? now : null };

/** Unfinished items from an earlier period come back with the current one. */
function withCarry<T>(rows: T[], dateOf: (row: T) => string, current: string) {
    return rows.map((row) => ({ ...row, carriedOver: dateOf(row) < current }));
}

export type TodosService = ReturnType<typeof createTodosService>;

export function createTodosService(db: Db, now: () => Date) {
    const order = [asc(todos.position), asc(todos.createdAt)];

    async function findTodo(id: string): Promise<Todo> {
        const [row] = await db.select().from(todos).where(eq(todos.id, id));
        if (!row) throw notFound('Todo');
        return row;
    }

    async function findGoal(id: string): Promise<Goal> {
        const [row] = await db.select().from(goals).where(eq(goals.id, id));
        if (!row) throw notFound('Goal');
        return row;
    }

    function openOrIn(column: typeof todos.date | typeof goals.month, start: string, done: SQL) {
        return or(eq(column, start), and(lt(column, start), done));
    }

    return {
        /** Today, tomorrow, this week and this month, as of the caller's local `today`. */
        async board(today: string) {
            const week = weekStart(today);
            const month = monthStart(today);
            const [day, tomorrow, weekly, monthly] = await Promise.all([
                db
                    .select()
                    .from(todos)
                    .where(
                        and(
                            eq(todos.scope, 'day'),
                            openOrIn(todos.date, today, isNull(todos.completedAt)),
                        ),
                    )
                    .orderBy(...order),
                db
                    .select()
                    .from(todos)
                    .where(and(eq(todos.scope, 'day'), eq(todos.date, addDays(today, 1))))
                    .orderBy(...order),
                db
                    .select()
                    .from(todos)
                    .where(
                        and(
                            eq(todos.scope, 'week'),
                            openOrIn(todos.date, week, isNull(todos.completedAt)),
                        ),
                    )
                    .orderBy(...order),
                db
                    .select()
                    .from(goals)
                    .where(openOrIn(goals.month, month, isNull(goals.completedAt)))
                    .orderBy(asc(goals.position), asc(goals.createdAt)),
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

        listTodos(filter: { from: string; to: string; scope?: TodoScope | undefined }) {
            return db
                .select()
                .from(todos)
                .where(
                    and(
                        gte(
                            todos.date,
                            filter.scope === 'week' ? weekStart(filter.from) : filter.from,
                        ),
                        lte(todos.date, filter.to),
                        filter.scope ? eq(todos.scope, filter.scope) : undefined,
                    ),
                )
                .orderBy(asc(todos.date), ...order);
        },

        async createTodo(input: TodoInput) {
            if (input.goalId) await findGoal(input.goalId);
            const [row] = await db
                .insert(todos)
                .values({
                    title: input.title,
                    notes: input.notes ?? null,
                    scope: input.scope,
                    date: normalizeDate(input.scope, input.date),
                    goalId: input.goalId ?? null,
                    position: input.position ?? Date.now(),
                })
                .returning();
            return row!;
        },

        async updateTodo(id: string, patch: TodoPatch) {
            const current = await findTodo(id);
            if (patch.goalId) await findGoal(patch.goalId);
            const scope = patch.scope ?? current.scope;
            const [row] = await db
                .update(todos)
                .set({
                    ...(patch.title === undefined ? {} : { title: patch.title }),
                    ...(patch.notes === undefined ? {} : { notes: patch.notes }),
                    ...(patch.goalId === undefined ? {} : { goalId: patch.goalId }),
                    ...(patch.position === undefined ? {} : { position: patch.position }),
                    scope,
                    date: normalizeDate(scope, patch.date ?? current.date),
                    ...completion(patch.completed, now()),
                    updatedAt: now(),
                })
                .where(eq(todos.id, id))
                .returning();
            return row!;
        },

        async deleteTodo(id: string) {
            const [row] = await db.delete(todos).where(eq(todos.id, id)).returning();
            if (!row) throw notFound('Todo');
            return row;
        },

        listGoals(filter: { from: string; to: string }) {
            return db
                .select()
                .from(goals)
                .where(and(gte(goals.month, monthStart(filter.from)), lte(goals.month, filter.to)))
                .orderBy(asc(goals.month), asc(goals.position), asc(goals.createdAt));
        },

        async createGoal(input: GoalInput) {
            const [row] = await db
                .insert(goals)
                .values({
                    title: input.title,
                    notes: input.notes ?? null,
                    month: monthStart(input.month),
                    position: input.position ?? Date.now(),
                    ...(input.color ? { color: input.color } : {}),
                })
                .returning();
            return row!;
        },

        async updateGoal(id: string, patch: GoalPatch) {
            await findGoal(id);
            const [row] = await db
                .update(goals)
                .set({
                    ...(patch.title === undefined ? {} : { title: patch.title }),
                    ...(patch.notes === undefined ? {} : { notes: patch.notes }),
                    ...(patch.month === undefined ? {} : { month: monthStart(patch.month) }),
                    ...(patch.color === undefined ? {} : { color: patch.color }),
                    ...(patch.position === undefined ? {} : { position: patch.position }),
                    ...completion(patch.completed, now()),
                    updatedAt: now(),
                })
                .where(eq(goals.id, id))
                .returning();
            return row!;
        },

        async deleteGoal(id: string) {
            const [row] = await db.delete(goals).where(eq(goals.id, id)).returning();
            if (!row) throw notFound('Goal');
            return row;
        },
    };
}
