import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { isTimeZone } from '../agent/jobs.js';
import { ApiError, badRequest, invalid } from '../lib/errors.js';
import { pageQuery } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';

/** Reached by any website without a bearer token. */
export const PUBLIC_METRICS_PATHS = ['/metrics/collect', '/metrics/script.js'];

const MAX_BODY_BYTES = 16 * 1024;

const propValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

const viewBody = z.object({
    url: z.url({ protocol: /^https?$/ }).max(2048),
    title: z.string().max(500).nullish(),
    referrer: z.string().max(2048).nullish(),
    language: z.string().max(35).nullish(),
    props: z
        .record(z.string().max(64), propValue)
        .refine((p) => Object.keys(p).length <= 20, 'At most 20 props')
        .optional(),
});

const filter = {
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    origin: z.string().optional(),
};

const timezone = z.string().refine(isTimeZone, 'Unknown IANA time zone').default('UTC');

/** Railway's proxy puts the visitor first in X-Forwarded-For; locally it is the socket peer. */
function clientIp(c: Context): string | null {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
    try {
        return getConnInfo(c).remote.address ?? null;
    } catch {
        return null;
    }
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw badRequest('Body must be JSON');
    }
}

/** Reports the first view and every client-side navigation after it. */
const trackerScript = (endpoint: string) => `(() => {
    const endpoint = ${JSON.stringify(endpoint)};
    let last;
    const send = () => {
        if (location.href === last) return;
        last = location.href;
        const body = JSON.stringify({
            url: location.href,
            title: document.title || null,
            referrer: document.referrer || null,
            language: navigator.language || null,
        });
        if (!navigator.sendBeacon?.(endpoint, body)) {
            fetch(endpoint, { method: 'POST', body, keepalive: true }).catch(() => {});
        }
    };
    for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function (...args) {
            const result = original.apply(this, args);
            send();
            return result;
        };
    }
    addEventListener('popstate', send);
    send();
})();
`;

export const metricsRoutes = ({ metrics, config }: Services) => {
    const script = trackerScript(`${config.publicUrl}/metrics/collect`);
    const accepts = (origin: string) =>
        config.metricsOrigins === '*' || config.metricsOrigins.includes(origin);

    return (
        new Hono()
            .basePath('/metrics')
            // Beacons arrive as text/plain to skip the CORS preflight, so the body is parsed here.
            .post(
                '/collect',
                bodyLimit({
                    maxSize: MAX_BODY_BYTES,
                    onError: () => {
                        throw new ApiError(413, 'payload_too_large', 'Body too large');
                    },
                }),
                async (c) => {
                    const parsed = viewBody.safeParse(parseJson(await c.req.text()));
                    if (!parsed.success) throw invalid(parsed.error);
                    const body = parsed.data;
                    const page = new URL(body.url);
                    const sender = c.req.header('origin');
                    if (sender && sender !== page.origin) {
                        throw badRequest('Origin header does not match url');
                    }
                    if (!accepts(page.origin)) {
                        throw new ApiError(403, 'forbidden', 'Origin not accepted');
                    }
                    await metrics.record({
                        origin: page.origin,
                        path: page.pathname,
                        url: body.url,
                        title: body.title,
                        referrer: body.referrer || null,
                        ip: clientIp(c),
                        userAgent: c.req.header('user-agent')?.slice(0, 500) ?? null,
                        language: body.language,
                        props: body.props,
                    });
                    return c.body(null, 204);
                },
            )
            .get('/script.js', (c) =>
                c.body(script, 200, {
                    'content-type': 'text/javascript; charset=utf-8',
                    'cache-control': 'public, max-age=3600',
                }),
            )
            .get('/views', validate('query', z.object({ ...filter, ...pageQuery })), async (c) =>
                c.json(await metrics.list(c.req.valid('query'))),
            )
            .get(
                '/views/summary',
                validate(
                    'query',
                    z.object({
                        ...filter,
                        groupBy: z.enum(['day', 'origin', 'path', 'referrer']).default('day'),
                        timezone,
                    }),
                ),
                async (c) => c.json(await metrics.summary(c.req.valid('query'))),
            )
    );
};
