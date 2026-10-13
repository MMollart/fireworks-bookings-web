#!/usr/bin/env node
/**
 * CLI script to apply schema migrations to the database.
 * Usage:
 *   node scripts/migrate.js
 */

import { getDatabase, runMigrations, closeDatabase } from '../src/db/index.js';

console.log('Running database migrations...');

try {
  const db = getDatabase();
  runMigrations(db);
  console.log('✅ Migrations applied successfully.');
} catch (err) {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
} finally {
  closeDatabase();
}
