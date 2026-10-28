import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../src/testing.js';
import { fakeFetch } from './fake-fetch.js';

const net = fakeFetch();
let t: TestContext;

beforeAll(async () => {
    t = await createTestContext({
        fetch: net.fetch,
        env: {
            RESEND_API_KEY: 're_test',
            RESEND_FROM: 'Lyfestyle <agent@example.com>',
        },
    });
});
afterAll(() => t.close());

const toolNames = async () =>
    (await t.call('GET', '/tools')).body.items.map((tool: { name: string }) => tool.name);

describe('canvas', () => {
    const BASE = 'https://school.instructure.com';

    it('reports nothing connected yet, and refuses a plain-http Canvas', async () => {
        expect((await t.call('GET', '/integrations')).body).toEqual({
            canvas: { connected: false, account: null, baseUrl: null, updatedAt: null },
            resend: { configured: true, from: 'Lyfestyle <agent@example.com>' },
        });
        const http = await t.call('PUT', '/integrations/canvas', {
            baseUrl: 'http://school.instructure.com',
            token: 'good-token-123',
        });
        expect(http.status).toBe(400);
    });

    it('verifies the token before storing it', async () => {
        net.on('GET', `${BASE}/api/v1/users/self`, (req) =>
            req.headers.get('authorization') === 'Bearer good-token-123'
                ? net.json({ id: 7, name: 'Sam Student' })
                : new Response('no', { status: 401 }),
        );
        const bad = await t.call('PUT', '/integrations/canvas', {
            baseUrl: BASE,
            token: 'bad-token-123',
        });
        expect(bad.status).toBe(400);
        const good = await t.call('PUT', '/integrations/canvas', {
            baseUrl: `${BASE}/courses`,
            token: 'good-token-123',
        });
        expect(good.body).toEqual({ account: 'Sam Student', baseUrl: BASE });
        expect(await toolNames()).toContain('canvas_list_courses');
        expect((await t.call('GET', '/integrations')).body.canvas).toMatchObject({
            connected: true,
            account: 'Sam Student',
            baseUrl: BASE,
        });
    });

    it('follows pagination links', async () => {
        net.on('GET', `${BASE}/api/v1/courses`, (_req, url) =>
            url.searchParams.get('page') === '2'
                ? net.json([{ id: 2, name: 'History', course_code: 'HIS101' }])
                : net.json(
                      [{ id: 1, name: 'Biology', course_code: 'BIO101', term: { name: 'Fall' } }],
                      {
                          headers: { link: `<${BASE}/api/v1/courses?page=2>; rel="next"` },
                      },
                  ),
        );
        const res = await t.call('POST', '/tools/canvas_list_courses', {});
        expect(res.body.result).toEqual([
            { id: 1, name: 'Biology', code: 'BIO101', term: 'Fall' },
            { id: 2, name: 'History', code: 'HIS101', term: null },
        ]);
    });

    it('never follows a pagination link off the Canvas host', async () => {
        net.on('GET', 'https://evil.example/', () => net.json([{ id: 66, name: 'Stolen' }]));
        net.on('GET', `${BASE}/api/v1/courses`, () =>
            net.json([{ id: 1, name: 'Biology' }], {
                headers: { link: '<https://evil.example/api/v1/courses?page=2>; rel="next"' },
            }),
        );
        const res = await t.call('POST', '/tools/canvas_list_courses', {});
        expect(res.body.result).toEqual([{ id: 1, name: 'Biology', code: null, term: null }]);
        expect(net.calls.some((call) => call.url.startsWith('https://evil.example'))).toBe(false);
    });

    it('maps Canvas failures to upstream and integration errors', async () => {
        net.on(
            'GET',
            `${BASE}/api/v1/users/self/todo`,
            () => new Response('boom', { status: 500 }),
        );
        const failed = await t.call('POST', '/tools/canvas_todo', {});
        expect(failed.status).toBe(502);
        expect(failed.body.error).toMatchObject({
            code: 'upstream_error',
            details: { body: 'boom' },
        });

        net.on(
            'GET',
            `${BASE}/api/v1/users/self/upcoming_events`,
            () => new Response('<html>Sign in</html>', { status: 200 }),
        );
        const html = await t.call('POST', '/tools/canvas_upcoming', {});
        expect(html.status).toBe(502);
        expect(html.body.error.code).toBe('upstream_error');

        net.on('GET', `${BASE}/api/v1/announcements`, () => {
            throw new TypeError('fetch failed');
        });
        const down = await t.call('POST', '/tools/canvas_announcements', { courseIds: [1] });
        expect(down.status).toBe(502);
        expect(down.body.error.message).toBe('Canvas did not respond');

        net.on(
            'GET',
            `${BASE}/api/v1/courses/5/assignments`,
            () => new Response('expired', { status: 401 }),
        );
        const expired = await t.call('POST', '/tools/canvas_list_assignments', { courseId: 5 });
        expect(expired.status).toBe(424);
    });

    it('strips HTML from assignment instructions', async () => {
        net.on('GET', `${BASE}/api/v1/courses/1/assignments/9`, () =>
            net.json({
                id: 9,
                name: 'Lab report',
                due_at: '2026-11-05T23:59:00Z',
                description:
                    '<p>Write it up.</p><ul><li>Intro</li><li>Results &amp; discussion</li></ul>',
            }),
        );
        const res = await t.call('POST', '/tools/canvas_get_assignment', {
            courseId: 1,
            assignmentId: 9,
        });
        expect(res.body.result.description).toBe('Write it up.\n- Intro\n- Results & discussion');
    });

    it('disconnects', async () => {
        expect((await t.call('DELETE', '/integrations/canvas')).body).toEqual({
            disconnected: true,
        });
        expect((await t.call('GET', '/integrations')).body.canvas.connected).toBe(false);
        expect(await toolNames()).not.toContain('canvas_list_courses');
        expect((await t.call('POST', '/tools/canvas_list_courses', {})).status).toBe(424);
        expect((await t.call('DELETE', '/integrations/canvas')).body).toEqual({
            disconnected: false,
        });
    });
});

describe('email', () => {
    it('sends through Resend from the configured address', async () => {
        net.on('POST', 'https://api.resend.com/emails', async (req) => {
            expect(req.headers.get('authorization')).toBe('Bearer re_test');
            const body = await req.json();
            expect(body).toMatchObject({
                from: 'Lyfestyle <agent@example.com>',
                to: ['a@example.com'],
                reply_to: 'me@example.com',
            });
            return net.json({ id: 'email-1' });
        });
        const res = await t.call('POST', '/tools/email_send', {
            to: ['a@example.com'],
            subject: 'Hello',
            text: 'Hi!',
            replyTo: 'me@example.com',
        });
        expect(res.body.result).toMatchObject({ id: 'email-1' });
    });

    it('reports an accepted email as sent even when the reply is not JSON', async () => {
        net.on('POST', 'https://api.resend.com/emails', () => new Response('OK', { status: 200 }));
        const res = await t.call('POST', '/tools/email_send', {
            to: ['a@example.com'],
            subject: 'Hello',
            text: 'Hi!',
        });
        expect(res.status).toBe(200);
        expect(res.body.result).toEqual({
            id: null,
            from: 'Lyfestyle <agent@example.com>',
            to: ['a@example.com'],
        });
    });

    it('needs a body', async () => {
        const res = await t.call('POST', '/tools/email_send', {
            to: ['a@example.com'],
            subject: 'Empty',
        });
        expect(res.status).toBe(400);
    });
});
