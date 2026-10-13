import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';

describe('Password Hashing & Verification (scrypt)', () => {
  test('hashes password with unique random salts', () => {
    const password = 'SuperSecretPassword123!';
    const hash1 = hashPassword(password);
    const hash2 = hashPassword(password);

    assert.ok(hash1.startsWith('scrypt:'));
    assert.ok(hash2.startsWith('scrypt:'));
    // Different salts mean different hashes
    assert.notEqual(hash1, hash2);

    const parts = hash1.split(':');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'scrypt');
    assert.equal(parts[1].length, 32); // 16 bytes hex salt
    assert.equal(parts[2].length, 128); // 64 bytes hex key
  });

  test('successfully verifies matching password', () => {
    const password = 'CorrectHorseBatteryStaple!';
    const hash = hashPassword(password);
    assert.equal(verifyPassword(password, hash), true);
  });

  test('rejects incorrect password', () => {
    const hash = hashPassword('correctPassword');
    assert.equal(verifyPassword('wrongPassword', hash), false);
  });

  test('handles malformed or invalid hash gracefully', () => {
    assert.equal(verifyPassword('password', 'invalid-hash'), false);
    assert.equal(verifyPassword('password', ''), false);
    assert.equal(verifyPassword('password', null), false);
    assert.equal(verifyPassword('', 'scrypt:abc:def'), false);
  });

  test('throws when hashing empty or invalid passwords', () => {
    assert.throws(() => hashPassword(''), /Password must be a non-empty string/);
    assert.throws(() => hashPassword(null), /Password must be a non-empty string/);
  });
});
