import { ApiError, badRequest, unavailable, unreachable, upstream } from '../lib/errors.js';
import { htmlToText, truncate } from '../lib/html.js';
import type { IntegrationStore } from './store.js';

const MAX_PAGES = 5;
const TIMEOUT_MS = 15_000;

interface CanvasSecret {
    token: string;
}

type Params = Record<string, string | number | string[] | undefined>;

function query(params: Params): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) search.append(key, String(v));
    }
    return search.toString();
}

function nextLink(header: string | null): string | null {
    for (const part of header?.split(',') ?? []) {
        const match = part.match(/<([^>]+)>;\s*rel="next"/);
        if (match) return match[1]!;
    }
    return null;
}

function normalizeCanvasUrl(raw: string): string {
    const url = new URL(raw);
    if (url.protocol !== 'https:') throw badRequest('Canvas URL must use https');
    return url.origin;
}

/** Canvas payloads are wide and loosely documented; each method picks the fields it returns. */
// oxlint-disable-next-line typescript/no-explicit-any -- see above
type Json = any;

export type Canvas = ReturnType<typeof createCanvas>;

export function createCanvas(deps: { store: IntegrationStore; fetch: typeof fetch }) {
    async function fetchText(url: string, token: string) {
        try {
            const res = await deps.fetch(url, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            return { res, text: await res.text() };
        } catch (err) {
            throw unreachable('Canvas', err);
        }
    }

    /** GETs `path`, following up to MAX_PAGES `next` links for a list. */
    async function call(
        baseUrl: string,
        token: string,
        path: string,
        params: Params = {},
    ): Promise<Json> {
        const qs = query({ per_page: 50, ...params });
        let url: string | null = `${baseUrl}/api/v1${path}${qs ? `?${qs}` : ''}`;
        const items: Json[] = [];
        for (let page = 0; url && page < MAX_PAGES; page++) {
            const { res, text } = await fetchText(url, token);
            if (res.status === 401) throw unavailable('Canvas rejected the access token');
            if (!res.ok) throw upstream('Canvas', res.status, text);
            let body: Json;
            try {
                body = JSON.parse(text);
            } catch {
                // e.g. a login page from an SSO proxy in front of Canvas.
                throw new ApiError(
                    502,
                    'upstream_error',
                    'Canvas answered with something other than JSON',
                    {
                        body: text.slice(0, 2000),
                    },
                );
            }
            if (!Array.isArray(body)) return body;
            items.push(...body);
            const next = nextLink(res.headers.get('link'));
            // The token travels with every page, so never follow a link off the Canvas host.
            url = next && URL.canParse(next) && new URL(next).origin === baseUrl ? next : null;
        }
        return items;
    }

    async function get(path: string, params?: Params): Promise<Json> {
        const stored = await deps.store.get<CanvasSecret>('canvas');
        if (!stored) throw unavailable('Canvas is not connected');
        return call(String(stored.config.baseUrl), stored.secret.token, path, params);
    }

    async function courses() {
        const list: Json[] = await get('/courses', {
            enrollment_state: 'active',
            'include[]': ['term'],
        });
        return list.map((c) => ({
            id: c.id as number,
            name: c.name as string,
            code: c.course_code ?? null,
            term: c.term?.name ?? null,
        }));
    }

    return {
        /** Checks the token against Canvas before storing it. */
        async connect(rawUrl: string, token: string) {
            const baseUrl = normalizeCanvasUrl(rawUrl);
            const user = (await call(baseUrl, token, '/users/self').catch((err: unknown) => {
                // Here a rejected token is the one just typed in, not a stored one gone stale.
                throw err instanceof ApiError && err.code === 'integration_unavailable'
                    ? badRequest('Canvas rejected that access token')
                    : err;
            })) as { id: number; name?: string; login_id?: string };
            const account = user.name ?? user.login_id ?? String(user.id);
            await deps.store.put<CanvasSecret>('canvas', {
                account,
                config: { baseUrl },
                secret: { token },
            });
            return { account, baseUrl };
        },

        disconnect: () => deps.store.remove('canvas'),

        courses,

        async assignments(courseId: number, bucket?: string) {
            const list: Json[] = await get(`/courses/${courseId}/assignments`, {
                order_by: 'due_at',
                bucket,
                'include[]': ['submission'],
            });
            return list.map((a) => ({
                id: a.id,
                name: a.name,
                dueAt: a.due_at ?? null,
                points: a.points_possible ?? null,
                url: a.html_url ?? null,
                submitted: a.submission ? a.submission.workflow_state !== 'unsubmitted' : null,
                score: a.submission?.score ?? null,
            }));
        },

        async assignment(courseId: number, assignmentId: number) {
            const a: Json = await get(`/courses/${courseId}/assignments/${assignmentId}`, {
                'include[]': ['submission'],
            });
            return {
                id: a.id,
                name: a.name,
                dueAt: a.due_at ?? null,
                lockAt: a.lock_at ?? null,
                points: a.points_possible ?? null,
                submissionTypes: a.submission_types ?? [],
                url: a.html_url ?? null,
                description: truncate(htmlToText(a.description ?? ''), 20_000),
                submission: a.submission
                    ? {
                          state: a.submission.workflow_state,
                          score: a.submission.score ?? null,
                          submittedAt: a.submission.submitted_at ?? null,
                      }
                    : null,
            };
        },

        async upcoming() {
            const events: Json[] = await get('/users/self/upcoming_events');
            return events.map((e) => ({
                title: e.title,
                type: e.type ?? null,
                startAt: e.start_at ?? e.assignment?.due_at ?? null,
                course: e.context_name ?? null,
                url: e.html_url ?? null,
            }));
        },

        async todo() {
            const items: Json[] = await get('/users/self/todo');
            return items.map((t) => ({
                type: t.type,
                course: t.context_name ?? null,
                name: t.assignment?.name ?? t.quiz?.title ?? null,
                dueAt: t.assignment?.due_at ?? null,
                url: t.html_url ?? t.assignment?.html_url ?? null,
            }));
        },

        async announcements(options: {
            courseIds?: number[] | undefined;
            startDate?: string | undefined;
            endDate?: string | undefined;
        }) {
            const courseIds = options.courseIds?.length
                ? options.courseIds
                : (await courses()).map((c) => c.id);
            if (!courseIds.length) return [];
            const items: Json[] = await get('/announcements', {
                'context_codes[]': courseIds.map((id) => `course_${id}`),
                start_date: options.startDate,
                end_date: options.endDate,
            });
            return items.map((a) => ({
                id: a.id,
                title: a.title,
                postedAt: a.posted_at ?? null,
                course: a.context_code ?? null,
                url: a.html_url ?? null,
                message: truncate(htmlToText(a.message ?? ''), 4_000),
            }));
        },
    };
}
