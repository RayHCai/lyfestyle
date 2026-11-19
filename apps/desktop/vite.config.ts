import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The web build is also an installable app (PWA) for phones: the manifest, home-screen icons and a
 * viewport that reaches under the notch and shrinks for the keyboard. Only `--mode web` gets them,
 * so the desktop app's page stays as it was. `src/main.tsx` registers `public/sw.js`.
 */
const pwa = (): Plugin => ({
    name: 'lyfestyle-pwa',
    apply: (_, env) => env.mode === 'web',
    transformIndexHtml: (html) => ({
        html: html.replace(
            /<meta name="viewport"[^>]*>/,
            '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />',
        ),
        tags: [
            { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' } },
            { tag: 'meta', attrs: { name: 'theme-color', content: '#ffffff' } },
            {
                tag: 'link',
                attrs: { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
            },
            { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' } },
            { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
            { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'Lyfestyle' } },
            {
                tag: 'meta',
                attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
            },
        ],
    }),
});

// Tauri expects a fixed port and no screen clearing so Rust errors stay visible.
export default defineConfig({
    plugins: [react(), pwa()],
    clearScreen: false,
    server: { port: 1420, strictPort: true },
    // `TAURI_ENV_*` is what the Tauri CLI sets for the frontend. A bare `TAURI_` prefix would also
    // bundle TAURI_SIGNING_PRIVATE_KEY into the app when it is set for a release build.
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
