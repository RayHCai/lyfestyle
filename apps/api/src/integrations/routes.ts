import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';

export const integrationsRoutes = ({ integrations, canvas, resend }: Services) =>
    new Hono()
        .basePath('/integrations')
        .get('/', async (c) => {
            const cv = await integrations.describe('canvas');
            return c.json({
                canvas: {
                    connected: cv !== null,
                    account: cv?.account ?? null,
                    baseUrl: (cv?.config.baseUrl as string | undefined) ?? null,
                    updatedAt: cv?.updatedAt ?? null,
                },
                resend: { configured: resend.configured, from: resend.from },
            });
        })
        .put(
            '/canvas',
            validate('json', z.object({ baseUrl: z.url(), token: z.string().trim().min(10) })),
            async (c) => {
                const { baseUrl, token } = c.req.valid('json');
                return c.json(await canvas.connect(baseUrl, token));
            },
        )
        .delete('/canvas', async (c) => c.json({ disconnected: await canvas.disconnect() }));
