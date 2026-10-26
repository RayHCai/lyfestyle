import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import type { JSONValue } from 'hono/utils/types';
import { ApiError } from '../lib/errors.js';
import type { Services } from '../services.js';
import type { ToolRegistry } from './registry.js';

const INSTRUCTIONS = [
    'Tools for the user’s Lyfestyle hub: their knowledge base (pages), planner (todos and monthly goals),',
    'scheduled automations, and whichever of Canvas and outbound email are connected.',
    'Pages are markdown; link pages with [label](page:<id>).',
].join(' ');

function errorText(err: unknown): string {
    if (err instanceof ApiError) {
        return JSON.stringify({ error: err.code, message: err.message, details: err.details });
    }
    return err instanceof Error ? err.message : String(err);
}

/** A fresh stateless MCP server per request, so tool lists track which integrations are connected. */
function mcpServer(tools: ToolRegistry): Server {
    const server = new Server(
        { name: 'lyfestyle', version: '0.1.0' },
        { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (await tools.available()).map((tool) => {
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
        try {
            const result = await tools.call(request.params.name, request.params.arguments);
            return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
        } catch (err) {
            return { content: [{ type: 'text', text: errorText(err) }], isError: true };
        }
    });
    return server;
}

export const mcpRoutes = ({ tools }: Services) =>
    new Hono().basePath('/mcp').all('/', async (c) => {
        const transport = new WebStandardStreamableHTTPServerTransport({
            enableJsonResponse: true,
        });
        const server = mcpServer(tools);
        await server.connect(transport);
        try {
            return await transport.handleRequest(c.req.raw);
        } finally {
            void server.close();
        }
    });

/** The same tools over plain HTTP, for the UI and for harnesses that do not speak MCP. */
export const toolsRoutes = ({ tools }: Services) =>
    new Hono()
        .basePath('/tools')
        .get('/', async (c) => c.json({ items: (await tools.available()).map(tools.describe) }))
        .post('/:name', async (c) => {
            const name = c.req.param('name');
            const args = await c.req.json().catch(() => ({}));
            return c.json({ result: (await tools.call(name, args)) as JSONValue });
        });
