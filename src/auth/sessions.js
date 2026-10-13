import crypto from 'node:crypto';
import { config } from '../config.js';

export function hashSessionToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function createSession(db, userId, options = {}) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlHours * 60 * 60 * 1000).toISOString();
  const createdAt = now.toISOString();

  const ipAddress = typeof options === 'string' ? options : (options?.ipAddress || null);
  const userAgent = typeof options === 'string' ? (arguments[3] || null) : (options?.userAgent || null);

  const stmt = db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    tokenHash,
    userId,
    createdAt,
    expiresAt,
    ipAddress,
    userAgent
  );

  return {
    token: rawToken,
    token_hash: tokenHash,
    user_id: userId,
    expiresAt,
    expires_at: expiresAt,
  };
}

export function getSession(db, rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return null;
  }

  const tokenHash = hashSessionToken(rawToken);
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    SELECT s.token, s.user_id, s.created_at, s.expires_at, u.username, u.role, u.is_active
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ? AND u.is_active = 1
  `);

  const row = stmt.get(tokenHash, now);
  if (!row) {
    return null;
  }

  return {
    tokenHash: row.token,
    user_id: row.user_id,
    user: {
      id: row.user_id,
      username: row.username,
      role: row.role,
      isActive: Boolean(row.is_active),
    },
    username: row.username,
    role: row.role,
    expiresAt: row.expires_at,
    expires_at: row.expires_at,
  };
}

export function destroySession(db, rawToken) {
  if (!rawToken) return;
  const tokenHash = hashSessionToken(rawToken);
  const stmt = db.prepare('DELETE FROM sessions WHERE token = ?');
  stmt.run(tokenHash);
}

export function destroyUserSessions(db, userId) {
  const stmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  stmt.run(userId);
}

export function pruneExpiredSessions(db) {
  const now = new Date().toISOString();
  const stmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  return stmt.run(now);
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    maxAge: config.sessionTtlHours * 60 * 60 * 1000,
    path: '/',
  };
}

export default {
  hashSessionToken,
  createSession,
  getSession,
  destroySession,
  destroyUserSessions,
  pruneExpiredSessions,
  getSessionCookieOptions,
};
