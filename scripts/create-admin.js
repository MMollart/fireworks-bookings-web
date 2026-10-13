#!/usr/bin/env node
/**
 * CLI script to create an administrator user account.
 * Usage:
 *   node scripts/create-admin.js [username] [password]
 */

import { getDatabase, closeDatabase } from '../src/db/index.js';
import { hashPassword } from '../src/auth/passwords.js';

const username = process.argv[2] || process.env.ADMIN_USERNAME || 'admin';
const password = process.argv[3] || process.env.ADMIN_PASSWORD;

if (!password) {
  console.error('Error: Password is required.');
  console.log('Usage: node scripts/create-admin.js <username> <password>');
  console.log('Or define ADMIN_USERNAME and ADMIN_PASSWORD in your .env file.');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Error: Password must be at least 8 characters long.');
  process.exit(1);
}

const db = getDatabase();

try {
  const existing = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
  const passwordHash = hashPassword(password);
  const parts = passwordHash.split(':');
  const salt = parts[1] || '';

  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, salt = ?, role = "admin", is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(passwordHash, salt, existing.id);
    console.log('✅ Updated existing user to role "admin" with new password.');
  } else {
    db.prepare('INSERT INTO users (username, password_hash, salt, role, is_active) VALUES (?, ?, ?, "admin", 1)')
      .run(username, passwordHash, salt);
    console.log('✅ Admin user provisioned successfully.');
  }
} catch (err) {
  console.error('Failed to create admin user:', err.message);
  process.exit(1);
} finally {
  closeDatabase();
}
