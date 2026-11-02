import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import type { Services } from '../services.js';

/** Reached without a bearer token: it is how the dashboard gets one. */
export const PUBLIC_AUTH_PATHS = ['/auth/login'];

export const authRoutes = ({ auth }: Services) =>
    new Hono()
        .basePath('/auth')
        .post('/login', validate('json', z.object({ password: z.string().max(1024) })), (c) =>
            c.json(auth.login(c.req.valid('json').password), 200),
        );
