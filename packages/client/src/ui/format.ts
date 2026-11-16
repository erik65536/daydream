/** Times, money, and counts said the same way on every page outside the game. */

/** When something happened, said plainly: "just now", "5 minutes ago", "yesterday". */
export function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** A length of time in a few characters, for the administrators' tables: "40s", "5m 12s", "3h 4m", "2d 6h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Dollars as accounts show them: cents, and under ten cents as fine as a hundredth of a cent ("$0.0027", "$0.05"). */
export const usd = (d = 0) => `$${d && d < 0.1 ? d.toFixed(4).replace(/0{1,2}$/, '') : d.toFixed(2)}`;

/** A count with its noun: "1 place", "1,200 fights". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** A word with its first letter large (a size or length as a label). */
export const capital = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1);
