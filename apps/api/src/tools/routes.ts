import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hono, type Context } from 'hono';
import type { JSONValue } from 'hono/utils/types';
import { z } from 'zod';
import { ApiError, badRequest } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';
import type { CallerEnv, ToolContext, ToolRegistry } from './registry.js';

const INSTRUCTIONS = [
    'Tools for the user’s Lyfestyle hub: their knowledge base (pages), planner (todos and monthly goals),',
    'scheduled automations, and whichever of Canvas and outbound email are connected.',
    'Pages are markdown; link pages with [label](page:<id>).',
].join(' ');

/** What the agent sees of a failure: API errors in full, anything else only as a generic message. */
function errorText(err: unknown, name: string): string {
    if (err instanceof ApiError) {
        return JSON.stringify({ error: err.code, message: err.message, details: err.details });
    }
    console.error(`Tool ${name} failed`, err);
    return JSON.stringify({ error: 'internal', message: 'Internal server error' });
}

/** A fresh stateless MCP server per request, so tool lists track which integrations are connected. */
function mcpServer(tools: ToolRegistry, ctx: ToolContext): Server {
    const server = new Server(
        { name: 'lyfestyle', version: '0.1.0' },
        { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (await tools.available(ctx)).map((tool) => {
            const { name, description, inputSchema, readOnly, destructive } = tools.describe(tool);
            return {
                name,
                description,
                inputSchema: inputSchema as { type: 'object' },
                annotations: { readOnlyHint: readOnly, destructiveHint: destructive },
            };
        }),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name } = request.params;
        try {
            const result = await tools.call(name, request.params.arguments, ctx);
            return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
        } catch (err) {
            return { content: [{ type: 'text', text: errorText(err, name) }], isError: true };
        }
    });
    return server;
}

export const mcpRoutes = ({ tools }: Services) =>
    new Hono<CallerEnv>().basePath('/mcp').all('/', async (c) => {
        const transport = new WebStandardStreamableHTTPServerTransport({
            enableJsonResponse: true,
        });
        const server = mcpServer(tools, c.get('caller'));
        await server.connect(transport);
        try {
            return await transport.handleRequest(c.req.raw);
        } finally {
            void server.close();
        }
    });

/** A tool input: an absent body is no arguments at all, a malformed one is a 400. */
async function toolInput(c: Context): Promise<unknown> {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw badRequest('Body must be JSON');
    }
}

/** The same tools over plain HTTP, for the UI and for harnesses that do not speak MCP. */
export const toolsRoutes = ({ tools }: Services) =>
    new Hono<CallerEnv>()
        .basePath('/tools')
        .get('/', async (c) =>
            c.json({ items: (await tools.available(c.get('caller'))).map(tools.describe) }),
        )
        .post(
            '/:name',
            validate('param', z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) })),
            async (c) => {
                const { name } = c.req.valid('param');
                const result = await tools.call(name, await toolInput(c), c.get('caller'));
                return c.json({ result: result as JSONValue });
            },
        );
