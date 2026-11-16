/**
 * The playtest commands as an MCP server (stdio), for agents that prefer tools to a terminal: every command of
 * `npm run play` is a tool of the same name and parameters, answering with the same text and its screenshot as an
 * image. It talks to the same driver (starting it when needed). See docs/playtesting.md.
 *
 *   node packages/server/src/playtest/mcp.ts [--player <1-6>]     (or PLAYTEST_PLAYER; the player its tools act as)
 *
 * The protocol is newline-delimited JSON-RPC on stdin and stdout (MCP's stdio transport); only its messages go to
 * stdout.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { command } from './client.ts';
import { COMMANDS, DRIVER_COMMANDS, type Param } from './commands.ts';

const i = process.argv.indexOf('--player');
const PLAYER = Number(i >= 0 ? process.argv[i + 1] : (process.env.PLAYTEST_PLAYER ?? 1));

const INSTRUCTIONS = [
  'Playtest Daydream, a 2D top-down RPG, through these tools. Begin with "start" (your agent name), then "look".',
  'Things in sight have short names (n1 a person, m1 a creature, f1 a thing, l1 loot, h1 a hero) to use in "walk", "use", "talk" and "skill".',
  'Every tool answers with what you now see and a screenshot. Report problems with "bug" and impressions with "feedback" as you go; end with "finish".',
  'Never sleep to wait: "wait" returns the moment something needs you (your turn, a fight, a chat message, story text, an answer, a new place) and says what.',
  'In a fight the answer names your heroes acting now; "hero" picks which of them acts, and each ends their own turn with "endturn".',
  'Read docs/playtesting.md in the repository for the whole guide.',
].join(' ');

const schema = (params: Param[]) => ({
  type: 'object',
  properties: {
    ...Object.fromEntries(params.map((p) => [p.name, { type: p.type === 'number' ? 'number' : 'string', description: p.description }])),
    player: { type: 'number', description: `the player to act as (default ${PLAYER})` },
    screenshot: { type: 'boolean', description: 'take a screenshot (the default for most tools) or not' },
    marks: { type: 'boolean', description: 'label what is in sight on the screenshot' },
  },
  required: params.filter((p) => !p.optional).map((p) => p.name),
});

const TOOLS = [...DRIVER_COMMANDS, ...COMMANDS].map((c) => ({ name: c.name, description: c.summary, inputSchema: schema(c.params) }));

type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown> };

const write = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id: Message['id'], result: unknown) => write({ jsonrpc: '2.0', id, result });
const fail = (id: Message['id'], code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function call(name: string, input: Record<string, unknown>) {
  if (!TOOLS.some((t) => t.name === name)) throw new Error(`No tool "${name}".`);
  const { player, screenshot, marks, ...rest } = input;
  const args = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === undefined || v === null ? undefined : String(v)]));
  const out = await command({ player: Number(player ?? PLAYER), command: name, args, shot: screenshot as boolean | undefined, marks: marks as boolean | undefined });
  const content: unknown[] = [{ type: 'text', text: out.text }];
  if (out.shot && fs.existsSync(out.shot)) content.push({ type: 'image', data: fs.readFileSync(out.shot).toString('base64'), mimeType: 'image/jpeg' });
  return { content, isError: !out.ok };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m: Message;
  try {
    m = JSON.parse(line) as Message;
  } catch {
    return fail(null as never, -32700, 'Parse error');
  }
  if (m.id === undefined) return; // a notification (initialized, cancelled)
  switch (m.method) {
    case 'initialize':
      return reply(m.id, {
        protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'daydream-playtest', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply(m.id, {});
    case 'tools/list':
      return reply(m.id, { tools: TOOLS });
    case 'tools/call': {
      const id = m.id;
      const p = m.params as { name: string; arguments?: Record<string, unknown> };
      call(p.name, p.arguments ?? {}).then(
        (r) => reply(id, r),
        (e) => reply(id, { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }),
      );
      return;
    }
    default:
      return fail(m.id, -32601, `Method not found: ${m.method}`);
  }
});
rl.on('close', () => process.exit(0));
