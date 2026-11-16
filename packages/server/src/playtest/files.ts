/** Where playtests keep their files (a module of its own, so the CLI loads nothing else of the server). */
import path from 'node:path';
import { DATA_DIR } from '../paths.ts';

/** Every run's folder, data/playtests/index.md, and the driver's address. */
export const PLAYTEST_DIR = path.join(DATA_DIR, 'playtests');
/** The running driver's port, token, and process (written when it starts, removed when it stops). */
export const DRIVER_FILE = path.join(PLAYTEST_DIR, 'driver.json');
