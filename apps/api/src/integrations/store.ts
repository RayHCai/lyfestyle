import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { integrations } from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';

export type Provider = (typeof integrations.$inferSelect)['provider'];

export interface StoredIntegration<S> {
    account: string | null;
    config: Record<string, unknown>;
    secret: S;
    updatedAt: Date;
}

/** Integration credentials, encrypted at rest. */
export type IntegrationStore = ReturnType<typeof createIntegrationStore>;

export function createIntegrationStore(db: Db, secrets: SecretBox, now: () => Date) {
    return {
        async get<S>(provider: Provider): Promise<StoredIntegration<S> | undefined> {
            const [row] = await db
                .select()
                .from(integrations)
                .where(eq(integrations.provider, provider));
            if (!row) return undefined;
            return {
                account: row.account,
                config: row.config,
                secret: secrets.open<S>(row.secret),
                updatedAt: row.updatedAt,
            };
        },

        async put<S>(
            provider: Provider,
            value: { account: string | null; config: Record<string, unknown>; secret: S },
        ) {
            const row = { ...value, secret: secrets.seal(value.secret), updatedAt: now() };
            await db
                .insert(integrations)
                .values({ provider, ...row, createdAt: now() })
                .onConflictDoUpdate({ target: integrations.provider, set: row });
        },

        async remove(provider: Provider): Promise<boolean> {
            const rows = await db
                .delete(integrations)
                .where(eq(integrations.provider, provider))
                .returning({ provider: integrations.provider });
            return rows.length > 0;
        },

        /** Which providers are connected, without decrypting anything. */
        async connected(): Promise<Set<Provider>> {
            const rows = await db.select({ provider: integrations.provider }).from(integrations);
            return new Set(rows.map((r) => r.provider));
        },

        async describe(provider: Provider) {
            const [row] = await db
                .select({
                    account: integrations.account,
                    config: integrations.config,
                    updatedAt: integrations.updatedAt,
                })
                .from(integrations)
                .where(eq(integrations.provider, provider));
            return row ?? null;
        },
    };
}
