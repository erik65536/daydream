/** Small line icons for HUD buttons. */
const P = {
  inventory: 'M7 8V6a5 5 0 0 1 10 0v2M4 8h16l-1 12H5L4 8zm5 4h6',
  character: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0',
  skills: 'M12 2l2.6 6.6L21 9l-5 4.4L17.4 21 12 17.3 6.6 21 8 13.4 3 9l6.4-.4z',
  quests: 'M6 3h10l3 3v15H6zM9 8h7M9 12h7M9 16h4',
  map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15',
  menu: 'M4 6h16M4 12h16M4 18h16',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7v.5M12 17h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  craft: 'M14 6l4 4-9 9-4-4zM16 4l4 4M4 20l2-2',
  /** A line that could not be voiced; sound muted. */
  muted: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9.5l5 5M21 9.5l-5 5',
  /** Sound on. */
  sound: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9.5a3.6 3.6 0 0 1 0 5M18.2 7a7.2 7.2 0 0 1 0 10',
  /** Talking to everyone in the adventure. */
  chat: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 9.5h8M8 12.5h5',
  /** Speaking instead of typing. */
  mic: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  send: 'M4 12 20 4l-4 16-4.5-6.5zM11.5 13.5 20 4',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  dev: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14',
  settings: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4',
  /** Saving a copy of the adventure. */
  copy: 'M9 9h10v11H9zM5 15V4h10',
  /** Leaving for the world page. */
  leave: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  chevron: 'M9 6l6 6-6 6',
  codex: 'M4 5a2 2 0 0 1 2-2h5v17H6a2 2 0 0 0-2 2zM20 5a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 1 2 2zM7 8h2M15 8h2M7 12h2M15 12h2',
  /** In a fight: two crossed blades. */
  fight: 'M5 4l11 11M13.5 17.5l4-4M17 17l3 3M19 4 8 15M10.5 17.5l-4-4M7 17l-3 3',
  /** Fights on their own: the hero's own blade, guided by its own star. */
  own: 'M4.5 19.5 13.5 10.5M6.5 14.5l3 3M3 21l1.5-1.5M18 2.8c.5 2.4 1.3 3.2 3.7 3.7-2.4.5-3.2 1.3-3.7 3.7-.5-2.4-1.3-3.2-3.7-3.7 2.4-.5 3.2-1.3 3.7-3.7z',
};

export function Icon({ name, size = 18, color = 'var(--gold-2)' }: { name: keyof typeof P; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ color }}>
      <path d={P[name]} />
    </svg>
  );
}
