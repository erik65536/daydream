/**
 * The build pipeline's editor: `npm run designer`, then open the address it prints. A local tool apart from the
 * game server (it needs no accounts, database, or worker), serving its page through Vite and its API (api.ts) on
 * one port, to this machine only: the checkout's (5190, a worktree's own from `npm run setup`, or
 * DAYDREAM_DESIGNER_PORT); the model config is the server's.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { api } from './api.ts';
import { ports } from '../../../server/src/checkout.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = ports().designer;

const server = http.createServer();
const vite = await createServer({
  root,
  configFile: false,
  plugins: [react()],
  appType: 'spa',
  // Only the editor's own files are served: never the keys, the worlds, or the database.
  server: { middlewareMode: true, hmr: { server }, fs: { allow: [root], deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/config/**', '**/data/**'] } },
});
server.on('request', (req, res) => {
  void api(req, res).then((handled) => handled || vite.middlewares(req, res));
});
server.listen(port, '127.0.0.1', () => console.log(`The pipeline editor is at http://localhost:${port}`));
