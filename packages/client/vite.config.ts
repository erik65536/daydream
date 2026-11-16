import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ports } from '../server/src/checkout.ts';

// This checkout's ports (checkout.ts): a worktree's own from `npm run setup`, so checkouts run side by side.
const p = ports();
const api = `localhost:${p.server}`;
// The game's version is the root package.json's: the account menu shows it and error reports carry it (src/api.ts).
const version = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
export default defineConfig({
  plugins: [react()],
  define: { __DAYDREAM_VERSION__: JSON.stringify(version) },
  server: {
    port: p.client,
    strictPort: true,
    // `npm run dev:lan`: phones and tablets on the same network can play (the address is printed at start).
    host: process.env.DAYDREAM_LAN ? true : undefined,
    // Vite serves files from anywhere in the repository; never the keys, the worlds, or the database.
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/config/**', '**/data/**', '**/data-test/**'] },
    proxy: {
      '/api': `http://${api}`,
      '/ws': { target: `ws://${api}`, ws: true },
    },
  },
  // Hidden source maps: not linked from the code; the server reads them to turn an error report's stack back into source lines.
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000, sourcemap: 'hidden' },
});
