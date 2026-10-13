import { toHex, fromHex, randomHex, timingSafeEqual } from '../lib/bytes.js';

// PBKDF2-SHA256 via WebCrypto (native, fast, and the max iteration count Workers allows).
const ITERATIONS = 100000;
const KEY_BYTES = 32;
const PREFIX = 'pbkdf2';

async function derive(password, saltHex) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: ITERATIONS },
    base,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

/** Returns 'pbkdf2:<salt_hex>:<hash_hex>'. */
export async function hashPassword(password, customSalt = null) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  const salt = customSalt || randomHex(16);
  return `${PREFIX}:${salt}:${toHex(await derive(password, salt))}`;
}

/** Verifies against 'pbkdf2:<salt>:<hash>'. */
export async function verifyPassword(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  try {
    const derived = await derive(password, parts[1]);
    return timingSafeEqual(fromHex(parts[2]), derived);
  } catch {
    return false;
  }
}

export function validatePasswordPolicy(password) {
  if (typeof password !== 'string') return { valid: false, error: 'Password must be a string' };
  if (password.length < 8) return { valid: false, error: 'Password must be at least 8 characters long' };
  return { valid: true };
}

export default { hashPassword, verifyPassword, validatePasswordPolicy };
