import crypto from 'node:crypto';

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
};

/**
 * Hashes a password using scrypt with a secure random salt.
 * Returns an object containing the hash hex, salt hex, and combined string.
 */
export function hashPassword(password, customSalt = null) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  const salt = customSalt || crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  const hash = derivedKey.toString('hex');

  return {
    hash,
    salt,
    combined: `scrypt:${salt}:${hash}`,
  };
}

/**
 * Verifies a password against stored credentials.
 * Supports:
 * - verifyPassword(password, hash, salt)
 * - verifyPassword(password, 'scrypt:<salt>:<hash>')
 */
export function verifyPassword(password, storedHash, storedSalt = null) {
  if (!password || !storedHash) {
    return false;
  }

  let hash = storedHash;
  let salt = storedSalt;

  // Handle combined format 'scrypt:<salt>:<hash>'
  if (typeof storedHash === 'string' && storedHash.startsWith('scrypt:')) {
    const parts = storedHash.split(':');
    if (parts.length === 3) {
      salt = parts[1];
      hash = parts[2];
    }
  }

  if (!salt || !hash) {
    return false;
  }

  try {
    const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
    const storedBuffer = Buffer.from(hash, 'hex');
    if (storedBuffer.length !== derivedKey.length) {
      return false;
    }
    return crypto.timingSafeEqual(storedBuffer, derivedKey);
  } catch {
    return false;
  }
}

export function validatePasswordPolicy(password) {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password must be a string' };
  }
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long' };
  }
  return { valid: true };
}

export default {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
};
