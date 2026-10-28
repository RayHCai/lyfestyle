import { z } from 'zod';

/** Shared by the HTTP route, the agent's `notify` tool and automations' `ctx.notify`. */
export const notificationFields = {
    title: z.string().trim().min(1).max(200),
    body: z.string().max(2000).optional(),
};
