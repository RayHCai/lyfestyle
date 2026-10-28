import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { invalid, tooLarge } from './errors.js';

/** `zValidator` that fails with the API's own error shape. */
export const validate = <Target extends keyof ValidationTargets, T extends z.ZodType>(
    target: Target,
    schema: T,
) =>
    zValidator(target, schema, (result) => {
        if (!result.success) throw invalid(result.error);
    });

/** The `:id` path parameter every resource route takes. */
export const byId = validate('param', z.object({ id: z.uuid() }));

/** Refuses a request body over `maxSize` bytes before it is read into memory and parsed. */
export const limitBody = (maxSize: number) =>
    bodyLimit({
        maxSize,
        onError: () => {
            throw tooLarge(`Body is over ${maxSize} bytes`);
        },
    });
