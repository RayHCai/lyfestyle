// Only reachable when Vite runs with `--mode screenshot`; the import in App.tsx is compiled out otherwise.
// Lets a headless browser open any surface directly: #view=settings, #sidebar, #console, #seed,
// and #mock, which answers the API's automation and page-view routes with sample data (API mode,
// no server).
// Nothing a preview does is saved: storage keeps its writes in memory for the page's lifetime.
import { useApp } from '../store/app';
import { recentConversations, useData } from '../store/data';
import { dayKey } from './metrics';
import { keepInMemory } from './storage';
import { addDays, startOfDay } from './time';
import type { View } from './types';

const sampleReply = `Here is a short plan for the week.

## Monday
Review the **quarterly notes** and draft the summary. Keep it under a page.

## Tuesday
- Call the studio about the print run
- Move the sketches into the shared folder

> Small steps, taken daily, compound faster than anyone expects.

Let me know if you want this turned into an automation.`;

const MOCK_URL = 'http://preview.invalid';

/** Serves the routes API mode loads, with automations, a pending deploy and a day of runs. */
function mockApi() {
    const real = window.fetch.bind(window);
    const day = new Date().setHours(0, 0, 0, 0);
    const at = (h: number, m = 0) => new Date(day + (h * 60 + m) * 60_000).toISOString();
    const code = (...body: string[]) =>
        ['export default async function (ctx) {', ...body.map((l) => '    ' + l), '}', ''].join(
            '\n',
        );
    const summarise =
        "const summary = await ctx.agent('Summarise my calendar, Canvas and inbox for today.');";
    const automations = [
        {
            id: 'a1',
            name: 'Morning briefing',
            description: 'Calendar, Canvas and inbox, summarised and emailed at 07:00',
            schedule: '0 7 * * 1-5',
            enabled: true,
            version: 3,
            lastRun: { id: 'r1', status: 'succeeded', startedAt: at(7), finishedAt: at(7, 2) },
            nextRunAt: at(31),
        },
        {
            id: 'a2',
            name: 'Assignment watch',
            description: 'Notifies when a Canvas assignment is due within a day',
            schedule: '0 */2 * * *',
            enabled: true,
            version: 1,
            lastRun: { id: 'r4', status: 'failed', startedAt: at(10), finishedAt: at(10, 0) },
            nextRunAt: at(12),
        },
        {
            id: 'a3',
            name: 'Weekly review',
            description: '',
            schedule: '0 18 * * 0',
            enabled: false,
            version: 2,
            lastRun: null,
            nextRunAt: null,
        },
    ].map((a) => ({
        timezone: 'America/New_York',
        lastRunAt: a.lastRun?.startedAt ?? null,
        createdAt: at(0),
        updatedAt: at(0),
        ...a,
    }));
    const run = (
        id: string,
        a: (typeof automations)[number],
        start: string,
        end: string | null,
        status: string,
        extra = {},
    ) => ({
        id,
        automationId: a.id,
        name: a.name,
        version: a.version,
        trigger: 'schedule',
        status,
        startedAt: start,
        finishedAt: end,
        error: null,
        output: null,
        logs: [],
        costUsd: 0,
        ...extra,
    });
    const [brief, watch] = automations as [
        (typeof automations)[number],
        (typeof automations)[number],
    ];
    const runs = [
        run('r1', brief, at(7), at(7, 2), 'succeeded', { costUsd: 0.42 }),
        run('r2', watch, at(6), at(6, 0), 'succeeded'),
        run('r3', watch, at(8), at(8, 1), 'succeeded'),
        run('r4', watch, at(10), at(10, 0), 'failed', {
            error: 'Canvas answered 401: the token has expired',
        }),
        run('r5', watch, new Date(Date.now() - 90_000).toISOString(), null, 'running', {
            trigger: 'manual',
        }),
    ];
    const deploys = [
        {
            id: 'd1',
            automationId: 'a1',
            name: 'Morning briefing',
            description: 'Adds the weather to the briefing',
            schedule: '30 6 * * 1-5',
            timezone: 'America/New_York',
            code: code(
                summarise,
                "const weather = await (await fetch('https://wttr.in/?format=3')).text();",
                "await ctx.email({ subject: 'Your morning', text: weather + '\\n\\n' + summary });",
            ),
            status: 'pending' as string,
            origin: 'chat',
            runId: 'run1',
            createdAt: new Date(Date.now() - 300_000).toISOString(),
            decidedAt: null as string | null,
            current: {
                version: 3,
                name: 'Morning briefing',
                schedule: '0 7 * * 1-5',
                timezone: 'America/New_York',
                code: code(
                    summarise,
                    "await ctx.email({ subject: 'Your morning', text: summary });",
                ),
            },
        },
    ];
    // A chat where the agent proposed deploy d1, so the in-chat approval prompt renders too.
    const asked = new Date(Date.now() - 300_000).toISOString();
    const chat = { id: 'c1', title: 'Weather in the briefing', createdAt: asked, updatedAt: asked };
    const message = (id: string, role: string, content: unknown[]) => ({
        id,
        role,
        content,
        runId: role === 'user' ? null : 'run1',
        createdAt: asked,
    });
    const thread = {
        ...chat,
        activeRuns: [],
        messages: [
            message('m1', 'user', [
                { type: 'text', text: 'Add the weather to my morning briefing, sent at 6:30.' },
            ]),
            message('m2', 'assistant', [
                {
                    type: 'tool_use',
                    id: 'tu1',
                    name: 'mcp__lyfestyle__automations_deploy',
                    input: {},
                },
            ]),
            message('m3', 'tool', [
                {
                    type: 'tool_result',
                    toolUseId: 'tu1',
                    content: JSON.stringify({ id: 'd1', status: 'pending' }),
                },
            ]),
            message('m4', 'assistant', [
                {
                    type: 'text',
                    text: 'Version 4 of **Morning briefing** puts the weather at the top of the email and sends it at 6:30 on weekdays.',
                },
            ]),
        ],
    };
    const decide = (status: string) => () => {
        deploys[0]!.status = status;
        deploys[0]!.decidedAt = new Date().toISOString();
        return deploys[0];
    };
    /** `/sync/push` takes every change as the first version of its page. */
    const push = (body: unknown) => ({
        results: ((body as { changes?: { id: string; deleted: boolean }[] }).changes ?? []).map(
            (c) => ({
                id: c.id,
                status: 'applied',
                page: {
                    ...c,
                    version: 1,
                    createdAt: asked,
                    updatedAt: asked,
                    deletedAt: c.deleted ? asked : null,
                },
            }),
        ),
    });
    const routes: [RegExp, (body: unknown, path: string) => unknown][] = [
        [/^\/metrics\/views\/summary/, (_, path) => viewSummary(path)],
        [/^\/conversations\?/, () => ({ items: [chat], nextCursor: null })],
        [/^\/conversations\/c1$/, () => thread],
        [/^\/sync\/pull/, () => ({ pages: [], cursor: '0', hasMore: false })],
        [/^\/sync\/push$/, push],
        [/^\/automations\/deploys\/d1\/approve$/, decide('approved')],
        [/^\/automations\/deploys\/d1\/reject$/, decide('rejected')],
        [/^\/automations\/deploys\/d1$/, () => deploys[0]],
        [
            /^\/automations\/deploys/,
            () => ({ items: deploys.filter((d) => d.status === 'pending') }),
        ],
        [
            /^\/automations\/timeline/,
            () => ({
                runs,
                upcoming: [12, 14, 16, 18, 20, 22].map((h) => ({
                    automationId: 'a2',
                    name: 'Assignment watch',
                    at: at(h),
                })),
            }),
        ],
        [/^\/automations$/, () => ({ items: automations })],
        [/^\/notifications/, () => ({ items: [], latestId: null })],
        [/^\/mcp-servers/, () => ({ items: [] })],
    ];
    window.fetch = async (input, init) => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(MOCK_URL)) return real(input, init);
        const path = url.slice(MOCK_URL.length);
        const hit = routes.find(([re]) => re.test(path));
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
        return hit
            ? new Response(JSON.stringify(hit[1](body, path)), {
                  headers: { 'content-type': 'application/json' },
              })
            : new Response(JSON.stringify({ error: { code: 'not_found', message: path } }), {
                  status: 404,
              });
    };
}

/** Three sites with a weekly rhythm, so every range of the page-views screen has a shape. */
const sites = [
    { origin: 'https://hunter.studio', base: 140 },
    { origin: 'https://notes.hunter.studio', base: 38 },
    { origin: 'http://localhost:5173', base: 6 },
];

function viewSummary(path: string) {
    const q = new URLSearchParams(path.split('?')[1]);
    const from = startOfDay(Date.parse(q.get('from') ?? '') || Date.now());
    const days: number[] = [];
    for (let d = from; d <= Date.now(); d = addDays(d, 1)) days.push(d);
    const daily = (base: number, day: number, i: number, phase: number) => {
        const weekday = new Date(day).getDay();
        const weekend = weekday === 0 || weekday === 6 ? 0.45 : 1;
        // A steady climb, a weekly dip, a little noise and one launch spike.
        const wave = 1 + 0.35 * Math.sin(i * 1.7 + phase) + (i === days.length - 9 ? 1.6 : 0);
        return Math.max(0, Math.round(base * weekend * wave * (0.7 + i / days.length / 2)));
    };
    const series = sites.map((s, n) =>
        days.map((day, i) => {
            const views = daily(s.base, day, i, n * 2);
            return { key: dayKey(day), views, visitors: Math.round(views * 0.42) };
        }),
    );
    const sum = (rows: { views: number; visitors: number }[]) => ({
        views: rows.reduce((n, r) => n + r.views, 0),
        visitors: Math.round(rows.reduce((n, r) => n + r.visitors, 0) * 0.6),
    });
    const origin = q.get('origin');
    if (q.get('groupBy') === 'day') {
        const rows = series[sites.findIndex((s) => s.origin === origin)] ?? [];
        return { groupBy: 'day', totals: sum(rows), groups: rows };
    }
    const groups = sites.map((s, i) => ({ key: s.origin, ...sum(series[i] ?? []) }));
    return { groupBy: 'origin', totals: sum(series.flat()), groups };
}

let applied = false;

const seedTitles = [
    'Plan the week',
    'Draft the studio email',
    'Summarise quarterly notes',
    'Trip packing list',
    'Reading list for autumn',
];
const seedDocs = ['Weekly review', 'Reading notes', 'Studio contacts'];

/** Sample conversations and documents. Each is added only when nothing by its title exists yet,
 *  so applying the preview again (or against a real API) does not pile up copies. */
async function seed(): Promise<{ convId: string | undefined; docId: string | undefined }> {
    const data = useData.getState();
    await data.saveSettings({ name: 'Hunter' });
    const titles = new Set(Object.values(data.conversations).map((c) => c.title));
    let convId: string | undefined;
    for (const [i, t] of seedTitles.entries()) {
        if (titles.has(t)) continue;
        const c = await data.createConversation(t);
        data.updateConversation(c.id, (x) => ({
            ...x,
            updatedAt: Date.now() - i * 3_600_000 * 5,
            messages: [
                {
                    id: c.id + 'u',
                    role: 'user',
                    content: 'Help me ' + t.toLowerCase() + '.',
                    createdAt: Date.now(),
                },
                {
                    id: c.id + 'a',
                    role: 'assistant',
                    content: sampleReply,
                    createdAt: Date.now(),
                    tools: i === 0 ? ['Read', 'Write'] : undefined,
                },
            ],
        }));
        if (i === 0) convId = c.id;
    }
    const docTitles = new Set(useData.getState().docs.map((d) => d.title));
    let docId: string | undefined;
    for (const t of seedDocs) {
        if (docTitles.has(t)) continue;
        const d = await data.createDoc(t);
        if (t === 'Weekly review') {
            await data.writeDoc(
                d.id,
                '# Weekly review\n\nA few notes from this week, kept short.\n\n## What moved\n\n- The desktop app now runs against local Claude Code\n- Documents save as plain markdown\n\n## What is next\n\n1. Floating sidebar\n2. Notion-style spacing\n\n> Keep the chrome quiet and let the type carry it.',
            );
            docId = d.id;
        }
    }
    return { convId, docId };
}

export async function applyPreview(): Promise<void> {
    if (applied) return; // StrictMode runs the mount effect twice in dev
    applied = true;
    keepInMemory();
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has('api')) {
        const token = p.get('token') ?? '';
        // Read once; keep the token out of the address bar and the history from here on.
        p.delete('token');
        history.replaceState(null, '', `${location.pathname}${location.search}#${p}`);
        await useData.getState().saveSettings({ apiUrl: p.get('api') ?? '', apiToken: token });
    }
    if (p.has('mock')) {
        mockApi();
        await useData.getState().saveSettings({ apiUrl: MOCK_URL, apiToken: 'preview' });
    } else if (p.has('seed') && !p.has('api')) {
        // Sample data goes into local files (in memory), never into an API saved in settings.
        await useData.getState().saveSettings({ apiUrl: '', apiToken: '' });
    }
    const data = useData.getState();
    const app = useApp.getState();
    let convId: string | undefined = recentConversations(data.conversations, 1)[0]?.id;
    let docId: string | undefined = data.docs[0]?.id;
    if (p.has('mock')) convId = 'c1';

    if (p.has('seed')) {
        const seeded = await seed();
        convId = seeded.convId ?? convId;
        docId = seeded.docId ?? docId;
    }

    const v = p.get('view');
    if (v) {
        const views: Record<string, View> = {
            conversation: { name: 'conversation', id: convId ?? '' },
            conversations: { name: 'conversations' },
            documents: { name: 'documents', id: docId },
            automations: { name: 'automations' },
            pageviews: { name: 'pageviews' },
            settings: { name: 'settings' },
        };
        const target = views[v];
        if (target) app.navigate(target);
    }
    if (p.has('sidebar')) app.setSidebar(true);
    if (p.has('console')) app.setConsole(true);
}
