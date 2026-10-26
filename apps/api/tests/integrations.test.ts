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

    it('needs a body', async () => {
        const res = await t.call('POST', '/tools/email_send', {
            to: ['a@example.com'],
            subject: 'Empty',
        });
        expect(res.status).toBe(400);
    });
});
