import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Every file boots its own PGlite in `beforeAll`; with files running in parallel that can
        // take well over the default 10 s.
        hookTimeout: 30_000,
    },
});
