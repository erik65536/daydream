// Samples the GPU every 10 s into data/logs/gpu-smi.csv for scripts/buildcost.mjs: utilization, memory, power,
// temperature, core clock, and whether the card is slowing itself down (software and hardware thermal slowdown, the
// software power cap). Run it beside a build and stop it with Ctrl+C.
//
//   node scripts/gpusmi.mjs [--data <dir>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dataDir = path.resolve(args.includes('--data') ? args[args.indexOf('--data') + 1] : 'data');
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
const out = fs.createWriteStream(path.join(dataDir, 'logs', 'gpu-smi.csv'), { flags: 'a' });
const fields = ['timestamp', 'utilization.gpu', 'memory.used', 'power.draw', 'temperature.gpu', 'clocks.sm', 'clocks_event_reasons.sw_thermal_slowdown', 'clocks_event_reasons.hw_thermal_slowdown', 'clocks_event_reasons.sw_power_cap'];
const smi = spawn('nvidia-smi', [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader', '-l', '10'], { stdio: ['ignore', 'pipe', 'inherit'] });
smi.stdout.pipe(out);
console.log(`sampling the GPU into ${path.join(dataDir, 'logs', 'gpu-smi.csv')}`);
process.on('SIGINT', () => smi.kill());
