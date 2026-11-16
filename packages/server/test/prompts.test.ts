import { describe, expect, it } from 'vitest';
import { Pipeline } from '../src/pipeline/index.ts';
import { render } from '../src/pipeline/template.ts';
import type { Example } from '../src/pipeline/types.ts';

const ex: Example = {
  id: 'prompts',
  input: {
    theme: 'A cozy woodland of talking animals.',
    prompts: [
      { topic: 'monsters', text: 'No undead.' },
      { topic: 'art', text: 'Watercolor.' },
      { topic: 'rules', text: 'Call the money acorns.' },
    ],
    size: 'small', length: 'short', communication: 2,
  },
};
const pipe = new Pipeline();
/** What a step would send for the example, from made-up answers to the steps it reads. */
const sent = (step: string) => pipe.preview(ex, step, 'sample').calls.map((c) => `${c.system}\n${c.user}`).join('\n');

describe("the owner's prompts", () => {
  it('reach only the steps they are aimed at', () => {
    expect(sent('creatures')).toContain('No undead.');
    expect(sent('creatures')).not.toMatch(/Watercolour|acorns/);
    expect(sent('art')).toContain('Watercolor.');
    expect(sent('rulesCore')).toContain('Call the money acorns.');
    expect(sent('concept')).toContain('A cozy woodland');
    expect(sent('concept')).not.toMatch(/No undead|Watercolour|acorns/);
  });

  it('ask for plain words unless the owner wants people to talk another way', () => {
    const system = (speech: string | null) => render(String(pipe.project.constants.system), { ownerStyle: { speech } }, new Set(), pipe.project.constants);
    expect(system(null)).toMatch(/plain, everyday words/);
    expect(system('Everyone speaks like a pirate.')).toContain('Everyone speaks like a pirate.');
    expect(system('Everyone speaks like a pirate.')).not.toMatch(/plain, everyday words/);
  });
});
