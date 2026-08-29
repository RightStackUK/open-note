import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri expects a fixed port and hands the dev server its target triple via env.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri v2 targets Chromium 120 on Windows/Linux and WebKit on macOS.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    minify: !process.env.TAURI_ENV_DEBUG,
  },
});
