import { config } from '../config.js';
import { toHex, fromHex, randomHex } from '../lib/bytes.js';

const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_BYTES = 16;
const enc = new TextEncoder();
const dec = new TextDecoder();

const keyCache = new Map();

function importKey(hex, algorithm, usages) {
  const id = `${algorithm.name}:${usages.join()}:${hex}`;
  if (!keyCache.has(id)) {
    keyCache.set(id, crypto.subtle.importKey('raw', fromHex(hex), algorithm, false, usages));
  }
  return keyCache.get(id);
}

/**
 * AES-256-GCM. Stored format: <iv_hex>:<auth_tag_hex>:<ciphertext_hex>
 * (WebCrypto appends the tag to the ciphertext; we split it back out so the
 * stored format is unchanged from the original Node implementation.)
 */
export async function encrypt(plaintext, customKeyHex = null) {
  if (plaintext === null || plaintext === undefined) return null;
  const text = String(plaintext);
  if (text.length === 0) return '';

  const key = await importKey(customKeyHex || config.encryptionKeyHex, { name: 'AES-GCM' }, ['encrypt']);
  const iv = fromHex(randomHex(IV_LENGTH));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
  const ciphertext = sealed.slice(0, sealed.length - TAG_BYTES);
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  return `${toHex(iv)}:${toHex(tag)}:${toHex(ciphertext)}`;
}

export async function decrypt(encryptedString, customKeyHex = null) {
  if (encryptedString === null || encryptedString === undefined) return null;
  if (encryptedString === '') return '';

  const parts = encryptedString.split(':');
  if (parts.length !== 3) return encryptedString; // legacy/plain value

  try {
    const [ivHex, tagHex, dataHex] = parts;
    const key = await importKey(customKeyHex || config.encryptionKeyHex, { name: 'AES-GCM' }, ['decrypt']);
    const sealed = new Uint8Array([...fromHex(dataHex), ...fromHex(tagHex)]);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(ivHex) }, key, sealed);
    return dec.decode(plain);
  } catch (err) {
    throw new Error(`Failed to decrypt data: ${err.message}`);
  }
}

/** Deterministic HMAC-SHA256 blind index over the trimmed, lower-cased input. */
export async function blindIndex(plaintext, customKeyHex = null) {
  if (plaintext === null || plaintext === undefined) return null;
  const normalized = String(plaintext).trim().toLowerCase();
  if (normalized.length === 0) return '';
  const key = await importKey(customKeyHex || config.encryptionKeyHex, { name: 'HMAC', hash: 'SHA-256' }, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(normalized)));
}

export function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.length > 2 ? `${local[0]}***${local[local.length - 1]}` : '***';
  return `${visible}@${domain}`;
}

export function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  if (phone.length <= 4) return '••••';
  return '•'.repeat(phone.length - 4) + phone.slice(-4);
}

export const encryptField = encrypt;
export const decryptField = decrypt;

export default { encrypt, decrypt, blindIndex, maskEmail, maskPhone, encryptField, decryptField };
