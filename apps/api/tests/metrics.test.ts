import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../src/testing.js';

let t: TestContext;
let clock = new Date('2026-10-26T12:00:00Z');
beforeAll(async () => {
    t = await createTestContext({
        env: { METRICS_ORIGINS: 'https://blog.example,https://shop.example' },
        now: () => clock,
    });
});
afterAll(() => t.close());

/** A beacon as a browser sends it: no bearer token, a text/plain body. */
function beacon(body: unknown, headers: Record<string, string> = {}) {
    return t.app.request('/metrics/collect', {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

describe('metrics', () => {
    it('records views from any visitor without a token', async () => {
        const res = await beacon(
            {
                url: 'https://blog.example/posts/hello?ref=x',
                title: 'Hello',
                referrer: 'https://news.example/front',
                props: { plan: 'free' },
            },
            {
                origin: 'https://blog.example',
                'x-forwarded-for': '203.0.113.7, 10.0.0.1',
                'user-agent': 'TestBrowser/1.0',
            },
        );
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');

        const list = await t.call('GET', '/metrics/views');
        expect(list.body.items[0]).toMatchObject({
            origin: 'https://blog.example',
            path: '/posts/hello',
            url: 'https://blog.example/posts/hello?ref=x',
            title: 'Hello',
            ip: '203.0.113.7',
            userAgent: 'TestBrowser/1.0',
            props: { plan: 'free' },
        });
    });

    it('answers the CORS preflight for any origin', async () => {
        const res = await t.app.request('/metrics/collect', {
            method: 'OPTIONS',
            headers: {
                origin: 'https://shop.example',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'content-type',
            },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('rejects unlisted sites, mismatched origins and junk', async () => {
        expect((await beacon({ url: 'https://evil.example/' })).status).toBe(403);
        expect(
            (await beacon({ url: 'https://blog.example/' }, { origin: 'https://evil.example' }))
                .status,
        ).toBe(400);
        expect((await beacon('not json')).status).toBe(400);
        expect((await beacon({ url: 'javascript:alert(1)' })).status).toBe(400);
        expect(
            (await beacon({ url: 'https://blog.example/', title: 'x'.repeat(20_000) })).status,
        ).toBe(413);
    });

    it('keeps the read side behind the token', async () => {
        expect((await t.app.request('/metrics/views')).status).toBe(401);
        expect((await t.app.request('/metrics/views/summary')).status).toBe(401);
    });

    it('summarizes views and distinct visitors', async () => {
        clock = new Date('2026-10-27T12:00:00Z');
        const ip = (addr: string) => ({ 'x-forwarded-for': addr });
        await beacon({ url: 'https://shop.example/' }, ip('198.51.100.1'));
        await beacon({ url: 'https://shop.example/cart' }, ip('198.51.100.1'));
        await beacon({ url: 'https://shop.example/' }, ip('198.51.100.2'));

        const byOrigin = await t.call('GET', '/metrics/views/summary?groupBy=origin');
        expect(byOrigin.body.totals).toEqual({ views: 4, visitors: 3 });
        expect(byOrigin.body.groups).toEqual([
            { key: 'https://shop.example', views: 3, visitors: 2 },
            { key: 'https://blog.example', views: 1, visitors: 1 },
        ]);

        const byDay = await t.call('GET', '/metrics/views/summary?origin=https://shop.example');
        expect(byDay.body.groups).toEqual([{ key: '2026-10-27', views: 3, visitors: 2 }]);

        const byReferrer = await t.call('GET', '/metrics/views/summary?groupBy=referrer');
        expect(byReferrer.body.groups).toContainEqual({
            key: 'news.example',
            views: 1,
            visitors: 1,
        });
    });

    it('serves a tracker pointed at this API', async () => {
        const res = await t.app.request('/metrics/script.js');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('javascript');
        expect(await res.text()).toContain('"http://api.test/metrics/collect"');
    });
});
