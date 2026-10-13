import { Hono } from 'hono';
import { hashPassword, validatePasswordPolicy } from '../auth/passwords.js';
import { destroyUserSessions } from '../auth/sessions.js';
import { listTicketTypes, saveTicketType, deleteTicketType } from '../domain/ticketTypes.js';
import { reindexCustomers } from '../domain/customers.js';

const VALID_ROLES = ['admin', 'operator', 'viewer'];

export function adminRoutes() {
  const r = new Hono();

  r.get('/users', async (c) => {
    const users = await c
      .get('db')
      .prepare('SELECT id, username, role, is_active, created_at, updated_at, last_login_at FROM users ORDER BY id ASC')
      .all();
    return c.json({ users });
  });

  r.post('/users', async (c) => {
    const db = c.get('db');
    const { username, password, role = 'viewer' } = await c.req.json().catch(() => ({}));

    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return c.json({ error: 'Username must be at least 3 characters long' }, 400);
    }
    const trimmed = username.trim();

    const policy = validatePasswordPolicy(password);
    if (!policy.valid) return c.json({ error: policy.error }, 400);
    if (!VALID_ROLES.includes(role)) {
      return c.json({ error: `Invalid role. Allowed roles: ${VALID_ROLES.join(', ')}` }, 400);
    }

    const existing = await db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(trimmed);
    if (existing) return c.json({ error: `User '${trimmed}' already exists` }, 409);

    const now = new Date().toISOString();
    const result = await db
      .prepare(
        `INSERT INTO users (username, password_hash, salt, role, is_active, created_at, updated_at)
         VALUES (?, ?, '', ?, 1, ?, ?)`
      )
      .run(trimmed, await hashPassword(password), role, now, now);

    const user = await db
      .prepare('SELECT id, username, role, is_active, created_at, updated_at FROM users WHERE id = ?')
      .get(result.lastInsertRowid);
    return c.json({ success: true, message: `User '${trimmed}' created successfully`, user }, 201);
  });

  r.patch('/users/:id/status', async (c) => {
    const db = c.get('db');
    const userId = parseInt(c.req.param('id'), 10);
    const body = await c.req.json().catch(() => ({}));
    const isActive = body.isActive !== undefined ? body.isActive : body.is_active;

    if (isActive === undefined) return c.json({ error: 'isActive or is_active boolean is required' }, 400);
    if (c.get('user').id === userId && !isActive) {
      return c.json({ error: 'You cannot disable your own administrator account' }, 400);
    }

    const result = await db
      .prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?')
      .run(isActive ? 1 : 0, new Date().toISOString(), userId);
    if (result.changes === 0) return c.json({ error: 'User not found' }, 404);

    if (!isActive) await destroyUserSessions(db, userId);

    const updated = await db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(userId);
    return c.json({
      success: true,
      message: `User '${updated.username}' is now ${updated.is_active ? 'active' : 'disabled'}`,
      user: updated,
    });
  });

  const resetPassword = async (c) => {
    const db = c.get('db');
    const userId = parseInt(c.req.param('id'), 10);
    const body = await c.req.json().catch(() => ({}));
    const pwd = body.password || body.newPassword;

    const policy = validatePasswordPolicy(pwd);
    if (!policy.valid) return c.json({ error: policy.error }, 400);

    const user = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!user) return c.json({ error: 'User not found' }, 404);

    await db
      .prepare("UPDATE users SET password_hash = ?, salt = '', updated_at = ? WHERE id = ?")
      .run(await hashPassword(pwd), new Date().toISOString(), userId);
    await destroyUserSessions(db, userId);

    return c.json({ success: true, message: `Password reset successfully for user '${user.username}'` });
  };

  r.post('/users/:id/reset-password', resetPassword);
  r.post('/users/:id/password', resetPassword);

  // Ticket type dictionary: which reporting category each distinct TicketSource ticket type belongs to.
  r.get('/ticket-types', async (c) => c.json(await listTicketTypes(c.get('db'))));

  r.put('/ticket-types', async (c) => {
    const { ticket_type, category } = await c.req.json().catch(() => ({}));
    try {
      return c.json({ success: true, entry: await saveTicketType(c.get('db'), ticket_type, category) });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  r.delete('/ticket-types', async (c) => {
    const ok = await deleteTicketType(c.get('db'), c.req.query('type'));
    return ok ? c.json({ success: true }) : c.json({ error: 'Ticket type is not in the dictionary' }, 404);
  });

  // Builds the customer search index for customers imported before it existed. Call until remaining = 0.
  r.post('/customers/reindex', async (c) => c.json(await reindexCustomers(c.get('db'))));

  return r;
}
