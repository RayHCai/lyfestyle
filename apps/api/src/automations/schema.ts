import { z } from 'zod';

/** Where a deploy stands; shared by the routes and the agent's automations tools. */
export const deployStatus = z.enum(['pending', 'approved', 'rejected']);
