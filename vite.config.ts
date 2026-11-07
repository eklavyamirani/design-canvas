import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH is the sub-path GitHub Pages serves the project from
// (/design-canvas). Locally it is unset and the app serves from /.
const base = `${(process.env.BASE_PATH || '').replace(/\/+$/, '')}/`;

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    // Excalidraw is one large library; the default 500 kB warning is noise.
    chunkSizeWarningLimit: 2500,
  },
  server: {
    // `npm run dev:collab`: the collab server (server/, `npm run dev`) on
    // :8787. The platform sign-in sets the identity headers in production;
    // here everyone is the same "dev" user.
    proxy: {
      '/collab': {
        target: 'http://localhost:8787',
        ws: true,
        headers: { 'x-auth-request-user': 'dev', 'x-auth-request-preferred-username': 'dev' },
      },
    },
  },
});
