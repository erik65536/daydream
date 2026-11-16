/** The editor's requests to its local server. Every change is sent as JSON, which is all the server takes. */
export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const change = method !== 'GET';
  const res = await fetch(url, {
    method,
    headers: change ? { 'content-type': 'application/json' } : undefined,
    body: change ? JSON.stringify(body ?? {}) : undefined,
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out?.error ?? res.statusText);
  return out as T;
}

export const get = <T,>(url: string) => call<T>('GET', url);
export const post = <T,>(url: string, body: unknown = {}) => call<T>('POST', url, body);
export const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);
export const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** A step's state, in words. */
export const STATE_WORDS = { fresh: 'up to date', stale: 'out of date', missing: 'not run', failed: 'failed' } as const;
