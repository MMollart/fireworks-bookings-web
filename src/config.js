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
  ticketSource: {
    apiKey: '',
    apiUrl: 'https://api.ticketsource.io',
    stepCalls: 12, // API calls per Worker invocation: keeps each request's CPU time small (Workers Free caps it)
    callsPerMinute: 200, // self-imposed ceiling, TicketSource allows 240/min
    settlementDays: 14, // an event is treated as settled this long after its last date ends
    eventsTtlMinutes: 60,
    customerTtlHours: 168,
  },
};

function intVar(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function initConfig(env = {}) {
  config.env = env.NODE_ENV || 'development';
  config.isProd = config.env === 'production';
  config.sessionTtlHours = parseInt(env.SESSION_TTL_HOURS || '24', 10);
  config.adminInitialUsername = env.ADMIN_INITIAL_USERNAME || 'admin';
  config.adminInitialPassword = env.ADMIN_INITIAL_PASSWORD || '';
  config.ticketSource = {
    apiKey: env.TICKETSOURCE_API_KEY || '',
    apiUrl: env.TICKETSOURCE_API_URL || 'https://api.ticketsource.io',
    stepCalls: intVar(env.TS_STEP_CALLS, 12),
    callsPerMinute: Math.min(intVar(env.TS_CALLS_PER_MINUTE, 200), 240),
    settlementDays: intVar(env.TS_SETTLEMENT_DAYS, 14),
    eventsTtlMinutes: intVar(env.TS_EVENTS_TTL_MINUTES, 60),
    customerTtlHours: intVar(env.TS_CUSTOMER_TTL_HOURS, 168),
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
