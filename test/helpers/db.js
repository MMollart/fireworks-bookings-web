import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { wrapSqlite } from '../../src/db/adapter.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Fresh in-memory SQLite with all migrations applied, behind the async db interface. */
export function createInMemoryDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  return wrapSqlite(sqlite);
}
