import { describe, expect, it } from 'vitest';
import { checkDisplayName, checkPassword, checkUsername } from '../src/accounts.ts';

describe('account rules', () => {
  it('user names: ends trimmed, spaces inside refused with a suggestion, other characters named', () => {
    expect(checkUsername('  ada_l.9-x ')).toEqual({ value: 'ada_l.9-x' });
    expect(checkUsername('ada lovelace').problem).toMatch(/cannot have spaces.*dot, dash, or underscore/);
    expect(checkUsername('ada!').problem).toMatch(/cannot have "!"/);
    expect(checkUsername('adé').problem).toMatch(/cannot have "é"/);
  });

  it('user names: too short may only be unfinished; too long is not', () => {
    expect(checkUsername('')).toMatchObject({ problem: 'Choose a user name.', unfinished: true });
    expect(checkUsername('ad')).toMatchObject({ problem: expect.stringMatching(/at least 3/), unfinished: true });
    expect(checkUsername('a'.repeat(24)).problem).toBeUndefined();
    expect(checkUsername('a'.repeat(25))).toEqual({ value: 'a'.repeat(25), problem: expect.stringMatching(/at most 24/) });
  });

  it('the name others see keeps its spaces, one at a time', () => {
    expect(checkDisplayName('  Ada   Lovelace ')).toEqual({ value: 'Ada Lovelace' });
    expect(checkDisplayName('   ')).toMatchObject({ unfinished: true });
    expect(checkDisplayName('x'.repeat(33)).problem).toMatch(/at most 32/);
  });

  it('passwords are kept as typed, 12 to 200 characters', () => {
    expect(checkPassword(' twelve chars')).toEqual({ value: ' twelve chars' });
    expect(checkPassword('short')).toMatchObject({ problem: expect.stringMatching(/at least 12/), unfinished: true });
    expect(checkPassword('x'.repeat(201)).problem).toMatch(/at most 200/);
  });
});
