/** A player's own preferences, kept with their account so they follow them to every device. */

/** A player's sound settings: each a volume from 0 (off: nothing of it is even sent or loaded) to 1 (docs/sound.md, docs/voices.md). */
interface SoundSettings {
  master: number;
  /** Taps, windows, refusals, and the other small feedback of the interface. */
  interface: number;
  /** The game's moments, combat, and spells. */
  effects: number;
  music: number;
  /** The steady sound of each place. */
  ambience: number;
  /** People and the narrator speaking their lines (the words are always shown). */
  voices: number;
}

interface ControlSettings {
  /**
   * How strongly the device vibrates for taps and the game's moments, 0 (never) to 1: a phone's pulses grow
   * longer, a controller's rumble harder.
   */
  vibration: number;
}

export interface PlayerSettings {
  sound: SoundSettings;
  controls: ControlSettings;
  /** The worlds the player plays with animations off: characters keep the simple motion drawn in code. */
  animationsOff: string[];
}

export const DEFAULT_SETTINGS: PlayerSettings = {
  sound: { master: 0.8, interface: 0.7, effects: 0.8, music: 0.6, ambience: 0.6, voices: 0.9 },
  controls: { vibration: 0.4 },
  animationsOff: [],
};

/** A player's settings as saved, with anything missing or out of range set to its default. */
export function normalizeSettings(raw: unknown): PlayerSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as { sound?: Partial<SoundSettings>; controls?: Partial<ControlSettings>; animationsOff?: unknown };
  const d = DEFAULT_SETTINGS.sound;
  const unit = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);
  return {
    sound: {
      master: unit(s.sound?.master, d.master),
      interface: unit(s.sound?.interface, d.interface),
      effects: unit(s.sound?.effects, d.effects),
      music: unit(s.sound?.music, d.music),
      ambience: unit(s.sound?.ambience, d.ambience),
      voices: unit(s.sound?.voices, d.voices),
    },
    controls: {
      vibration: unit(s.controls?.vibration, DEFAULT_SETTINGS.controls.vibration),
    },
    animationsOff: Array.isArray(s.animationsOff) ? [...new Set(s.animationsOff.filter((id): id is string => typeof id === 'string' && id.length <= 40))].slice(-500) : [],
  };
}
