/**
 * Play the game from a terminal, for AI agents playtesting it (docs/playtesting.md). Each command acts in the game
 * through the playtest driver, which keeps a signed-in Chrome between commands, and prints what the player now sees
 * with the path of a screenshot.
 *
 *   npm run play -- help [command]           every command, or one in full
 *   npm run play -- start codex              sign in as player 1, make an adventure and a hero, open the game
 *   npm run play -- look                     what you see (and a screenshot)
 *   npm run play -- talk n1 Hello there      walk to the person n1 and say it
 *   npm run play -- bug major The door ...   report a bug
 *   npm run play -- finish It was ... --fun 4 --clarity 3 --looks 4
 *
 * Options for any command: --player <1-6> (or PLAYTEST_PLAYER; several agents play one adventure as different
 * players), --shot / --no-shot (a screenshot or none), --marks (label what is in sight on the screenshot).
 * `serve` runs the driver in this terminal (`--show` opens a visible browser window); otherwise the first command
 * starts it in the background. `stop` ends it.
 */
import { spawn } from 'node:child_process';
import { command, DRIVER_SCRIPT } from '../playtest/client.ts';
import { COMMANDS, DRIVER_COMMANDS, type Param } from '../playtest/commands.ts';

const ALL = [...DRIVER_COMMANDS, ...COMMANDS];

const argv = process.argv.slice(2);
const name = argv.shift() ?? 'help';

function usage(c: { name: string; params: Param[] }) {
  return [c.name, ...c.params.map((p) => (p.flag ? `[--${p.name} …]` : p.optional ? `[${p.name}${p.rest ? '…' : ''}]` : `<${p.name}${p.rest ? '…' : ''}>`))].join(' ');
}

if (name === 'help' || name === '--help') {
  const one = ALL.find((c) => c.name === argv[0]);
  if (one) {
    console.log(`${usage(one)}\n\n${one.summary}\n`);
    for (const p of one.params) console.log(`  ${p.flag ? '--' : ''}${p.name}: ${p.description}${p.optional ? ' (optional)' : ''}`);
  } else {
    console.log('npm run play -- <command> [words] [--player N] [--no-shot] [--marks]\n');
    for (const c of ALL) console.log(`  ${usage(c)}\n      ${c.summary}`);
  }
  process.exit(0);
}

if (name === 'serve') {
  const p = spawn(process.execPath, [DRIVER_SCRIPT, ...argv], { stdio: 'inherit' });
  p.on('exit', (code) => process.exit(code ?? 0));
} else await main();

async function main() {
  const def = ALL.find((c) => c.name === name);
  if (!def) {
    console.error(`No command "${name}": "npm run play -- help" lists them.`);
    process.exit(2);
  }

  // Options, then the command's parameters: named ones (--fun 4), then the words in order (the last takes the rest).
  let player = Number(process.env.PLAYTEST_PLAYER ?? 1);
  let shot: boolean | undefined;
  let marks = false;
  const args: Record<string, string | undefined> = {};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const flag = a.startsWith('--') ? a.slice(2) : null;
    if (flag === 'player') player = Number(argv[++i]);
    else if (flag === 'shot') shot = true;
    else if (flag === 'no-shot') shot = false;
    else if (flag === 'marks') marks = true;
    else if (flag && def.params.some((p) => p.name === flag)) args[flag] = argv[++i];
    else if (flag) {
      console.error(`${usage(def)}\nNo option --${flag} here.`);
      process.exit(2);
    } else words.push(a);
  }
  const positional = def.params.filter((p) => !p.flag && args[p.name] === undefined);
  positional.forEach((p, i) => {
    if (i >= words.length) return;
    args[p.name] = p.rest ? words.slice(i).join(' ') : words[i];
  });
  // Only a parameter that takes the rest takes several words; more words than that are a mistake (often a named
  // option given without its name), not part of the last one.
  if (!positional.at(-1)?.rest && words.length > positional.length) {
    const named = def.params.filter((p) => p.flag).map((p) => `--${p.name}`);
    console.error(`${usage(def)}\nToo many words: "${words.slice(positional.length).join(' ')}".${named.length ? ` Options are given by name (${named.join(', ')}).` : ''}`);
    process.exit(2);
  }
  const missing = def.params.find((p) => !p.optional && !args[p.name]);
  if (missing) {
    console.error(`${usage(def)}\nMissing ${missing.name}: ${missing.description}.`);
    process.exit(2);
  }

  try {
    const out = await command({ player, command: name, args, shot, marks });
    console.log(out.text);
    process.exitCode = out.ok ? 0 : 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
