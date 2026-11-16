/**
 * The GPU broker: the only way to the GPU for every installation of the game (production on the game box,
 * development here). Started by hand next to ComfyUI:
 *
 *   npm run broker
 *
 * Reads config/broker.json (DAYDREAM_BROKER_CONFIG to use another file). See docs/gpu-broker.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Broker } from './scheduler.ts';
import { ComfyAdapter } from './adapters/comfyui.ts';
import { SpeechAdapter, type SpeechOptions } from './adapters/speech.ts';
import { createFront } from './http.ts';

interface BrokerConfig {
  listen?: { host?: string; port?: number };
  /** Client name → bearer token, written out or as "env:NAME" (an environment variable, which .env may set). */
  clients?: Record<string, string>;
  /** speech: the runner's environment (docs/voices.md); without it the broker does no speech. */
  adapters: { comfyui: { url: string; freeBetweenModels?: boolean }; speech?: SpeechOptions };
  holdMs?: number;
  graceMs?: number;
  settleMs?: number;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const file = process.env.DAYDREAM_BROKER_CONFIG ? path.resolve(process.env.DAYDREAM_BROKER_CONFIG) : path.join(root, 'config', 'broker.json');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* no .env */
}
if (!fs.existsSync(file)) {
  console.error(`No broker config at ${file}: copy config/broker.example.json to config/broker.json`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as BrokerConfig;

const secret = (v: string) => (v.startsWith('env:') ? process.env[v.slice(4)] : v);
const clients: Record<string, string> = {};
for (const [name, v] of Object.entries(cfg.clients ?? {})) {
  const token = secret(v);
  if (token) clients[name] = token;
  else console.warn(`[broker] client "${name}" has no token (${v} is empty): it cannot connect`);
}

const comfy = new ComfyAdapter(cfg.adapters.comfyui);
let speech: SpeechAdapter | undefined;
const broker: Broker = new Broker(
  { comfyui: comfy, ...(cfg.adapters.speech ? { speech: (speech = new SpeechAdapter(cfg.adapters.speech, () => broker.idle(), () => broker.claim('speech', 'runner'))) } : {}) },
  { holdMs: cfg.holdMs, graceMs: cfg.graceMs, settleMs: cfg.settleMs, onChange: () => void speech?.update() },
);
const host = cfg.listen?.host ?? '0.0.0.0';
const port = cfg.listen?.port ?? 8190;
createFront(broker, comfy, { clients, speech }).listen(port, host, async () => {
  console.log(`[broker] on http://${host}:${port} → ComfyUI ${comfy.url} (${(await comfy.alive()) ? 'answering' : 'not answering yet'})${speech ? ', speech' : ''}; clients: local${Object.keys(clients).map((c) => `, ${c}`).join('')}`);
});

const stop = () => {
  broker.stop();
  speech?.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
