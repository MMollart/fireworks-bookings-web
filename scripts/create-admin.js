#!/usr/bin/env node
/**
 * Create (or reset) an administrator in a D1 database.
 *
 *   node scripts/create-admin.js <username> <password> [--local]
 *
 * Hashes the password here (PBKDF2, same as the Worker) and runs an upsert via
 * `wrangler d1 execute`. Targets the remote database unless --local is given.
 */
import { spawnSync } from 'node:child_process';
import { hashPassword } from '../src/auth/passwords.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const local = process.argv.includes('--local');
const [username, password] = args;
const DB_NAME = process.env.D1_DATABASE_NAME || 'fireworks_bookings_d1';

if (!username || !password || password.length < 8 || !/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
  console.error('Usage: node scripts/create-admin.js <username> <password (8+ chars)> [--local]');
  console.error('Username may contain letters, digits, ., _ and - only.');
  process.exit(1);
}

const hash = await hashPassword(password);
const now = new Date().toISOString();
const sql =
  `INSERT INTO users (username, password_hash, salt, role, is_active, created_at, updated_at) ` +
  `VALUES ('${username}', '${hash}', '', 'admin', 1, '${now}', '${now}') ` +
  `ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', is_active = 1, updated_at = excluded.updated_at;`;

const res = spawnSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', '--command', sql], {
  stdio: 'inherit',
});
if (res.status === 0) console.log(`Admin '${username}' is ready (${local ? 'local' : 'remote'}).`);
process.exit(res.status ?? 1);
