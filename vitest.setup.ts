import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, setGlobalDispatcher } from 'undici';
import { expect, inject } from 'vitest';

// Runs before each test file's own imports: the file gets a data folder of its own (its database, worlds and jobs)
// inside its run's (vitest.global-setup.ts), so files running side by side never see each other's work.
const packages = path.join(path.dirname(fileURLToPath(import.meta.url)), 'packages');
const file = path.relative(packages, expect.getState().testPath!).replace(/\.test\.ts$/, '');
process.env.DAYDREAM_DATA_DIR = path.join(inject('dataRun'), file.split(path.sep).join('-'));

// A fresh connection for every request the tests make. The tests and their servers share one thread: a test that keeps
// it busy past the server's keep-alive time (5 s, a busy machine is enough) would send its next request on a kept
// connection the server closes in that same moment (ECONNRESET).
setGlobalDispatcher(new Agent({ pipelining: 0 }));
