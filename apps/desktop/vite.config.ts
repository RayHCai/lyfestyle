import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed port and no screen clearing so Rust errors stay visible.
export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    server: { port: 1420, strictPort: true },
    envPrefix: ['VITE_', 'TAURI_'],
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
