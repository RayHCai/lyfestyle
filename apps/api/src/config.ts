import { z } from 'zod';

const optional = z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined));

const schema = z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z
        .string()
        .trim()
        .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string'),
    API_TOKEN: z.string().min(24, 'API_TOKEN must be at least 24 characters'),
    ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'ENCRYPTION_KEY must be 32 bytes, base64 encoded',
    }),
    PUBLIC_URL: optional,
    RAILWAY_PUBLIC_DOMAIN: optional,
    CORS_ORIGINS: z.string().default('*'),
    METRICS_ORIGINS: z.string().default('*'),
    METRICS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(365),
    RESEND_API_KEY: optional,
    RESEND_FROM: optional,
    SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(15_000),
    RUN_STALE_AFTER_MS: z.coerce.number().int().positive().default(120_000),
    RUN_BUDGET_USD: z.coerce.number().positive().default(5),
    AUTOMATION_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(15 * 60_000),
    NOTIFY_EMAIL: optional.pipe(z.email().optional()),
});

export interface Config {
    port: number;
    databaseUrl: string;
    apiToken: string;
    encryptionKey: Buffer;
    publicUrl: string;
    corsOrigins: string[] | '*';
    /** Websites whose page views the public collect endpoint records. */
    metricsOrigins: string[] | '*';
    /** Page views older than this many days are deleted; 0 keeps them forever. */
    metricsRetentionDays: number;
    resend: { apiKey: string; from: string } | undefined;
    schedulerTickMs: number;
    runStaleAfterMs: number;
    /** Most an agent run may spend, and what all the agent runs of one automation run share. */
    runBudgetUsd: number;
    /** An automation run still going after this long is stopped. */
    automationTimeoutMs: number;
    /** Where `ctx.email` sends when the code names no recipient. */
    notifyEmail: string | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
        throw new Error(`Invalid environment:\n${problems.join('\n')}`);
    }
    const e = parsed.data;
    const publicUrl =
        e.PUBLIC_URL ??
        (e.RAILWAY_PUBLIC_DOMAIN
            ? `https://${e.RAILWAY_PUBLIC_DOMAIN}`
            : `http://localhost:${e.PORT}`);
    const origins = originList(e.CORS_ORIGINS);
    const metricsOrigins = originList(e.METRICS_ORIGINS);
    return {
        port: e.PORT,
        databaseUrl: e.DATABASE_URL,
        apiToken: e.API_TOKEN,
        encryptionKey: Buffer.from(e.ENCRYPTION_KEY, 'base64'),
        publicUrl: publicUrl.replace(/\/+$/, ''),
        corsOrigins: origins.includes('*') ? '*' : origins,
        metricsOrigins: metricsOrigins.includes('*') ? '*' : metricsOrigins,
        metricsRetentionDays: e.METRICS_RETENTION_DAYS,
        resend:
            e.RESEND_API_KEY && e.RESEND_FROM
                ? { apiKey: e.RESEND_API_KEY, from: e.RESEND_FROM }
                : undefined,
        schedulerTickMs: e.SCHEDULER_TICK_MS,
        runStaleAfterMs: e.RUN_STALE_AFTER_MS,
        runBudgetUsd: e.RUN_BUDGET_USD,
        automationTimeoutMs: e.AUTOMATION_TIMEOUT_MS,
        notifyEmail: e.NOTIFY_EMAIL,
    };
}

function originList(value: string): string[] {
    return value
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean);
}
