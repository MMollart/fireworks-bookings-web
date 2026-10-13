import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';

describe('Password Hashing & Verification (PBKDF2)', () => {
  test('hashes password with unique random salts', async () => {
    const password = 'SuperSecretPassword123!';
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    assert.ok(hash1.startsWith('pbkdf2:'));
    assert.ok(hash2.startsWith('pbkdf2:'));
    // Different salts mean different hashes
    assert.notEqual(hash1, hash2);

    const parts = hash1.split(':');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'pbkdf2');
    assert.equal(parts[1].length, 32); // 16 bytes hex salt
    assert.equal(parts[2].length, 64); // 32 bytes hex key
  });

  test('successfully verifies matching password', async () => {
    const password = 'CorrectHorseBatteryStaple!';
    const hash = await hashPassword(password);
    assert.equal(await verifyPassword(password, hash), true);
  });

  test('rejects incorrect password', async () => {
    const hash = await hashPassword('correctPassword');
    assert.equal(await verifyPassword('wrongPassword', hash), false);
  });

  test('handles malformed or invalid hash gracefully', async () => {
    assert.equal(await verifyPassword('password', 'invalid-hash'), false);
    assert.equal(await verifyPassword('password', ''), false);
    assert.equal(await verifyPassword('password', null), false);
    assert.equal(await verifyPassword('', 'pbkdf2:abc:def'), false);
  });

  test('throws when hashing empty or invalid passwords', async () => {
    await assert.rejects(() => hashPassword(''), /Password must be a non-empty string/);
    await assert.rejects(() => hashPassword(null), /Password must be a non-empty string/);
  });
});
