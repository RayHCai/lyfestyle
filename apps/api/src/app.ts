import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { conversationsRoutes, jobsRoutes, runsRoutes, usageRoutes } from './agent/routes.js';
import { integrationsRoutes } from './integrations/routes.js';
import { safeEqual } from './lib/crypto.js';
import { ApiError } from './lib/errors.js';
import { agentRoutes, mcpServersRoutes } from './mcp-servers/routes.js';
import { metricsRoutes, PUBLIC_METRICS_PATHS } from './metrics/routes.js';
import { pagesRoutes } from './pages/routes.js';
import { syncRoutes } from './pages/sync-routes.js';
import type { Services } from './services.js';
import { goalsRoutes, todosRoutes } from './todos/routes.js';
import { mcpRoutes, toolsRoutes } from './tools/routes.js';

export type { Services } from './services.js';

/** Reached without a bearer token: other sites cannot carry one. */
const PUBLIC_PATHS = new Set(['/health', ...PUBLIC_METRICS_PATHS]);

/** Any website may report a view; credentials are never involved. */
const collectCors = cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
});

export function createApp(services: Services) {
    const { config } = services;
    const app = new Hono();

    const appCors = cors({
        origin: config.corsOrigins,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: [
            'Authorization',
            'Content-Type',
            'Last-Event-ID',
            'Mcp-Session-Id',
            'Mcp-Protocol-Version',
        ],
        exposeHeaders: ['Mcp-Session-Id'],
    });
    app.use('*', (c, next) =>
        c.req.path === '/metrics/collect' ? collectCors(c, next) : appCors(c, next),
    );

    app.use('*', async (c, next) => {
        if (PUBLIC_PATHS.has(c.req.path)) return next();
        const header = c.req.header('authorization') ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!token || !safeEqual(token, config.apiToken)) {
            throw new ApiError(401, 'unauthorized', 'Missing or invalid bearer token');
        }
        await next();
    });

    app.onError((err, c) => {
        if (err instanceof ApiError) return c.json(err.toJSON(), err.status);
        if (err instanceof HTTPException) {
            return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
        }
        console.error(err);
        return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
    });

    app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404));

    const groups = routeGroups(services);
    return app
        .get('/health', (c) => c.json({ ok: true }))
        .route('/', groups.pages)
        .route('/', groups.sync)
        .route('/', groups.todos)
        .route('/', groups.goals)
        .route('/', groups.conversations)
        .route('/', groups.runs)
        .route('/', groups.jobs)
        .route('/', groups.usage)
        .route('/', groups.metrics)
        .route('/', groups.integrations)
        .route('/', groups['mcp-servers'])
        .route('/', groups.agent)
        .route('/', groups.tools)
        .route('/', groups.mcp);
}

/** Each router carries its own base path, so clients can be typed one group at a time. */
function routeGroups(services: Services) {
    return {
        pages: pagesRoutes(services),
        sync: syncRoutes(services),
        todos: todosRoutes(services),
        goals: goalsRoutes(services),
        conversations: conversationsRoutes(services),
        runs: runsRoutes(services),
        jobs: jobsRoutes(services),
        usage: usageRoutes(services),
        metrics: metricsRoutes(services),
        integrations: integrationsRoutes(services),
        'mcp-servers': mcpServersRoutes(services),
        agent: agentRoutes(services),
        tools: toolsRoutes(services),
        mcp: mcpRoutes(services),
    };
}

/** Route types by top-level path; `@lyfestyle/client` builds one typed client per entry. */
export type RouteGroups = ReturnType<typeof routeGroups>;

export type AppType = ReturnType<typeof createApp>;
