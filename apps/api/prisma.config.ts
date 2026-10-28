import { defineConfig } from 'prisma/config';

// Only the CLI reads this. The API connects and migrates itself (src/db/client.ts), and
// `pnpm db:generate` points `SHADOW_DATABASE_URL` at a throwaway PGlite, never at a real database.
export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: {
        url: process.env.DATABASE_URL ?? '',
        ...(process.env.SHADOW_DATABASE_URL
            ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
            : {}),
    },
});
