import { z } from 'zod';

const optional = z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined));

const schema = z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: optional,
    DATA_DIR: z.string().default('.data'),
    API_TOKEN: z.string().min(24, 'API_TOKEN must be at least 24 characters'),
    ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'ENCRYPTION_KEY must be 32 bytes, base64 encoded',
    }),
    PUBLIC_URL: optional,
    RAILWAY_PUBLIC_DOMAIN: optional,
    CORS_ORIGINS: z.string().default('*'),
    METRICS_ORIGINS: z.string().default('*'),
    RESEND_API_KEY: optional,
    RESEND_FROM: optional,
    SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(15_000),
    RUN_STALE_AFTER_MS: z.coerce.number().int().positive().default(120_000),
});

export interface Config {
    port: number;
    databaseUrl: string | undefined;
    dataDir: string;
    apiToken: string;
    encryptionKey: Buffer;
    publicUrl: string;
    corsOrigins: string[] | '*';
    /** Websites whose page views the public collect endpoint records. */
    metricsOrigins: string[] | '*';
    resend: { apiKey: string; from: string } | undefined;
    schedulerTickMs: number;
    runStaleAfterMs: number;
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
        dataDir: e.DATA_DIR,
        apiToken: e.API_TOKEN,
        encryptionKey: Buffer.from(e.ENCRYPTION_KEY, 'base64'),
        publicUrl: publicUrl.replace(/\/+$/, ''),
        corsOrigins: origins.includes('*') ? '*' : origins,
        metricsOrigins: metricsOrigins.includes('*') ? '*' : metricsOrigins,
        resend:
            e.RESEND_API_KEY && e.RESEND_FROM
                ? { apiKey: e.RESEND_API_KEY, from: e.RESEND_FROM }
                : undefined,
        schedulerTickMs: e.SCHEDULER_TICK_MS,
        runStaleAfterMs: e.RUN_STALE_AFTER_MS,
    };
}

function originList(value: string): string[] {
    return value
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean);
}
