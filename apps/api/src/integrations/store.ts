import type { Db, Prisma, Provider } from '../db/client.js';
import type { SecretBox } from '../lib/crypto.js';

interface StoredIntegration<S> {
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
            const row = await db.integration.findUnique({ where: { provider } });
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
            const row = {
                account: value.account,
                config: value.config as Prisma.InputJsonObject,
                secret: secrets.seal(value.secret),
                updatedAt: now(),
            };
            await db.integration.upsert({
                where: { provider },
                create: { provider, ...row, createdAt: now() },
                update: row,
            });
        },

        async remove(provider: Provider): Promise<boolean> {
            const { count } = await db.integration.deleteMany({ where: { provider } });
            return count > 0;
        },

        /** Which providers are connected, without decrypting anything. */
        async connected(): Promise<Set<Provider>> {
            const rows = await db.integration.findMany({ select: { provider: true } });
            return new Set(rows.map((r) => r.provider));
        },

        describe(provider: Provider) {
            return db.integration.findUnique({
                where: { provider },
                select: { account: true, config: true, updatedAt: true },
            });
        },
    };
}
