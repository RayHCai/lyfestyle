import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { z } from 'zod';
import { invalid } from './errors.js';

/** `zValidator` that fails with the API's own error shape. */
export const validate = <Target extends keyof ValidationTargets, T extends z.ZodType>(
    target: Target,
    schema: T,
) =>
    zValidator(target, schema, (result) => {
        if (!result.success) throw invalid(result.error);
    });

export function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
