import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { hashPassword } from '../auth/passwords.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let dbInstance = null;

export function getDatabase(dbPath = config.databasePath) {
  if (dbInstance) {
    return dbInstance;
  }

  const isMemory = dbPath === ':memory:';
  if (!isMemory) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Enable foreign keys and WAL mode for file-based SQLite
  db.exec('PRAGMA foreign_keys = ON;');
  if (!isMemory) {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  dbInstance = db;
  initDatabase(db);
  return db;
}

export function runMigrations(db) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);
}

export function initDatabase(db) {
  runMigrations(db);

  // Ensure default admin user exists if table is empty
  const userCountStmt = db.prepare('SELECT COUNT(*) AS count FROM users');
  const userCount = userCountStmt.get();

  if (userCount.count === 0) {
    const passwordHash = hashPassword(config.adminInitialPassword);
    const parts = passwordHash.split(':');
    const salt = parts[1] || '';
    const now = new Date().toISOString();

    const insertAdmin = db.prepare(`
      INSERT INTO users (username, password_hash, salt, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'admin', 1, ?, ?)
    `);
    insertAdmin.run(config.adminInitialUsername, passwordHash, salt, now, now);
  }

  return db;
}

export function closeDatabase() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
  }
}

// Helper to create an isolated in-memory DB for tests
export function createInMemoryDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);
  return db;
}

export default {
  getDatabase,
  initDatabase,
  runMigrations,
  closeDatabase,
  createInMemoryDatabase,
};
