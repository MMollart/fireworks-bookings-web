import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { config } from '../config.js';
import { verifyPassword, hashPassword } from '../auth/passwords.js';
import { createSession, destroySession, getSessionCookieOptions } from '../auth/sessions.js';
import { requireAuth } from '../auth/middleware.js';
import { hit, clear, clientIp } from '../middleware/rateLimit.js';

const LOGIN_LIMIT = { windowMs: 15 * 60 * 1000, max: 10 };
// Verified against when the username doesn't exist, so response time doesn't reveal valid usernames.
let dummyHash = null;

export function authRoutes() {
  const r = new Hono();

  r.post('/login', async (c) => {
    const db = c.get('db');
    const ip = clientIp(c);
    const limitKey = `login:${ip}`;

    const rl = await hit(db, limitKey, LOGIN_LIMIT);
    if (rl.limited) {
      c.header('Retry-After', String(rl.retryAfter));
      return c.json(
        { error: 'Too Many Requests', message: 'Too many login attempts. Please wait 15 minutes before trying again.', retryAfter: rl.retryAfter },
        429
      );
    }

    const { username, password } = await c.req.json().catch(() => ({}));
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return c.json({ error: 'Username and password are required' }, 400);
    }

    const user = await db
      .prepare('SELECT id, username, password_hash, role, is_active FROM users WHERE username = ? COLLATE NOCASE')
      .get(username.trim());

    if (!user) {
      dummyHash ??= await hashPassword('timing-equaliser');
      await verifyPassword(password, dummyHash);
      return c.json({ error: 'Invalid username or password', message: 'Invalid username or password' }, 401);
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return c.json({ error: 'Invalid username or password', message: 'Invalid username or password' }, 401);
    }
    if (!user.is_active) {
      return c.json({ error: 'Account is disabled. Please contact an administrator.', message: 'Account is disabled' }, 403);
    }

    await clear(db, limitKey);
    await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);

    const session = await createSession(db, user.id, { ipAddress: ip, userAgent: c.req.header('user-agent') });
    setCookie(c, config.sessionCookieName, session.token, getSessionCookieOptions());

    return c.json({
      success: true,
      user: { id: user.id, username: user.username, role: user.role },
      expiresAt: session.expiresAt,
    });
  });

  r.post('/logout', async (c) => {
    const token = c.get('sessionToken');
    if (token) await destroySession(c.get('db'), token);
    deleteCookie(c, config.sessionCookieName, { path: '/' });
    return c.json({ success: true, message: 'Logged out successfully' });
  });

  r.get('/me', requireAuth, (c) => c.json({ user: c.get('user') }));

  return r;
}
