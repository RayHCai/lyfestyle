import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createSecretBox } from '../src/lib/crypto.js';
import { createMcpServersService } from '../src/mcp-servers/service.js';
import { createTestContext, TEST_TOKEN, TEST_URL, type TestContext } from '../src/testing.js';
import { createToolRegistry, defineTool } from '../src/tools/registry.js';

let t: TestContext;
beforeAll(async () => {
    t = await createTestContext();
});
afterAll(() => t.close());

async function connectMcp(fetch: typeof globalThis.fetch = t.fetch, token = TEST_TOKEN) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${TEST_URL}/mcp`), {
        fetch,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
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

    it('hides why an unexpected failure happened from the agent', async () => {
        const tools = createToolRegistry(
            [
                defineTool({
                    name: 'boom',
                    description: 'Fails',
                    input: z.object({}),
                    run: () => Promise.reject(new Error('password=hunter2 in a stack trace')),
                }),
            ],
            async () => new Set(),
        );
        const app = createApp({ ...t.services, tools });
        const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
            app.fetch(new Request(input, init))) as typeof globalThis.fetch;
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        const client = await connectMcp(fetch);
        const result = await client.callTool({ name: 'boom', arguments: {} });
        expect(result.isError).toBe(true);
        const text = (result.content as { text: string }[])[0]!.text;
        expect(JSON.parse(text)).toEqual({ error: 'internal', message: 'Internal server error' });
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
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

    it('rejects a malformed body or tool name, and takes no body as no arguments', async () => {
        const post = (path: string, body?: string) =>
            t.app.request(path, {
                method: 'POST',
                headers: { authorization: `Bearer ${TEST_TOKEN}` },
                ...(body === undefined ? {} : { body }),
            });
        const malformed = await post('/tools/todos_create', '{"title": ');
        expect(malformed.status).toBe(400);
        expect((await malformed.json()).error).toMatchObject({
            code: 'invalid_request',
            message: 'Body must be JSON',
        });
        expect((await post('/tools/Not-A-Tool', '{}')).status).toBe(400);
        expect((await post('/tools/automations_list')).status).toBe(200);
    });

    it('lets the agent propose automations, which wait for approval', async () => {
        const res = await t.call('POST', '/tools/automations_deploy', {
            name: 'Weekly review',
            schedule: '0 18 * * 5',
            timezone: 'Europe/London',
            code: 'export default async (ctx) => ctx.notify("Review your week")',
        });
        expect(res.body.result).toMatchObject({ name: 'Weekly review', status: 'pending' });
        expect((await t.call('POST', '/tools/automations_list', {})).body.result).toEqual([]);
        const deploy = await t.call('GET', `/automations/deploys/${res.body.result.id}`);
        expect(deploy.body).toMatchObject({ origin: 'user', runId: null });
    });

    it('records which run proposed a deploy, and refuses automation runs', async () => {
        const proposal = {
            name: 'From chat',
            schedule: '0 9 * * *',
            code: 'export default async (ctx) => ctx.notify("Morning")',
        };
        const chat = await claimRun('chat');
        const proposed = await toolCall(chat.agentToken, 'automations_deploy', proposal);
        expect(proposed.status).toBe(200);
        const { result } = await proposed.json();
        const deploy = await t.call('GET', `/automations/deploys/${result.id}`);
        expect(deploy.body).toMatchObject({ origin: 'chat', runId: chat.run.id });
        await t.call('POST', `/runs/${chat.run.id}/complete`, { status: 'succeeded' });

        const unattended = await claimRun('automation');
        const listed = await t.app.request('/tools', {
            headers: { authorization: `Bearer ${unattended.agentToken}` },
        });
        const names = (await listed.json()).items.map((tool: { name: string }) => tool.name);
        expect(names).toContain('pages_search');
        expect(names).toContain('automations_list');
        for (const name of [
            'automations_deploy',
            'automations_run',
            'automations_set_enabled',
            'automations_delete',
        ]) {
            expect(names).not.toContain(name);
        }
        const refused = await toolCall(unattended.agentToken, 'automations_deploy', proposal);
        expect(refused.status).toBe(403);
        expect((await refused.json()).error.code).toBe('forbidden');
        await t.call('POST', `/runs/${unattended.run.id}/complete`, { status: 'succeeded' });
    });
});

/** Queues a run of `kind` and claims it as a runner would. */
async function claimRun(kind: 'chat' | 'automation') {
    const { db, runs } = t.services;
    if (kind === 'chat') {
        const convo = (await t.call('POST', '/conversations', {})).body;
        await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'go' });
    } else {
        runs.announce([await db.$transaction((tx) => runs.enqueue(tx, { kind, prompt: 'go' }))]);
    }
    const claimed = await t.call('POST', '/runs/claim', { runnerId: 'r', harness: 'fake' });
    expect(claimed.body.run.kind).toBe(kind);
    return claimed.body as { run: { id: string }; agentToken: string };
}

function toolCall(token: string, name: string, input: unknown) {
    return t.app.request(`/tools/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
    });
}

describe('notifications', () => {
    it('tells a fresh client where the newest notification is', async () => {
        expect((await t.call('GET', '/notifications?limit=1')).body).toEqual({
            items: [],
            latestId: null,
        });
        await t.call('POST', '/tools/notify', { title: 'One' });
        await t.call('POST', '/notifications', { title: 'Two', body: 'Second' });
        const first = await t.call('GET', '/notifications?limit=1');
        expect(first.body.items.map((n: { title: string }) => n.title)).toEqual(['Two']);
        expect(first.body.latestId).toBe(first.body.items[0].id);
        const after = await t.call('GET', `/notifications?after=${first.body.latestId}`);
        expect(after.body).toEqual({ items: [], latestId: first.body.latestId });
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

        const row = await t.services.db.mcpServer.findFirst();
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

    it('never shows a url path, args, headers or env, but hands them to the runner', async () => {
        const created = await t.call('POST', '/mcp-servers', {
            name: 'todo',
            transport: 'http',
            url: 'https://user:pw@todo.example:8443/mcp/sk_live_path_secret?key=query_secret',
            headers: { 'X-Key': 'header_secret' },
        });
        const stdio = await t.call('POST', '/mcp-servers', {
            name: 'local',
            transport: 'stdio',
            command: 'local-mcp',
            args: ['--token', 'arg_secret'],
            env: { TOKEN: 'env_secret' },
        });
        expect(created.body).toMatchObject({
            url: 'https://todo.example:8443/…',
            argCount: 0,
            headerNames: ['X-Key'],
            secretsUnavailable: false,
        });
        expect(stdio.body).toMatchObject({ url: null, command: 'local-mcp', argCount: 2 });

        const responses = [
            created.body,
            stdio.body,
            (await t.call('GET', '/mcp-servers')).body,
            (await t.call('GET', `/mcp-servers/${created.body.id}`)).body,
            (await t.call('PATCH', `/mcp-servers/${stdio.body.id}`, { enabled: true })).body,
        ];
        const rows = await t.services.db.mcpServer.findMany();
        for (const text of [JSON.stringify(responses), JSON.stringify(rows)]) {
            for (const secret of [
                'user:pw',
                'sk_live',
                'query_secret',
                'arg_secret',
                'header_secret',
                'env_secret',
            ]) {
                expect(text).not.toContain(secret);
            }
        }

        const config = (await t.call('GET', '/agent/config')).body.mcpServers;
        expect(config).toContainEqual({
            name: 'todo',
            transport: 'http',
            url: 'https://user:pw@todo.example:8443/mcp/sk_live_path_secret?key=query_secret',
            headers: { 'X-Key': 'header_secret' },
        });
        expect(config).toContainEqual({
            name: 'local',
            transport: 'stdio',
            command: 'local-mcp',
            args: ['--token', 'arg_secret'],
            env: { TOKEN: 'env_secret' },
        });
    });

    it('drops what a new transport cannot use, and keeps names unique on rename', async () => {
        const local = (await t.call('GET', '/mcp-servers')).body.items.find(
            (s: { name: string }) => s.name === 'local',
        );
        const switched = await t.call('PATCH', `/mcp-servers/${local.id}`, {
            transport: 'sse',
            url: 'https://local.example/sse',
        });
        expect(switched.body).toMatchObject({
            transport: 'sse',
            url: 'https://local.example/…',
            command: null,
            argCount: 0,
        });
        const back = await t.call('PATCH', `/mcp-servers/${local.id}`, {
            transport: 'stdio',
            command: 'local-mcp',
        });
        expect(back.body).toMatchObject({ transport: 'stdio', url: null, command: 'local-mcp' });
        const config = (await t.call('GET', '/agent/config')).body.mcpServers;
        expect(config).toContainEqual(expect.objectContaining({ name: 'local', args: [] }));

        const clash = await t.call('PATCH', `/mcp-servers/${local.id}`, { name: 'todo' });
        expect(clash.status).toBe(409);
        expect(clash.body.error.message).toBe('An MCP server named "todo" already exists');
        expect((await t.call('GET', `/mcp-servers/${crypto.randomUUID()}`)).status).toBe(404);
    });

    it('moves a url and args stored in the clear into the sealed secret', async () => {
        const row = await t.services.db.mcpServer.create({
            data: {
                name: 'legacy',
                transport: 'stdio',
                command: 'old-mcp',
                args: ['--key', 'legacy_secret'],
                secret: t.services.secrets.seal({ headers: {}, env: {} }),
            },
        });
        const shown = (await t.call('GET', `/mcp-servers/${row.id}`)).body;
        expect(shown).toMatchObject({ name: 'legacy', argCount: 2 });
        const upgraded = await t.services.db.mcpServer.findUniqueOrThrow({ where: { id: row.id } });
        expect(upgraded.args).toEqual([]);
        expect(t.services.secrets.open(upgraded.secret)).toMatchObject({
            args: ['--key', 'legacy_secret'],
        });
        const config = (await t.call('GET', '/agent/config')).body.mcpServers;
        expect(config).toContainEqual(
            expect.objectContaining({ name: 'legacy', args: ['--key', 'legacy_secret'] }),
        );
        await t.call('DELETE', `/mcp-servers/${row.id}`);
    });

    it('lists and deletes servers whose secrets no longer decrypt', async () => {
        const other = createMcpServersService({
            db: t.services.db,
            secrets: createSecretBox(Buffer.alloc(32, 9)),
            now: () => new Date(),
        });
        const orphan = await other.create({
            name: 'orphan',
            transport: 'http',
            url: 'https://orphan.example/mcp',
        });
        const listed = (await t.call('GET', '/mcp-servers')).body.items;
        expect(listed.find((s: { name: string }) => s.name === 'orphan')).toMatchObject({
            secretsUnavailable: true,
            url: 'https://orphan.example/…',
            headerNames: [],
        });
        const config = (await t.call('GET', '/agent/config')).body.mcpServers;
        expect(config.map((s: { name: string }) => s.name)).not.toContain('orphan');
        const patched = await t.call('PATCH', `/mcp-servers/${orphan.id}`, { enabled: false });
        expect(patched.status).toBe(409);
        const removed = await t.call('DELETE', `/mcp-servers/${orphan.id}`);
        expect(removed.status).toBe(200);
        expect((await t.call('GET', `/mcp-servers/${orphan.id}`)).status).toBe(404);
    });
});
