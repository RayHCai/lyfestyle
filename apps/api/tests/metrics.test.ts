import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiError } from '../src/lib/errors.js';
import { createMetricsService } from '../src/metrics/service.js';
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
                // The visitor can put anything first; the proxy appends the peer it saw.
                'x-forwarded-for': '10.9.9.9, 203.0.113.7',
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

    it('needs an Origin header when METRICS_ORIGINS lists sites', async () => {
        const res = await beacon({ url: 'https://blog.example/' });
        expect(res.status).toBe(403);
        expect((await res.json()).error.code).toBe('forbidden');
        const hidden = await beacon({ url: 'https://blog.example/' }, { origin: 'null' });
        expect(hidden.status).toBe(403);
    });

    it('caps field sizes', async () => {
        const site = { origin: 'https://blog.example' };
        const view = (extra: object) => beacon({ url: 'https://blog.example/', ...extra }, site);
        expect((await view({ title: 'x'.repeat(301) })).status).toBe(400);
        expect((await view({ referrer: `https://a.example/${'x'.repeat(2048)}` })).status).toBe(
            400,
        );
        const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
        expect((await view({ props: many })).status).toBe(400);
        expect((await view({ props: { ['k'.repeat(51)]: 1 } })).status).toBe(400);
        expect((await view({ props: { plan: 'x'.repeat(201) } })).status).toBe(400);
    });

    it('keeps the read side behind the token', async () => {
        expect((await t.app.request('/metrics/views')).status).toBe(401);
        expect((await t.app.request('/metrics/views/summary')).status).toBe(401);
    });

    it('summarizes views and distinct visitors', async () => {
        clock = new Date('2026-10-27T12:00:00Z');
        const ip = (addr: string) => ({
            'x-forwarded-for': addr,
            origin: 'https://shop.example',
        });
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

    it('limits each address to 60 beacons a minute', async () => {
        const from = { 'x-forwarded-for': '192.0.2.50' };
        for (let i = 0; i < 60; i++) expect((await beacon('junk', from)).status).toBe(400);
        const limited = await beacon('junk', from);
        expect(limited.status).toBe(429);
        expect((await limited.json()).error.code).toBe('rate_limited');
        expect((await beacon('junk', { 'x-forwarded-for': '192.0.2.51' })).status).toBe(400);
    });

    it('caps views per day and refills each address over the minute', async () => {
        let at = new Date('2026-10-28T00:00:00Z');
        const metrics = createMetricsService({
            db: t.services.db,
            now: () => at,
            config: { metricsOrigins: '*', metricsRetentionDays: 0 },
            limits: { perIpPerMinute: 2, perDay: 3 },
        });
        const send = (ip: string) =>
            metrics.collect({
                body: JSON.stringify({ url: 'https://capped.example/' }),
                origin: undefined,
                forwardedFor: ip,
                remoteAddress: null,
                userAgent: undefined,
            });
        const status = (p: Promise<unknown>) =>
            p.then(
                () => 204,
                (err: ApiError) => err.status,
            );
        expect(await status(send('192.0.2.1'))).toBe(204);
        expect(await status(send('192.0.2.1'))).toBe(204);
        expect(await status(send('192.0.2.1'))).toBe(429);
        at = new Date(at.getTime() + 30_000);
        expect(await status(send('192.0.2.1'))).toBe(204);
        expect(await status(send('192.0.2.2'))).toBe(429);
        at = new Date('2026-10-29T00:00:01Z');
        expect(await status(send('192.0.2.2'))).toBe(204);
    });

    it('serves a tracker pointed at this API', async () => {
        const res = await t.app.request('/metrics/script.js');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('javascript');
        expect(await res.text()).toContain('"http://api.test/metrics/collect"');
    });

    it('purges views older than the retention period', async () => {
        const at = new Date('2027-06-01T00:00:00Z');
        const keep = (days: number) =>
            createMetricsService({
                db: t.services.db,
                now: () => at,
                config: { metricsOrigins: '*', metricsRetentionDays: days },
            });
        const before = await t.services.db.pageView.count();
        expect(await keep(0).purgeExpired(at)).toBe(0);
        // Everything above was recorded in late October 2026, over 200 days before `at`.
        expect(await keep(400).purgeExpired(at)).toBe(0);
        expect(await keep(200).purgeExpired(at)).toBe(before);
        expect(await t.services.db.pageView.count()).toBe(0);
    });
});
