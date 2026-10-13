import { config } from '../config.js';
import { randomHex, sha256Hex } from '../lib/bytes.js';

export function hashSessionToken(rawToken) {
  return sha256Hex(rawToken);
}

export async function createSession(db, userId, options = {}) {
  const rawToken = randomHex(32);
  const tokenHash = await hashSessionToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlHours * 60 * 60 * 1000).toISOString();

  const ipAddress = typeof options === 'string' ? options : options?.ipAddress || null;
  const userAgent = typeof options === 'string' ? arguments[3] || null : options?.userAgent || null;

  await db
    .prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(tokenHash, userId, now.toISOString(), expiresAt, ipAddress, userAgent);

  return { token: rawToken, token_hash: tokenHash, user_id: userId, expiresAt, expires_at: expiresAt };
}

export async function getSession(db, rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;

  const row = await db
    .prepare(
      `SELECT s.token, s.user_id, s.created_at, s.expires_at, u.username, u.role, u.is_active
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > ? AND u.is_active = 1`
    )
    .get(await hashSessionToken(rawToken), new Date().toISOString());
  if (!row) return null;

  return {
    tokenHash: row.token,
    user_id: row.user_id,
    user: { id: row.user_id, username: row.username, role: row.role, isActive: Boolean(row.is_active) },
    username: row.username,
    role: row.role,
    expiresAt: row.expires_at,
    expires_at: row.expires_at,
  };
}

export async function destroySession(db, rawToken) {
  if (!rawToken) return;
  await db.prepare('DELETE FROM sessions WHERE token = ?').run(await hashSessionToken(rawToken));
}

export async function destroyUserSessions(db, userId) {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export async function pruneExpiredSessions(db) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

/** Options for hono/cookie setCookie. */
export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'Lax',
    maxAge: config.sessionTtlHours * 60 * 60,
    path: '/',
  };
}

export default { hashSessionToken, createSession, getSession, destroySession, destroyUserSessions, pruneExpiredSessions, getSessionCookieOptions };
