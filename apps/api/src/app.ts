import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { conversationsRoutes, runsRoutes, usageRoutes } from './agent/routes.js';
import { automationsRoutes } from './automations/routes.js';
import { integrationsRoutes } from './integrations/routes.js';
import { safeEqual } from './lib/crypto.js';
import { ApiError, forbidden, fromPrisma, unauthorized } from './lib/errors.js';
import { agentRoutes, mcpServersRoutes } from './mcp-servers/routes.js';
import { metricsRoutes, PUBLIC_METRICS_PATHS } from './metrics/routes.js';
import { notificationsRoutes } from './notifications/routes.js';
import { pagesRoutes } from './pages/routes.js';
import { syncRoutes } from './pages/sync-routes.js';
import type { Services } from './services.js';
import { goalsRoutes, todosRoutes } from './todos/routes.js';
import type { CallerEnv } from './tools/registry.js';
import { mcpRoutes, toolsRoutes } from './tools/routes.js';

/** Reached without a bearer token: other sites cannot carry one. */
const PUBLIC_PATHS = new Set(['/health', ...PUBLIC_METRICS_PATHS]);

/**
 * What a run's agent token reaches: the tools, as MCP or plain HTTP. Never `/agent/config` (other
 * servers' secrets), settings, or deploy approval.
 */
function agentMay(method: string, path: string): boolean {
    if (path === '/mcp') return true;
    if (path === '/tools') return method === 'GET';
    return method === 'POST' && /^\/tools\/[^/]+$/.test(path);
}

/** Error codes for Hono's own exceptions, e.g. a malformed JSON body. */
const HTTP_CODES: Partial<Record<number, string>> = {
    400: 'invalid_request',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    413: 'payload_too_large',
    429: 'rate_limited',
};

/** Any website may report a view; credentials are never involved. */
const collectCors = cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
});

export function createApp(services: Services) {
    const { config } = services;
    const app = new Hono<CallerEnv>();

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
        PUBLIC_METRICS_PATHS.includes(c.req.path) ? collectCors(c, next) : appCors(c, next),
    );

    // The root API_TOKEN reaches everything. A run's agent token (minted at claim) reaches only
    // the tools, and only while that run is running.
    app.use('*', async (c, next) => {
        if (PUBLIC_PATHS.has(c.req.path)) return next();
        const token = /^bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '')?.[1];
        if (!token) throw unauthorized();
        if (safeEqual(token, config.apiToken)) {
            c.set('caller', { run: null });
            return next();
        }
        const run = await services.runs.authorize(token);
        if (!run) throw unauthorized();
        if (!agentMay(c.req.method, c.req.path)) {
            throw forbidden('An agent token only reaches /mcp and /tools');
        }
        c.set('caller', { run });
        return next();
    });

    app.onError((err, c) => {
        if (err instanceof ApiError) return c.json(err.toJSON(), err.status);
        if (err instanceof HTTPException) {
            const code =
                HTTP_CODES[err.status] ?? (err.status >= 500 ? 'internal' : 'invalid_request');
            return c.json({ error: { code, message: err.message } }, err.status);
        }
        // Races a request can legitimately lose; not worth a log line full of values.
        const expected = fromPrisma(err);
        if (expected) return c.json(expected.toJSON(), expected.status);
        console.error(err);
        return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
    });

    app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404));

    const groups = routeGroups(services);
    return app
        .get('/health', async (c) => {
            try {
                await services.db.$queryRaw`select 1`;
                return c.json({ ok: true }, 200);
            } catch {
                return c.json({ ok: false }, 503);
            }
        })
        .route('/', groups.pages)
        .route('/', groups.sync)
        .route('/', groups.todos)
        .route('/', groups.goals)
        .route('/', groups.conversations)
        .route('/', groups.runs)
        .route('/', groups.automations)
        .route('/', groups.notifications)
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
        automations: automationsRoutes(services),
        notifications: notificationsRoutes(services),
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
