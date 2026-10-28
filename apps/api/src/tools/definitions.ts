import { isoDate } from '@lyfestyle/shared';
import { z } from 'zod';
import { automationGuide } from '../automations/guide.js';
import { deployStatus } from '../automations/schema.js';
import type { AutomationsService } from '../automations/service.js';
import type { Canvas } from '../integrations/canvas.js';
import type { Resend } from '../integrations/resend.js';
import { emailFields } from '../integrations/schema.js';
import { notificationFields } from '../notifications/schema.js';
import type { NotificationsService } from '../notifications/service.js';
import { timeZone } from '../lib/timezone.js';
import { pageDraft, pageFields } from '../pages/schema.js';
import type { PagesService } from '../pages/service.js';
import {
    dateRange,
    goalInput,
    goalPatch,
    todoFields,
    todoInput,
    todoPatch,
} from '../todos/schema.js';
import type { TodosService } from '../todos/service.js';
import { defineTool, type Tool } from './registry.js';

interface ToolDeps {
    pages: PagesService;
    todos: TodosService;
    automations: AutomationsService;
    notifications: NotificationsService;
    limits: { budgetUsd: number; timeoutMs: number };
    canvas: Canvas;
    resend: Resend;
}

const id = z.uuid();
const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);

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
                title: pageFields.title,
                content: pageFields.content.default(''),
                icon: pageFields.icon.optional().describe('A single emoji'),
            }),
            run: (input) => pages.create(input),
        }),
        defineTool({
            name: 'pages_update',
            description:
                'Replace a page’s title, content or icon. Fields left out are unchanged. Pass baseVersion from pages_get to refuse the write if someone edited the page since.',
            input: z.object({
                id,
                ...pageDraft.shape,
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
            description:
                'Move a page to the trash. It can be restored from the app for 7 days, then it is deleted for good.',
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
            input: dateRange.extend({ scope: todoFields.scope.optional() }),
            readOnly: true,
            run: (filter) => todos.listTodos(filter),
        }),
        defineTool({
            name: 'todos_create',
            description:
                'Add a todo. scope "day" belongs to one date; scope "week" belongs to the week (Sunday to Saturday) containing date.',
            input: todoInput.extend({
                goalId: todoInput.shape.goalId.describe('A monthly goal this todo works towards'),
            }),
            run: (input) => todos.createTodo(input),
        }),
        defineTool({
            name: 'todos_update',
            description:
                'Change a todo. Set completed to check it off or reopen it; move it by changing date.',
            input: z.object({ id, ...todoPatch.shape }),
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
            input: dateRange,
            readOnly: true,
            run: (filter) => todos.listGoals(filter),
        }),
        defineTool({
            name: 'goals_create',
            description: 'Add a goal for the month containing `month`.',
            input: goalInput.extend({
                color: goalInput.shape.color.describe('Accent colour, e.g. #f59e0b'),
            }),
            run: (input) => todos.createGoal(input),
        }),
        defineTool({
            name: 'goals_update',
            description: 'Change a monthly goal, or set completed to mark it done.',
            input: z.object({ id, ...goalPatch.shape }),
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

function automationTools({ automations, limits }: ToolDeps): Tool[] {
    const schedule = z
        .string()
        .min(1)
        .max(200)
        .describe('Cron expression, e.g. "0 7 * * 1-5" for 7:00 on weekdays');
    return [
        defineTool({
            name: 'automations_list',
            description:
                'List automations: approved code the Lyfestyle server runs on a cron schedule, with their next and last runs.',
            input: z.object({}),
            readOnly: true,
            run: () => automations.list(),
        }),
        defineTool({
            name: 'automations_get',
            description:
                'Read one automation: its deployed code, its state, and its recent runs with logs, errors and cost.',
            input: z.object({ id }),
            readOnly: true,
            run: ({ id }) => automations.get(id),
        }),
        defineTool({
            name: 'automations_deploy',
            description: automationGuide(limits),
            input: z.object({
                automationId: id.optional().describe('Set to change an existing automation'),
                name: z.string().trim().min(1).max(200),
                description: z
                    .string()
                    .max(2000)
                    .default('')
                    .describe('One or two sentences on what it does, shown to the user'),
                schedule,
                timezone: timeZone
                    .default('UTC')
                    .describe("IANA time zone, e.g. America/New_York; use the user's own"),
                code: z.string().min(1).max(200_000),
            }),
            // An automation's own runs read untrusted content such as email, and must not be able
            // to put code in front of the user for approval.
            attendedOnly: true,
            // Small on purpose: the desktop app reads the deploy id from this result to show its
            // approval prompt, and the runner clips long tool results.
            run: async (input, ctx) => {
                const deploy = await automations.propose(input, {
                    kind: ctx.run?.kind ?? 'user',
                    runId: ctx.run?.id ?? null,
                });
                return {
                    id: deploy.id,
                    status: deploy.status,
                    automationId: deploy.automationId,
                    name: deploy.name,
                    note: 'Waiting for the user to approve it in the chat.',
                };
            },
        }),
        defineTool({
            name: 'automations_list_deploys',
            description: 'List proposed deploys, e.g. to see which still wait for approval.',
            input: z.object({ status: deployStatus.optional() }),
            readOnly: true,
            run: ({ status }) => automations.deploys(status),
        }),
        defineTool({
            name: 'automations_run',
            description:
                'Run an automation’s approved code now, outside its schedule. Returns the started run; read automations_get for its outcome.',
            input: z.object({ id }),
            // Like deploying: an unattended run steered by what it read must not start, pause or
            // delete the user's automations.
            attendedOnly: true,
            run: ({ id }) => automations.trigger(id),
        }),
        defineTool({
            name: 'automations_set_enabled',
            description: 'Pause an automation (enabled: false) or resume it.',
            input: z.object({ id, enabled: z.boolean() }),
            attendedOnly: true,
            run: ({ id, enabled }) => automations.setEnabled(id, enabled),
        }),
        defineTool({
            name: 'automations_delete',
            description: 'Delete an automation and its run history.',
            input: z.object({ id }),
            destructive: true,
            attendedOnly: true,
            run: ({ id }) => automations.remove(id),
        }),
    ];
}

function notificationTools({ notifications }: ToolDeps): Tool[] {
    return [
        defineTool({
            name: 'notify',
            description:
                'Show the user a desktop notification in the Lyfestyle app, e.g. when unattended work finishes or needs them.',
            input: z.object(notificationFields),
            run: (input) => notifications.create({ ...input, source: 'Lyfestyle agent' }),
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
            input: z.object(emailFields),
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
        ...notificationTools(deps),
        ...canvasTools(deps),
        ...emailTools(deps),
    ];
}
