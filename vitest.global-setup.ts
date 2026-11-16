import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dataRun: string;
  }
}

const dataTest = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data-test');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Each run has its own folder, data-test/run-<pid>/, and each test file its own folder inside it (vitest.setup.ts):
 * no test meets what another file or an earlier run left (worlds, saves, jobs, a database from before a schema change),
 * and two runs at once in one checkout keep apart. A run's folder is removed by the first run after it has ended, not
 * at its own end, so a failed run's data stays to look at.
 */
export default function setup(project: TestProject) {
  for (const name of fs.existsSync(dataTest) ? fs.readdirSync(dataTest) : []) {
    const pid = /^run-(\d+)$/.exec(name)?.[1];
    if (!pid || Number(pid) === process.pid || !alive(Number(pid))) fs.rmSync(path.join(dataTest, name), { recursive: true, force: true });
  }
  project.provide('dataRun', path.join(dataTest, `run-${process.pid}`));
}
