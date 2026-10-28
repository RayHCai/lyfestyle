import { defineConfig } from 'vitest/config';

// Tests cover pure modules and the stores over a stubbed localStorage, so Node is enough: no
// DOM, no React plugin.
export default defineConfig({
    test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
