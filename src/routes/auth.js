import express from 'express';
import { config } from '../config.js';
import { verifyPassword } from '../auth/passwords.js';
import { createSession, destroySession, getSessionCookieOptions } from '../auth/sessions.js';
import { loginRateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../auth/middleware.js';

export function createAuthRoutes(db) {
  const router = express.Router();

  // POST /api/auth/login
  router.post('/login', loginRateLimiter, (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.prepare(`
      SELECT id, username, password_hash, salt, role, is_active
      FROM users
      WHERE username = ? COLLATE NOCASE
    `).get(username.trim());

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password', message: 'Invalid username or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is disabled. Please contact an administrator.', message: 'Account is disabled' });
    }

    const isValid = verifyPassword(password, user.password_hash, user.salt);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid username or password', message: 'Invalid username or password' });
    }

    // Update last_login_at
    const now = new Date().toISOString();
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);

    // Create session
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const session = createSession(db, user.id, { ipAddress, userAgent });

    // Set cookie
    res.cookie(config.sessionCookieName, session.token, getSessionCookieOptions());

    return res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      expiresAt: session.expiresAt,
    });
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    const rawToken = req.cookies && req.cookies[config.sessionCookieName];
    if (rawToken) {
      destroySession(db, rawToken);
    }
    res.clearCookie(config.sessionCookieName, { path: '/' });
    return res.json({ success: true, message: 'Logged out successfully' });
  });

  // GET /api/auth/me
  router.get('/me', requireAuth(db), (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.json({ user: req.user });
  });

  return router;
}

createAuthRoutes.createAuthRoutes = createAuthRoutes;
export default createAuthRoutes;
