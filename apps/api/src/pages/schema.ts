import { z } from 'zod';

/** Page fields, shared by the HTTP routes and the agent's tools. */
export const pageFields = {
    title: z.string().max(500),
    content: z.string().max(1_000_000),
    icon: z.string().max(64).nullable(),
};

export const pageDraft = z.object({
    title: pageFields.title.optional(),
    content: pageFields.content.optional(),
    icon: pageFields.icon.optional(),
});
