import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encryptField, decryptField, blindIndex, maskEmail, maskPhone } from '../src/crypto/encryption.js';

describe('Field-Level AES-256-GCM Encryption & Blind Indexing', () => {
  test('encrypts and decrypts string data correctly', () => {
    const secret = 'user@example.com';
    const encrypted = encryptField(secret);

    assert.notEqual(encrypted, secret);
    const parts = encrypted.split(':');
    assert.equal(parts.length, 3); // iv:tag:ciphertext

    const decrypted = decryptField(encrypted);
    assert.equal(decrypted, secret);
  });

  test('generates unique ciphertexts for identical plaintext due to random IV', () => {
    const text = 'Sensitive Personal Address';
    const enc1 = encryptField(text);
    const enc2 = encryptField(text);

    assert.notEqual(enc1, enc2);
    assert.equal(decryptField(enc1), text);
    assert.equal(decryptField(enc2), text);
  });

  test('fails decryption if ciphertext or auth tag is tampered with', () => {
    const encrypted = encryptField('Confidential phone number');
    const parts = encrypted.split(':');
    
    // Tamper with ciphertext
    const tamperedCiphertext = parts[0] + ':' + parts[1] + ':' + 'aa' + parts[2].slice(2);
    assert.throws(() => decryptField(tamperedCiphertext));

    // Tamper with tag
    const tamperedTag = parts[0] + ':' + '00'.repeat(16) + ':' + parts[2];
    assert.throws(() => decryptField(tamperedTag));
  });

  test('handles null and undefined values safely', () => {
    assert.equal(encryptField(null), null);
    assert.equal(encryptField(undefined), null);
    assert.equal(decryptField(null), null);
    assert.equal(decryptField(undefined), null);
  });

  test('blind index produces consistent hash for search without leaking plaintext', () => {
    const email1 = 'volunteer@scouts.org.uk';
    const email2 = 'VOLUNTEER@scouts.org.uk '; // Different case and whitespace
    const hash1 = blindIndex(email1);
    const hash2 = blindIndex(email2);

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64); // 32-byte sha256 hex
  });

  test('masking functions redact sensitive information properly', () => {
    assert.equal(maskEmail('jane.doe@example.com'), 'j***e@example.com');
    assert.equal(maskEmail('ab@example.com'), '***@example.com');
    assert.equal(maskEmail(''), '');

    assert.equal(maskPhone('07700 900123'), '••••••••0123');
    assert.equal(maskPhone('123'), '••••');
  });
});
