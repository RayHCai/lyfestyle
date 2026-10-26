import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpServers } from '../src/db/schema.js';
import { createTestContext, TEST_TOKEN, TEST_URL, type TestContext } from '../src/testing.js';

let t: TestContext;
beforeAll(async () => {
    t = await createTestContext();
});
afterAll(() => t.close());

async function connectMcp() {
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${TEST_URL}/mcp`), {
        fetch: t.fetch,
        requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    });
    await client.connect(transport);
    return client;
}

describe('MCP endpoint', () => {
    it('serves the tool list with JSON schemas and annotations', async () => {
        const client = await connectMcp();
        const { tools } = await client.listTools();
        const search = tools.find((tool) => tool.name === 'pages_search')!;
        expect(search.inputSchema).toMatchObject({
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
        });
        expect(search.annotations).toMatchObject({ readOnlyHint: true });
        expect(
            tools.find((tool) => tool.name === 'todos_delete')!.annotations?.destructiveHint,
        ).toBe(true);
        expect(tools.some((tool) => tool.name.startsWith('canvas_'))).toBe(false);
        await client.close();
    });

    it('calls tools end to end and reports errors as tool errors', async () => {
        const client = await connectMcp();
        const created = await client.callTool({
            name: 'pages_create',
            arguments: { title: 'From the agent', content: 'Hello' },
        });
        const page = JSON.parse((created.content as { text: string }[])[0]!.text);
        expect(page).toMatchObject({ title: 'From the agent', version: 1 });

        const found = await client.callTool({
            name: 'pages_search',
            arguments: { query: 'agent' },
        });
        expect((found.content as { text: string }[])[0]!.text).toContain(page.id);

        const missing = await client.callTool({
            name: 'pages_get',
            arguments: { id: crypto.randomUUID() },
        });
        expect(missing.isError).toBe(true);
        expect((missing.content as { text: string }[])[0]!.text).toContain('not_found');

        const invalid = await client.callTool({ name: 'todos_create', arguments: { title: 'x' } });
        expect(invalid.isError).toBe(true);
        await client.close();
    });

    it('requires the bearer token', async () => {
        const res = await t.app.request('/mcp', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        expect(res.status).toBe(401);
    });
});

describe('HTTP tools', () => {
    it('lists and runs the same tools', async () => {
        const list = await t.call('GET', '/tools');
        const board = list.body.items.find(
            (tool: { name: string }) => tool.name === 'todos_get_board',
        );
        expect(board).toMatchObject({ readOnly: true, requires: null });

        const res = await t.call('POST', '/tools/todos_create', {
            title: 'Call mom',
            scope: 'day',
            date: '2026-10-26',
        });
        expect(res.body.result).toMatchObject({ title: 'Call mom', scope: 'day' });
        expect((await t.call('POST', '/tools/nope', {})).status).toBe(404);
    });

    it('lets the agent schedule its own automations', async () => {
        const res = await t.call('POST', '/tools/automations_create', {
            name: 'Weekly review',
            prompt: 'Review my week',
            schedule: '0 18 * * 5',
            timezone: 'Europe/London',
        });
        expect(res.body.result).toMatchObject({ name: 'Weekly review', enabled: true });
        expect(res.body.result.nextRunAt).toBeTruthy();
    });
});

describe('MCP server registry', () => {
    it('stores secrets encrypted and only shows their names', async () => {
        const created = await t.call('POST', '/mcp-servers', {
            name: 'linear',
            transport: 'http',
            url: 'https://mcp.linear.app/mcp',
            headers: { Authorization: 'Bearer lin_secret' },
        });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            name: 'linear',
            headerNames: ['Authorization'],
            enabled: true,
        });
        expect(JSON.stringify(created.body)).not.toContain('lin_secret');

        const [row] = await t.services.db.select().from(mcpServers);
        expect(row!.secret).not.toContain('lin_secret');

        await t.call('POST', '/mcp-servers', {
            name: 'files',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/notes'],
            env: { DEBUG: '1' },
        });

        const config = (await t.call('GET', '/agent/config')).body;
        expect(config.builtinServer).toEqual({ name: 'lyfestyle', path: '/mcp' });
        expect(config.mcpServers).toEqual([
            {
                name: 'files',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '/notes'],
                env: { DEBUG: '1' },
            },
            {
                name: 'linear',
                transport: 'http',
                url: 'https://mcp.linear.app/mcp',
                headers: { Authorization: 'Bearer lin_secret' },
            },
        ]);
    });

    it('keeps disabled servers away from the agent', async () => {
        const list = (await t.call('GET', '/mcp-servers')).body.items;
        const files = list.find((s: { name: string }) => s.name === 'files');
        await t.call('PATCH', `/mcp-servers/${files.id}`, { enabled: false });
        const config = (await t.call('GET', '/agent/config')).body;
        expect(config.mcpServers.map((s: { name: string }) => s.name)).toEqual(['linear']);
    });

    it('rejects reserved names, duplicates and incomplete configs', async () => {
        const reserved = await t.call('POST', '/mcp-servers', {
            name: 'lyfestyle',
            transport: 'http',
            url: 'https://x.dev',
        });
        expect(reserved.status).toBe(400);
        const dupe = await t.call('POST', '/mcp-servers', {
            name: 'linear',
            transport: 'http',
            url: 'https://x.dev',
        });
        expect(dupe.status).toBe(409);
        const noCommand = await t.call('POST', '/mcp-servers', {
            name: 'local',
            transport: 'stdio',
        });
        expect(noCommand.status).toBe(400);
    });
});
