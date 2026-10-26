import { isoDate } from '@lyfestyle/shared';
import { z } from 'zod';
import type { JobsService } from '../agent/jobs.js';
import type { Canvas } from '../integrations/canvas.js';
import type { Resend } from '../integrations/resend.js';
import type { PagesService } from '../pages/service.js';
import type { TodosService } from '../todos/service.js';
import { goalFields, todoFields } from '../todos/routes.js';
import { defineTool, type Tool } from './registry.js';

export interface ToolDeps {
    pages: PagesService;
    todos: TodosService;
    jobs: JobsService;
    canvas: Canvas;
    resend: Resend;
}

const id = z.uuid();
const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);
const emails = z.array(z.email()).max(50);

function pageTools({ pages }: ToolDeps): Tool[] {
    return [
        defineTool({
            name: 'pages_search',
            description:
                'Search the knowledge base. Matches words in page titles and bodies, and partial titles. Returns summaries with a short excerpt; call pages_get for the full markdown.',
            input: z.object({ query: z.string().min(1), limit: limit(50, 10) }),
            readOnly: true,
            run: ({ query, limit }) => pages.search(query, limit),
        }),
        defineTool({
            name: 'pages_list_recent',
            description: 'List the most recently edited pages, newest first.',
            input: z.object({ limit: limit(100, 20) }),
            readOnly: true,
            run: async ({ limit }) => (await pages.list({ limit })).items,
        }),
        defineTool({
            name: 'pages_get',
            description: 'Read one page in full: title, markdown content, icon and version.',
            input: z.object({ id }),
            readOnly: true,
            run: ({ id }) => pages.get(id),
        }),
        defineTool({
            name: 'pages_create',
            description:
                'Create a page. Content is markdown. Link to another page with [label](page:<page id>); links may form cycles.',
            input: z.object({
                title: z.string().max(500),
                content: z.string().max(1_000_000).default(''),
                icon: z.string().max(64).optional().describe('A single emoji'),
            }),
            run: (input) => pages.create(input),
        }),
        defineTool({
            name: 'pages_update',
            description:
                'Replace a page’s title, content or icon. Fields left out are unchanged. Pass baseVersion from pages_get to refuse the write if someone edited the page since.',
            input: z.object({
                id,
                title: z.string().max(500).optional(),
                content: z.string().max(1_000_000).optional(),
                icon: z.string().max(64).nullable().optional(),
                baseVersion: z.number().int().positive().optional(),
            }),
            run: ({ id, baseVersion, ...draft }) => pages.update(id, draft, baseVersion),
        }),
        defineTool({
            name: 'pages_append',
            description: 'Add markdown to the end of a page without rewriting what is there.',
            input: z.object({ id, content: z.string().min(1).max(1_000_000) }),
            run: ({ id, content }) => pages.append(id, content),
        }),
        defineTool({
            name: 'pages_delete',
            description: 'Move a page to the trash. It can be restored from the app.',
            input: z.object({ id }),
            destructive: true,
            run: ({ id }) => pages.remove(id),
        }),
        defineTool({
            name: 'pages_backlinks',
            description: 'List the pages that link to a page.',
            input: z.object({ id }),
            readOnly: true,
            run: ({ id }) => pages.backlinks(id),
        }),
    ];
}

function todoTools({ todos }: ToolDeps): Tool[] {
    const today = isoDate.describe("The user's local date, YYYY-MM-DD");
    return [
        defineTool({
            name: 'todos_get_board',
            description:
                "The planner as of today: today's todos, tomorrow's, this week's, and this month's goals. Unfinished items from earlier periods appear with carriedOver: true.",
            input: z.object({ today }),
            readOnly: true,
            run: ({ today }) => todos.board(today),
        }),
        defineTool({
            name: 'todos_list',
            description: 'List todos dated within a range (inclusive), for days outside the board.',
            input: z.object({ from: isoDate, to: isoDate, scope: todoFields.scope.optional() }),
            readOnly: true,
            run: (filter) => todos.listTodos(filter),
        }),
        defineTool({
            name: 'todos_create',
            description:
                'Add a todo. scope "day" belongs to one date; scope "week" belongs to the week (Sunday to Saturday) containing date.',
            input: z.object({
                title: todoFields.title,
                scope: todoFields.scope,
                date: isoDate,
                notes: z.string().max(10_000).optional(),
                goalId: id.optional().describe('A monthly goal this todo works towards'),
            }),
            run: (input) => todos.createTodo(input),
        }),
        defineTool({
            name: 'todos_update',
            description:
                'Change a todo. Set completed to check it off or reopen it; move it by changing date.',
            input: z.object({ id, ...z.object(todoFields).partial().shape }),
            run: ({ id, ...patch }) => todos.updateTodo(id, patch),
        }),
        defineTool({
            name: 'todos_delete',
            description: 'Delete a todo permanently. Prefer completing it, which keeps history.',
            input: z.object({ id }),
            destructive: true,
            run: ({ id }) => todos.deleteTodo(id),
        }),
        defineTool({
            name: 'goals_list',
            description: 'List monthly goals for the months between two dates.',
            input: z.object({ from: isoDate, to: isoDate }),
            readOnly: true,
            run: (filter) => todos.listGoals(filter),
        }),
        defineTool({
            name: 'goals_create',
            description: 'Add a goal for the month containing `month`.',
            input: z.object({
                title: goalFields.title,
                month: isoDate,
                color: goalFields.color.optional().describe('Accent colour, e.g. #f59e0b'),
                notes: z.string().max(10_000).optional(),
            }),
            run: (input) => todos.createGoal(input),
        }),
        defineTool({
            name: 'goals_update',
            description: 'Change a monthly goal, or set completed to mark it done.',
            input: z.object({ id, ...z.object(goalFields).partial().shape }),
            run: ({ id, ...patch }) => todos.updateGoal(id, patch),
        }),
        defineTool({
            name: 'goals_delete',
            description: 'Delete a goal permanently. Its todos stay, unlinked.',
            input: z.object({ id }),
            destructive: true,
            run: ({ id }) => todos.deleteGoal(id),
        }),
    ];
}

function automationTools({ jobs }: ToolDeps): Tool[] {
    const schedule = z
        .string()
        .min(1)
        .describe('Cron expression, e.g. "0 7 * * 1-5" for 7:00 on weekdays');
    const timezone = z.string().describe('IANA time zone, e.g. America/New_York');
    return [
        defineTool({
            name: 'automations_list',
            description: 'List scheduled automations: prompts the agent runs on a cron schedule.',
            input: z.object({}),
            readOnly: true,
            run: () => jobs.list(),
        }),
        defineTool({
            name: 'automations_create',
            description:
                'Schedule a prompt for the agent to run on its own, e.g. a morning briefing. The prompt must stand alone: the run has no conversation history.',
            input: z.object({
                name: z.string().min(1).max(200),
                prompt: z.string().min(1).max(100_000),
                schedule,
                timezone: timezone.default('UTC'),
            }),
            run: (input) => jobs.create(input),
        }),
        defineTool({
            name: 'automations_update',
            description: 'Change an automation, or pause it with enabled: false.',
            input: z.object({
                id,
                name: z.string().min(1).max(200).optional(),
                prompt: z.string().min(1).max(100_000).optional(),
                schedule: schedule.optional(),
                timezone: timezone.optional(),
                enabled: z.boolean().optional(),
            }),
            run: ({ id, ...patch }) => jobs.update(id, patch),
        }),
        defineTool({
            name: 'automations_delete',
            description: 'Delete an automation. Its past runs are kept.',
            input: z.object({ id }),
            destructive: true,
            run: ({ id }) => jobs.remove(id),
        }),
    ];
}

function canvasTools({ canvas }: ToolDeps): Tool[] {
    const courseId = z.number().int().positive();
    return [
        defineTool({
            name: 'canvas_list_courses',
            description: 'List the Canvas courses the user is actively enrolled in.',
            input: z.object({}),
            readOnly: true,
            requires: 'canvas',
            run: () => canvas.courses(),
        }),
        defineTool({
            name: 'canvas_list_assignments',
            description: 'List a course’s assignments in due-date order, with submission status.',
            input: z.object({
                courseId,
                bucket: z
                    .enum([
                        'past',
                        'overdue',
                        'undated',
                        'ungraded',
                        'unsubmitted',
                        'upcoming',
                        'future',
                    ])
                    .optional(),
            }),
            readOnly: true,
            requires: 'canvas',
            run: ({ courseId, bucket }) => canvas.assignments(courseId, bucket),
        }),
        defineTool({
            name: 'canvas_get_assignment',
            description: 'Read one assignment, its instructions included.',
            input: z.object({ courseId, assignmentId: z.number().int().positive() }),
            readOnly: true,
            requires: 'canvas',
            run: ({ courseId, assignmentId }) => canvas.assignment(courseId, assignmentId),
        }),
        defineTool({
            name: 'canvas_upcoming',
            description: 'Upcoming assignments and calendar events across all courses.',
            input: z.object({}),
            readOnly: true,
            requires: 'canvas',
            run: () => canvas.upcoming(),
        }),
        defineTool({
            name: 'canvas_todo',
            description: 'The Canvas to-do list: work that needs submitting or grading.',
            input: z.object({}),
            readOnly: true,
            requires: 'canvas',
            run: () => canvas.todo(),
        }),
        defineTool({
            name: 'canvas_announcements',
            description: 'Recent course announcements. Defaults to every active course.',
            input: z.object({
                courseIds: z.array(courseId).optional(),
                startDate: isoDate.optional(),
                endDate: isoDate.optional(),
            }),
            readOnly: true,
            requires: 'canvas',
            run: (options) => canvas.announcements(options),
        }),
    ];
}

function emailTools({ resend }: ToolDeps): Tool[] {
    return [
        defineTool({
            name: 'email_send',
            description:
                'Send an email right away from the app’s own address. It cannot be unsent: unless the user asked for this exact email, show them the draft and get a yes first.',
            input: z.object({
                to: emails.min(1),
                subject: z.string().min(1).max(998),
                text: z.string().max(200_000).optional(),
                html: z.string().max(500_000).optional(),
                cc: emails.optional(),
                bcc: emails.optional(),
                replyTo: z.email().optional(),
            }),
            destructive: true,
            requires: 'resend',
            run: (email) => resend.send(email),
        }),
    ];
}

export function createTools(deps: ToolDeps): Tool[] {
    return [
        ...pageTools(deps),
        ...todoTools(deps),
        ...automationTools(deps),
        ...canvasTools(deps),
        ...emailTools(deps),
    ];
}
