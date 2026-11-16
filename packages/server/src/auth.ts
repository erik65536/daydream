/** Who is asking: the session cookie, signed-in users, and administrators. */
import type http from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import * as store from './storage.ts';
import { ports, sessionCookie } from './checkout.ts';

/** The session cookie (checkout.ts: named after the server's port when it is not the usual one). */
export const SESSION_COOKIE = sessionCookie(ports().server);

export function cookie(req: Request | http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return undefined; // a malformed cookie is no session
    }
  }
  return undefined;
}

export type AuthedRequest = Request & { user: store.User };

/** Signed-in users only (an active account: a disabled one's sessions end). */
export function auth(req: Request, res: Response, next: NextFunction) {
  const user = store.sessionUser(cookie(req, SESSION_COOKIE));
  if (!user) return void res.status(401).json({ error: 'Please sign in.' });
  (req as AuthedRequest).user = user;
  next();
}

/**
 * Whether a request comes from this site's own pages: its `Origin` names the host the request was made to (behind
 * Caddy, the host Caddy was asked for), or, in development, the Vite client's address (`devClient`). A request with
 * no `Origin` is not a browser's.
 */
export function sameOrigin(req: http.IncomingMessage, devClient?: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
    return o.host === host || (devClient !== undefined && origin === new URL(devClient).origin);
  } catch {
    return false;
  }
}

/**
 * A page of another site may not change anything here with the player's cookie: every request that is not a read
 * comes from this site's own pages (or from no browser at all). Mounted on /api before its routes.
 */
export const ownSiteOnly = (devClient?: string) => (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' || req.method === 'HEAD' || sameOrigin(req, devClient)) return next();
  res.status(403).json({ error: 'This request did not come from this site.' });
};

export function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (!(req as AuthedRequest).user?.isAdmin) return void res.status(403).json({ error: 'Administrators only.' });
  next();
}
