import express from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { hashPassword, validatePasswordPolicy } from '../auth/passwords.js';
import { destroyUserSessions } from '../auth/sessions.js';

export function createAdminRoutes(db) {
  const router = express.Router();

  // All admin routes require admin privileges
  router.use(requireAdmin);

  // GET /api/admin/users
  router.get('/users', (req, res) => {
    const users = db.prepare(`
      SELECT id, username, role, is_active, created_at, updated_at, last_login_at
      FROM users
      ORDER BY id ASC
    `).all();

    return res.json({ users });
  });

  // POST /api/admin/users
  router.post('/users', (req, res) => {
    const { username, password, role = 'viewer' } = req.body || {};

    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters long' });
    }

    const trimmedUsername = username.trim();

    // Validate password policy
    const policy = validatePasswordPolicy(password);
    if (!policy.valid) {
      return res.status(400).json({ error: policy.error });
    }

    const validRoles = ['admin', 'operator', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed roles: ${validRoles.join(', ')}` });
    }

    // Check duplicate
    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(trimmedUsername);
    if (existing) {
      return res.status(409).json({ error: `User '${trimmedUsername}' already exists` });
    }

    const passwordHash = hashPassword(password);
    const parts = passwordHash.split(':');
    const salt = parts[1] || '';
    const now = new Date().toISOString();

    const insertStmt = db.prepare(`
      INSERT INTO users (username, password_hash, salt, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `);

    const result = insertStmt.run(trimmedUsername, passwordHash, salt, role, now, now);

    const newUser = db.prepare(`
      SELECT id, username, role, is_active, created_at, updated_at
      FROM users WHERE id = ?
    `).get(result.lastInsertRowid);

    return res.status(201).json({
      success: true,
      message: `User '${trimmedUsername}' created successfully`,
      user: newUser,
    });
  });

  // PATCH /api/admin/users/:id/status
  router.patch('/users/:id/status', (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const isActive = req.body?.isActive !== undefined ? req.body.isActive : req.body?.is_active;

    if (isActive === undefined) {
      return res.status(400).json({ error: 'isActive or is_active boolean is required' });
    }

    // Prevent admin from disabling their own account
    if (req.user.id === userId && !isActive) {
      return res.status(400).json({ error: 'You cannot disable your own administrator account' });
    }

    const now = new Date().toISOString();
    const stmt = db.prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?');
    const result = stmt.run(isActive ? 1 : 0, now, userId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // If disabled, kill active sessions
    if (!isActive) {
      destroyUserSessions(db, userId);
    }

    const updated = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(userId);
    return res.json({
      success: true,
      message: `User '${updated.username}' is now ${updated.is_active ? 'active' : 'disabled'}`,
      user: updated,
    });
  });

  // POST /api/admin/users/:id/reset-password or /api/admin/users/:id/password
  const handlePasswordReset = (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const pwd = req.body?.password || req.body?.newPassword;

    const policy = validatePasswordPolicy(pwd);
    if (!policy.valid) {
      return res.status(400).json({ error: policy.error });
    }

    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const passwordHash = hashPassword(pwd);
    const parts = passwordHash.split(':');
    const salt = parts[1] || '';
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE users
      SET password_hash = ?, salt = ?, updated_at = ?
      WHERE id = ?
    `).run(passwordHash, salt, now, userId);

    // Invalidate existing sessions so user must log in with new password
    destroyUserSessions(db, userId);

    return res.json({
      success: true,
      message: `Password reset successfully for user '${user.username}'`,
    });
  };

  router.post('/users/:id/reset-password', handlePasswordReset);
  router.post('/users/:id/password', handlePasswordReset);

  return router;
}

createAdminRoutes.createAdminRoutes = createAdminRoutes;
export default createAdminRoutes;
