import { z } from 'zod';

const addresses = z.array(z.email()).max(50);

/** Shared by the agent's `email_send` tool and automations' `ctx.email`. */
export const emailFields = {
    to: addresses.min(1),
    subject: z.string().min(1).max(998),
    text: z.string().max(200_000).optional(),
    html: z.string().max(500_000).optional(),
    cc: addresses.optional(),
    bcc: addresses.optional(),
    replyTo: z.email().optional(),
};
