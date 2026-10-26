import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';
import { BUILTIN_MCP_SERVER } from './service.js';

const stringMap = z.record(z.string().min(1).max(200), z.string().max(10_000));

const fields = {
    name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, 'Use lowercase letters, digits, - and _ (max 48)'),
    transport: z.enum(['http', 'sse', 'stdio']),
    url: z.url().nullable(),
    command: z.string().trim().min(1).max(1000).nullable(),
    args: z.array(z.string().max(1000)).max(100),
    headers: stringMap,
    env: stringMap,
    enabled: z.boolean(),
};

const createBody = z.object({
    ...fields,
    url: fields.url.optional(),
    command: fields.command.optional(),
    args: fields.args.optional(),
    headers: fields.headers.optional(),
    env: fields.env.optional(),
    enabled: fields.enabled.optional(),
});

const byId = validate('param', z.object({ id: z.uuid() }));

export const mcpServersRoutes = ({ mcpServers }: Services) =>
    new Hono()
        .basePath('/mcp-servers')
        .get('/', async (c) => c.json({ items: await mcpServers.list() }))
        .post('/', validate('json', createBody), async (c) =>
            c.json(await mcpServers.create(c.req.valid('json')), 201),
        )
        .get('/:id', byId, async (c) => c.json(await mcpServers.get(c.req.valid('param').id)))
        .patch('/:id', byId, validate('json', z.object(fields).partial()), async (c) =>
            c.json(await mcpServers.update(c.req.valid('param').id, c.req.valid('json'))),
        )
        .delete('/:id', byId, async (c) =>
            c.json(await mcpServers.remove(c.req.valid('param').id)),
        );

/** Everything a harness needs to give the agent its tools, secrets included. */
export const agentRoutes = ({ mcpServers }: Services) =>
    new Hono().basePath('/agent').get('/config', async (c) =>
        c.json({
            builtinServer: { name: BUILTIN_MCP_SERVER, path: '/mcp' },
            mcpServers: await mcpServers.forAgent(),
        }),
    );
