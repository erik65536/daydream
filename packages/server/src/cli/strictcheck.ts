/**
 * Check the art prompts' schema (worldgen/art.ts, `PromptBatch`) against OpenAI's strict mode: it is sent to OpenAI
 * with a tiny output cap, and a schema strict mode rejects fails at once.
 *
 *   node src/cli/strictcheck.ts
 *
 * It makes one real call per schema with OPENAI_API_KEY from .env, outside the game's spending ledger: a fraction of
 * a cent (a short prompt, at most 16 output tokens). Run it after changing that schema.
 *
 * Not checked here: the build's text steps, whose schemas the pipeline writes in strict form itself
 * (pipeline/shape.ts), and the other schemas written in code (map plans, mist, door marks, animation briefs), which
 * fail in the build step that sends them.
 */
import { z } from 'zod';
import { strictSchema } from '../genai/json.ts';
import { PromptBatch } from '../worldgen/art.ts';
import '../paths.ts';

if (!process.env.OPENAI_API_KEY) throw new Error('strictcheck calls OpenAI: put OPENAI_API_KEY in .env at the repository root.');
const schemas: Record<string, z.ZodType> = { prompts: PromptBatch };
let bad = 0;
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-6-luna', input: 'Return a minimal example.', max_output_tokens: 16, reasoning: { effort: 'none' }, text: { format: { type: 'json_schema', name, schema: strictSchema(json as never), strict: true } } }),
  });
  const data = (await res.json()) as { error?: { message: string }; status?: string };
  if (res.status !== 200) bad++;
  console.log(`${res.status === 200 ? 'ok ' : 'BAD'} ${name.padEnd(10)} ${res.status} ${data.error?.message?.slice(0, 220) ?? data.status}`);
}
console.log(bad ? `${bad} schema(s) rejected` : 'all schemas accepted');
