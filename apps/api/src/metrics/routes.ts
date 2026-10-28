import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../lib/pagination.js';
import { timeZone } from '../lib/timezone.js';
import { limitBody, validate } from '../lib/validate.js';
import type { Services } from '../services.js';

/** Reached by any website without a bearer token. */
export const PUBLIC_METRICS_PATHS = ['/metrics/collect', '/metrics/script.js'];

const MAX_BODY_BYTES = 16 * 1024;

const filter = {
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    origin: z.string().optional(),
};

const timezone = timeZone.default('UTC');

/** The socket peer; absent when the app is called in-process, as in tests. */
function remoteAddress(c: Context): string | null {
    try {
        return getConnInfo(c).remote.address ?? null;
    } catch {
        return null;
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

    return (
        new Hono()
            .basePath('/metrics')
            // Beacons arrive as text/plain to skip the CORS preflight, so the body is parsed there.
            .post('/collect', limitBody(MAX_BODY_BYTES), async (c) => {
                await metrics.collect({
                    body: await c.req.text(),
                    origin: c.req.header('origin'),
                    forwardedFor: c.req.header('x-forwarded-for'),
                    remoteAddress: remoteAddress(c),
                    userAgent: c.req.header('user-agent'),
                });
                return c.body(null, 204);
            })
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
