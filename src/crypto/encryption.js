import crypto from 'node:crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard 96-bit IV for GCM

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Stored format: <iv_hex>:<auth_tag_hex>:<ciphertext_hex>
 */
export function encrypt(plaintext, customKey = null) {
  if (plaintext === null || plaintext === undefined) {
    return null;
  }
  const text = String(plaintext);
  if (text.length === 0) {
    return '';
  }

  const key = customKey || config.encryptionKey;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string.
 */
export function decrypt(encryptedString, customKey = null) {
  if (encryptedString === null || encryptedString === undefined) {
    return null;
  }
  if (encryptedString === '') {
    return '';
  }

  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    // If not in encrypted format (e.g. legacy/plain), return safely
    return encryptedString;
  }

  const [ivHex, tagHex, dataHex] = parts;
  const key = customKey || config.encryptionKey;

  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(dataHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    throw new Error(`Failed to decrypt data: ${err.message}`);
  }
}

/**
 * Computes a deterministic HMAC-SHA256 blind index for exact search and indexing.
 * Input is normalized (lowercased and trimmed).
 */
export function blindIndex(plaintext, customKey = null) {
  if (plaintext === null || plaintext === undefined) {
    return null;
  }
  const normalized = String(plaintext).trim().toLowerCase();
  if (normalized.length === 0) {
    return '';
  }
  const key = customKey || config.encryptionKey;
  return crypto.createHmac('sha256', key).update(normalized).digest('hex');
}

/**
 * Utility to partially mask sensitive data (e.g., for display/audit logs).
 */
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.length > 2 ? `${local[0]}***${local[local.length - 1]}` : '***';
  return `${visible}@${domain}`;
}

export function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const digits = phone.replace(/\s+/g, '');
  if (digits.length <= 4) return '***';
  return '***' + digits.slice(-4);
}

// Aliases
export const encryptField = encrypt;
export const decryptField = decrypt;

export default {
  encrypt,
  decrypt,
  blindIndex,
  maskEmail,
  maskPhone,
  encryptField,
  decryptField,
};
