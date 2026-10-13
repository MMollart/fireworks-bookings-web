import { Hono } from 'hono';
import { config } from '../config.js';
import { requireAuth, requireOperator } from '../auth/middleware.js';
import { TicketSourceSync } from '../sync/ticketsource.js';
import { timingSafeEqual } from '../lib/bytes.js';

function engine(c) {
  return new TicketSourceSync(c.get('db'), { apiKey: config.ticketSource.apiKey, apiUrl: config.ticketSource.apiUrl });
}

async function secretsMatch(a, b) {
  // Hash first so comparison length never depends on the secret length.
  const h = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return timingSafeEqual(await h(a), await h(b));
}

export function syncRoutes() {
  const r = new Hono();

  r.get('/status', requireAuth, async (c) => {
    const sync = engine(c);
    const latestCheckpoint = (await sync.getLatestCheckpoint()) || null;
    return c.json({
      status: latestCheckpoint ? latestCheckpoint.status : 'idle',
      latestCheckpoint,
      recentLogs: await sync.getRecentLogs(30),
      hasApiKey: Boolean(config.ticketSource.apiKey),
    });
  });

  r.post('/trigger', requireAuth, requireOperator, async (c) => {
    try {
      return c.json(await engine(c).runSync(await c.req.json().catch(() => ({}))));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Incoming TicketSource webhook: authenticated by a shared secret, not a user session.
  r.post('/webhook', async (c) => {
    const expected = config.ticketSource.webhookSecret;
    if (!expected) return c.json({ error: 'Webhook not configured' }, 503);

    const provided = c.req.header('x-webhook-secret') || c.req.query('secret') || '';
    if (!(await secretsMatch(provided, expected))) return c.json({ error: 'Unauthorized' }, 401);

    const payload = await c.req.json().catch(() => null);
    if (!payload) return c.json({ error: 'Payload missing' }, 400);

    try {
      if (payload.order || payload.reference) await engine(c).ingestBooking(payload.order || payload);
      return c.json({ received: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return r;
}
