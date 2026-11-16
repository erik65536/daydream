import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { linkWorkspaces } from './packages/server/src/checkout.ts';

// Tests never touch the real data or models: their own data folders under data-test/ (vitest.global-setup.ts), no genai
// config. Absolute paths, and packages/server/vitest.config.ts re-exports this, so a run from either folder gets the same
// settings.
const root = path.dirname(fileURLToPath(import.meta.url));
// Before anything resolves: the tests import this checkout's packages, not the main checkout's.
linkWorkspaces();
const dataTest = path.join(root, 'data-test');
export default defineConfig({
  root,
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    globalSetup: [path.join(root, 'vitest.global-setup.ts')],
    setupFiles: [path.join(root, 'vitest.setup.ts')],
    // Half the cores: as fast as all of them (the slowest files set the time), and kinder to a machine shared with other
    // runs and builds, where more workers only slow every file down.
    maxWorkers: '50%',
    // Hooks build worlds and start servers as tests do: the same limit.
    testTimeout: 60000,
    hookTimeout: 60000,
    env: { DAYDREAM_GENAI_CONFIG: path.join(dataTest, 'no-genai.json'), DAYDREAM_BALANCE: 'off', DAYDREAM_RETRY_WAIT_SCALE: '0' },
  },
});
