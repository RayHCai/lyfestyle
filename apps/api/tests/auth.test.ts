import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { createTestContext, TEST_TOKEN, TEST_URL, type TestContext } from '../src/testing.js';

let t: TestContext;
beforeAll(async () => {
    t = await createTestContext();
});
afterAll(() => t.close());

function send(method: string, path: string, token?: string, body?: string) {
    return t.app.request(path, {
        method,
        headers: {
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        ...(body === undefined ? {} : { body }),
    });
}

/** One read per route group, plus the runner and settings routes an agent must never reach. */
const ROUTES: [string, string][] = [
    ['GET', '/pages'],
    ['GET', '/sync/pull'],
    ['GET', '/todos/board?today=2026-10-26'],
    ['GET', '/goals?from=2026-10-01&to=2026-10-31'],
    ['GET', '/conversations'],
    ['GET', '/runs'],
    ['POST', '/runs/claim'],
    ['GET', '/automations'],
    ['GET', '/automations/deploys'],
    ['GET', '/notifications'],
    ['GET', '/usage'],
    ['GET', '/metrics/views'],
    ['GET', '/integrations'],
    ['GET', '/mcp-servers'],
    ['POST', '/mcp-servers'],
    ['GET', '/agent/config'],
];

/** A running chat turn, and the agent token its claim handed out. */
async function runningTurn() {
    while (
        (await t.call('POST', '/runs/claim', { runnerId: 'r', harness: 'fake' })).status === 200
    ) {
        // Earlier tests may leave queued runs behind.
    }
    const convo = (await t.call('POST', '/conversations', {})).body;
    await t.call('POST', `/conversations/${convo.id}/messages`, { text: 'hi' });
    const claimed = await t.call('POST', '/runs/claim', { runnerId: 'r', harness: 'fake' });
    expect(claimed.status).toBe(200);
    return { run: claimed.body.run, token: claimed.body.agentToken as string };
}

const mcpList = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

describe('bearer auth', () => {
    it('rejects every route group without the token', async () => {
        for (const [method, path] of [...ROUTES, ['GET', '/tools'], ['POST', '/mcp']]) {
            const res = await send(method!, path!);
            expect([method, path, res.status]).toEqual([method, path, 401]);
            expect((await res.json()).error.code).toBe('unauthorized');
        }
        expect((await send('GET', '/pages', 'wrong-token')).status).toBe(401);
    });

    it('accepts any capitalisation of the Bearer scheme', async () => {
        const res = await t.app.request('/pages', {
            headers: { authorization: `bEaReR   ${TEST_TOKEN}` },
        });
        expect(res.status).toBe(200);
    });

    it('lets health through and reports the database', async () => {
        expect(await (await t.app.request('/health')).json()).toEqual({ ok: true });
        const down = createApp({
            ...t.services,
            db: {
                $queryRaw: () => Promise.reject(new Error('connection refused')),
            } as unknown as Db,
        });
        const res = await down.request('/health');
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ ok: false });
    });
});

describe('agent tokens', () => {
    it('come with every claim and reach only the tools while the run runs', async () => {
        const { run, token } = await runningTurn();
        expect(token).toEqual(expect.any(String));
        expect(token).not.toBe(TEST_TOKEN);

        expect((await send('GET', '/tools', token)).status).toBe(200);
        const tool = await send('POST', '/tools/pages_list_recent', token, '{}');
        expect(tool.status).toBe(200);
        expect((await send('POST', '/mcp', token, mcpList)).status).toBe(200);

        for (const [method, path] of ROUTES) {
            const res = await send(method, path, token, method === 'GET' ? undefined : '{}');
            expect([method, path, res.status]).toEqual([method, path, 403]);
            expect((await res.json()).error.code).toBe('forbidden');
        }
        expect((await send('DELETE', `/runs/${run.id}`, token)).status).toBe(403);
        expect((await send('POST', '/tools', token)).status).toBe(403);

        await t.call('POST', `/runs/${run.id}/complete`, { status: 'succeeded' });
        expect((await send('GET', '/tools', token)).status).toBe(401);
        expect((await send('POST', '/mcp', token, mcpList)).status).toBe(401);
    });

    it('serve as the MCP bearer token, as the runner hands them to the agent', async () => {
        const { run, token } = await runningTurn();
        const client = new Client({ name: 'agent', version: '0.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${TEST_URL}/mcp`), {
                fetch: t.fetch,
                requestInit: { headers: { authorization: `Bearer ${token}` } },
            }),
        );
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toContain('pages_search');
        await client.close();
        await t.call('POST', `/runs/${run.id}/complete`, { status: 'succeeded' });
    });

    it('are refused once forged or tampered with', async () => {
        const { run, token } = await runningTurn();
        const forged = t.services.secrets.sign({ kind: 'other', runId: run.id }, 60_000);
        expect((await send('GET', '/tools', forged)).status).toBe(401);
        expect((await send('GET', '/tools', `${token}x`)).status).toBe(401);
        await t.call('POST', `/runs/${run.id}/complete`, { status: 'succeeded' });
    });
});

describe('error mapping', () => {
    it('answers malformed JSON with invalid_request', async () => {
        const res = await send('POST', '/conversations', TEST_TOKEN, '{"title": ');
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('invalid_request');
    });

    it('answers a bad cursor with invalid_request', async () => {
        for (const path of ['/runs', '/conversations', '/metrics/views']) {
            const res = await t.call('GET', `${path}?cursor=not-a-cursor`);
            expect([path, res.status, res.body.error.code]).toEqual([path, 400, 'invalid_request']);
        }
    });

    it('maps Prisma races to 404 and 409 without a 500', async () => {
        const app = createApp(t.services);
        const db = t.services.db;
        app.get('/test/missing', async () => {
            await db.conversation.update({ where: { id: randomUUID() }, data: { title: 'x' } });
            return new Response(null);
        });
        app.get('/test/duplicate', async () => {
            const row = { name: 'dupe', transport: 'http', secret: 'x' };
            await db.mcpServer.create({ data: row });
            await db.mcpServer.create({ data: row });
            return new Response(null);
        });
        app.get('/test/dangling', async () => {
            await db.message.create({
                data: { conversationId: randomUUID(), role: 'user', content: [] },
            });
            return new Response(null);
        });
        const auth = { headers: { authorization: `Bearer ${TEST_TOKEN}` } };
        const missing = await app.request('/test/missing', auth);
        expect(missing.status).toBe(404);
        expect((await missing.json()).error.code).toBe('not_found');
        for (const path of ['/test/duplicate', '/test/dangling']) {
            const res = await app.request(path, auth);
            expect([path, res.status]).toEqual([path, 409]);
            expect((await res.json()).error.code).toBe('conflict');
        }
        await db.mcpServer.deleteMany({ where: { name: 'dupe' } });
    });
});
