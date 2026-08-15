import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API is proxied so the browser only ever talks to one origin — no CORS
// story to get wrong, and the same URLs work in Docker and local dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
