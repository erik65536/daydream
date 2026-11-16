/** Talking to the playtest driver from the CLI and the MCP server: finding it, starting it, sending a command. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRIVER_FILE, PLAYTEST_DIR } from './files.ts';

export const DRIVER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'driver.ts');

interface DriverInfo {
  port: number;
  token: string;
  pid: number;
}

interface CommandRequest {
  player: number;
  command: string;
  args: Record<string, string | undefined>;
  shot?: boolean;
  marks?: boolean;
}

interface CommandReply {
  ok: boolean;
  text: string;
  shot?: string;
}

const post = (d: DriverInfo, body: unknown, timeout?: number) =>
  fetch(`http://127.0.0.1:${d.port}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-playtest-token': d.token },
    body: JSON.stringify(body),
    signal: timeout ? AbortSignal.timeout(timeout) : undefined,
  });

/** The running driver, if it answers. */
export async function reach(): Promise<DriverInfo | null> {
  let d: DriverInfo;
  try {
    d = JSON.parse(fs.readFileSync(DRIVER_FILE, 'utf8')) as DriverInfo;
  } catch {
    return null;
  }
  try {
    return (await post(d, { player: 1, command: 'status', args: {} }, 2000)).ok ? d : null;
  } catch {
    return null;
  }
}

/** Start the driver in the background (its output in data/playtests/driver.log) and wait for it. */
export async function launch(): Promise<DriverInfo> {
  fs.mkdirSync(PLAYTEST_DIR, { recursive: true });
  fs.rmSync(DRIVER_FILE, { force: true });
  const log = fs.openSync(path.join(PLAYTEST_DIR, 'driver.log'), 'a');
  spawn(process.execPath, [DRIVER_SCRIPT], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const d = await reach();
    if (d) return d;
  }
  throw new Error(`The playtest driver did not start: see ${path.join(PLAYTEST_DIR, 'driver.log')}. If your sandbox stops background processes, run "npm run play -- serve" in a terminal of your own first.`);
}

/** Send a command, starting the driver first when it is not running (except to stop it). */
export async function command(req: CommandRequest): Promise<CommandReply> {
  const running = await reach();
  if (!running && req.command === 'stop') return { ok: true, text: 'No driver is running.' };
  const d = running ?? (await launch());
  return (await (await post(d, req)).json()) as CommandReply;
}
