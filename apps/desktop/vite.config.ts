import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed port and no screen clearing so Rust errors stay visible.
export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    server: { port: 1420, strictPort: true },
    // `TAURI_ENV_*` is what the Tauri CLI sets for the frontend. A bare `TAURI_` prefix would also
    // bundle TAURI_SIGNING_PRIVATE_KEY into the app when it is set for a release build.
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
