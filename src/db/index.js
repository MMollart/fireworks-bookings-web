import { config } from '../config.js';
import { hashPassword } from '../auth/passwords.js';

let bootstrapped = false;

/**
 * Creates the initial admin user when the users table is empty and an
 * ADMIN_INITIAL_PASSWORD secret is configured. Runs at most once per isolate.
 */
export async function ensureInitialAdmin(db) {
  if (bootstrapped) return;
  if (!config.adminInitialPassword) {
    bootstrapped = true;
    return;
  }
  const { count } = await db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count === 0) {
    const passwordHash = await hashPassword(config.adminInitialPassword);
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT OR IGNORE INTO users (username, password_hash, salt, role, is_active, created_at, updated_at)
         VALUES (?, ?, '', 'admin', 1, ?, ?)`
      )
      .run(config.adminInitialUsername, passwordHash, now, now);
  }
  bootstrapped = true;
}

export function resetBootstrapState() {
  bootstrapped = false;
}
