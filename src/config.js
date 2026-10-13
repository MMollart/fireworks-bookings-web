/**
 * Runtime configuration. Workers have no process.env, so values come from the
 * `env` bindings (wrangler vars + secrets) via initConfig(env) at request time.
 * Tests / CLI scripts can call initConfig({ ... }) with a plain object.
 */

const DEV_SESSION_SECRET = 'dev-fireworks-session-secret-change-me-32-chars';
const DEV_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export const config = {
  env: 'development',
  isProd: false,
  sessionCookieName: 'fb_session',
  sessionTtlHours: 24,
  encryptionKeyHex: DEV_ENCRYPTION_KEY,
  sessionSecret: DEV_SESSION_SECRET,
  adminInitialUsername: 'admin',
  adminInitialPassword: '',
  ticketSource: { apiKey: '', apiUrl: 'https://api.ticketsource.co.uk', webhookSecret: '' },
};

let initialisedFor = null;

export function initConfig(env = {}) {
  if (initialisedFor === env) return config;
  initialisedFor = env;

  config.env = env.NODE_ENV || 'development';
  config.isProd = config.env === 'production';
  config.sessionTtlHours = parseInt(env.SESSION_TTL_HOURS || '24', 10);
  config.adminInitialUsername = env.ADMIN_INITIAL_USERNAME || 'admin';
  config.adminInitialPassword = env.ADMIN_INITIAL_PASSWORD || '';
  config.ticketSource = {
    apiKey: env.TICKETSOURCE_API_KEY || '',
    apiUrl: env.TICKETSOURCE_API_URL || 'https://api.ticketsource.co.uk',
    webhookSecret: env.TICKETSOURCE_WEBHOOK_SECRET || '',
  };

  const key = env.ENCRYPTION_KEY;
  if (key) {
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('ENCRYPTION_KEY must be a 64-character hex string (openssl rand -hex 32)');
    }
    config.encryptionKeyHex = key;
  } else if (config.isProd) {
    throw new Error('ENCRYPTION_KEY secret is required in production');
  } else {
    config.encryptionKeyHex = DEV_ENCRYPTION_KEY;
  }
  return config;
}

export default config;
