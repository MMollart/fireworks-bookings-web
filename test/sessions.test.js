import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDatabase } from '../src/db/index.js';
import { createSession, getSession, destroySession, destroyUserSessions } from '../src/auth/sessions.js';
import { hashPassword } from '../src/auth/passwords.js';

describe('Session Management & Storage', () => {
  let db;
  let testUser;

  beforeEach(() => {
    db = createInMemoryDatabase();
    const pwdHash = hashPassword('ValidPassword123!');
    const res = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run('sessionuser', pwdHash, 'operator');
    testUser = { id: Number(res.lastInsertRowid), username: 'sessionuser', role: 'operator' };
  });

  test('creates session with secure token and retrieves user data', () => {
    const session = createSession(db, testUser.id, '127.0.0.1', 'TestAgent/1.0');
    assert.ok(session.token);
    assert.equal(session.user_id, testUser.id);

    // Retrieve session
    const retrieved = getSession(db, session.token);
    assert.ok(retrieved);
    assert.equal(retrieved.user_id, testUser.id);
    assert.equal(retrieved.username, 'sessionuser');
    assert.equal(retrieved.role, 'operator');
  });

  test('returns null for nonexistent or invalid token', () => {
    assert.equal(getSession(db, 'non-existent-token'), null);
    assert.equal(getSession(db, ''), null);
    assert.equal(getSession(db, null), null);
  });

  test('destroys single session cleanly', () => {
    const session = createSession(db, testUser.id);
    assert.ok(getSession(db, session.token));

    destroySession(db, session.token);
    assert.equal(getSession(db, session.token), null);
  });

  test('destroys all sessions for a specific user', () => {
    const s1 = createSession(db, testUser.id);
    const s2 = createSession(db, testUser.id);

    assert.ok(getSession(db, s1.token));
    assert.ok(getSession(db, s2.token));

    destroyUserSessions(db, testUser.id);

    assert.equal(getSession(db, s1.token), null);
    assert.equal(getSession(db, s2.token), null);
  });

  test('expires old sessions correctly', () => {
    const session = createSession(db, testUser.id);

    // Force expiration date in the past
    db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 hour') WHERE user_id = ?")
      .run(testUser.id);

    assert.equal(getSession(db, session.token), null);
  });
});
