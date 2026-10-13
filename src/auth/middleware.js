import { getCookie } from 'hono/cookie';
import { config } from '../config.js';
import { getSession } from './sessions.js';

export function getRawToken(c) {
  const bearer = c.req.header('authorization');
  return getCookie(c, config.sessionCookieName) || (bearer?.startsWith('Bearer ') ? bearer.slice(7) : null);
}

/** Resolves the current user (if any) onto the context; never rejects. */
export async function loadUser(c, next) {
  const token = getRawToken(c);
  const session = token ? await getSession(c.get('db'), token) : null;
  c.set('user', session ? session.user : null);
  c.set('sessionToken', session ? token : null);
  await next();
}

export async function requireAuth(c, next) {
  if (!c.get('user')) {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Unauthorized', message: 'Authentication required' }, 401);
    }
    return c.redirect('/login');
  }
  await next();
}

export async function requireAdmin(c, next) {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Forbidden', message: 'Administrator privileges required' }, 403);
  }
  await next();
}

/** Blocks read-only (viewer) accounts from mutating endpoints. */
export async function requireOperator(c, next) {
  const user = c.get('user');
  if (!user || user.role === 'viewer') {
    return c.json({ error: 'Permission denied. Operator or admin role required.' }, 403);
  }
  await next();
}
