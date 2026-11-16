import path from 'node:path';
import { IS_WORKTREE, MAIN_ROOT, ownOrMain, ROOT_DIR } from './checkout.ts';

export { ROOT_DIR };
// Secrets such as API keys live in a .env file at the repository root (never committed); a worktree without one
// reads the main checkout's (checkout.ts).
try {
  process.loadEnvFile(ownOrMain('.env'));
} catch {
  /* no .env */
}
// A test run without the repository's vitest config would build worlds into the real data dir with the real
// models, and the dev worker would pick its jobs up: refuse instead.
if (process.env.VITEST && (!process.env.DAYDREAM_DATA_DIR || !process.env.DAYDREAM_GENAI_CONFIG))
  throw new Error('Tests need DAYDREAM_DATA_DIR and DAYDREAM_GENAI_CONFIG (set by vitest.config.ts): run vitest from the repository or packages/server');
export const DATA_DIR = process.env.DAYDREAM_DATA_DIR ? path.resolve(process.env.DAYDREAM_DATA_DIR) : path.join(ROOT_DIR, 'data');
// The main checkout's data is real (its owner's worlds and adventures): a worktree works on its own.
const fromMainData = path.relative(path.join(MAIN_ROOT, 'data'), DATA_DIR);
if (IS_WORKTREE && !fromMainData.startsWith('..') && !path.isAbsolute(fromMainData))
  throw new Error(`A worktree never uses the main checkout's data (DAYDREAM_DATA_DIR is ${DATA_DIR}). Its own is ${path.join(ROOT_DIR, 'data')}.`);
/** config/genai.json, the models' settings: DAYDREAM_GENAI_CONFIG to use another; a worktree without one reads the main checkout's. */
export const genaiConfigFile = () => process.env.DAYDREAM_GENAI_CONFIG ?? ownOrMain('config/genai.json');
/** Where each world's files are: its definition, its assets, its build's saved steps. */
export const WORLDS_DIR = path.join(DATA_DIR, 'worlds');
export const worldDir = (id: string) => path.join(WORLDS_DIR, id);
export const worldAssetDir = (id: string) => path.join(worldDir(id), 'assets');
/** Models made at install from published weights (git-ignored), such as Pocket TTS's ONNX export; a worktree reads the main checkout's. */
export const MODELS_DIR = ownOrMain('models');
export const CLIENT_DIST = path.join(ROOT_DIR, 'packages', 'client', 'dist');
