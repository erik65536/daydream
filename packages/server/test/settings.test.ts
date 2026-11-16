import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '@daydream/shared';

describe('player settings', () => {
  it('keep the worlds a player turned animations off in, once each, and drop what is not a world id', () => {
    expect(normalizeSettings({}).animationsOff).toEqual([]);
    const s = normalizeSettings({ ...DEFAULT_SETTINGS, animationsOff: ['w_a', 'w_b', 'w_a', 7, null, 'x'.repeat(41)] });
    expect(s.animationsOff).toEqual(['w_a', 'w_b']);
    expect(normalizeSettings({ animationsOff: 'w_a' }).animationsOff).toEqual([]);
  });
});
