import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

// Ensure 32-byte encryption key buffer
function resolveEncryptionKey(rawKey) {
  if (rawKey && rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  if (rawKey && rawKey.length >= 16) {
    return crypto.createHash('sha256').update(rawKey).digest();
  }
  // Fallback for development/testing only
  const devSeed = process.env.SESSION_SECRET || 'fireworks-bookings-default-dev-key';
  return crypto.createHash('sha256').update(devSeed).digest();
}

export const config = {
  env,
  isProd,
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  sessionSecret: process.env.SESSION_SECRET || 'dev-fireworks-session-secret-change-me-32-chars',
  sessionCookieName: 'fb_session',
  sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS || '24', 10),
  session: {
    secret: process.env.SESSION_SECRET || 'dev-fireworks-session-secret-change-me-32-chars',
    cookieName: 'fb_session',
    ttlHours: parseInt(process.env.SESSION_TTL_HOURS || '24', 10),
  },
  encryptionKey: resolveEncryptionKey(process.env.ENCRYPTION_KEY),
  databasePath: process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'fireworks.db'),
  adminInitialUsername: process.env.ADMIN_INITIAL_USERNAME || 'admin',
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || 'ChangeMeNow123!',
  ticketSource: {
    apiKey: process.env.TICKETSOURCE_API_KEY || '',
    apiUrl: process.env.TICKETSOURCE_API_URL || 'https://api.ticketsource.co.uk',
  },
};

export default config;
