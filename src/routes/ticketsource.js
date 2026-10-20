import { Hono } from 'hono';
import { config } from '../config.js';
import { requireOperator, requireAdmin } from '../auth/middleware.js';
import { TicketSourceClient, StepLimit, rateStatus, getState } from '../ticketsource/client.js';
import { refreshEvents, listEventSummaries } from '../ticketsource/events.js';
import { syncEventStep } from '../ticketsource/engine.js';
import { refreshUnsettled } from '../ticketsource/auto.js';

const makeClient = (c) => new TicketSourceClient(c.get('db'), config.ticketSource);

function stepFailure(c, err) {
  if (err instanceof StepLimit) {
    return c.json({ done: false, waiting: err.reason, retryAfterMs: err.retryAfterMs, message: err.message });
  }
  const status = err.status && err.status >= 400 && err.status < 500 && err.status !== 401 ? err.status : 502;
  return c.json({ error: err.message }, status);
}

export function ticketSourceRoutes() {
  const r = new Hono();

  // Cached events with derived state (unsettled | settled | archived). Costs no TicketSource API calls.
  r.get('/events', async (c) => {
    const db = c.get('db');
    const state = c.req.query('state');
    if (state && !['unsettled', 'settled', 'archived'].includes(state)) {
      return c.json({ error: 'state must be unsettled, settled or archived' }, 400);
    }
    const events = await listEventSummaries(db, { settlementDays: config.ticketSource.settlementDays, state });
    return c.json({
      events,
      configured: Boolean(config.ticketSource.apiKey),
      rate: await rateStatus(db, config.ticketSource.callsPerMinute),
      settlementDays: config.ticketSource.settlementDays,
      autoRefresh: {
        everyMinutes: 30,
        lastRunAt: await getState(db, 'auto_refresh_at'),
        lastResult: JSON.parse((await getState(db, 'auto_refresh_result')) || 'null'),
      },
    });
  });

  // Refresh the events/dates cache from the API (respects the cache TTL unless force = true).
  r.post('/events/refresh', requireOperator, async (c) => {
    const { force } = await c.req.json().catch(() => ({}));
    const client = makeClient(c);
    try {
      await client.begin();
      await refreshEvents(c.get('db'), client, { force: Boolean(force), ttlMs: config.ticketSource.eventsTtlMinutes * 60_000 });
      return c.json({ done: true, calls: client.callsMade });
    } catch (err) {
      return stepFailure(c, err);
    } finally {
      await client.end();
    }
  });

  // One resumable step of an event's booking sync. Call repeatedly until done = true.
  r.post('/events/:id/sync', requireOperator, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const mode = ['incremental', 'full', 'force'].includes(body.mode) ? body.mode : undefined;
    try {
      const result = await syncEventStep(
        c.get('db'),
        makeClient(c),
        c.req.param('id'),
        { mode, start: Boolean(body.start), restart: Boolean(body.restart), refreshDates: Boolean(body.refreshDates) },
        config.ticketSource
      );
      return c.json(result);
    } catch (err) {
      return stepFailure(c, err);
    }
  });

  // Runs the scheduled refresh of unsettled events now (admin), within a short time budget.
  r.post('/auto-refresh', requireAdmin, async (c) => c.json(await refreshUnsettled(c.get('db'), config.ticketSource, { budgetMs: 25_000 })));

  // Pin an event as settled/unsettled (TicketSource's API has no settlement flag). null = automatic.
  r.patch('/events/:id/state', requireAdmin, async (c) => {
    const { state } = await c.req.json().catch(() => ({}));
    if (state !== null && !['settled', 'unsettled'].includes(state)) {
      return c.json({ error: 'state must be settled, unsettled or null' }, 400);
    }
    const res = await c.get('db').prepare('UPDATE ts_events SET state_override = ? WHERE id = ?').run(state, c.req.param('id'));
    return res.changes ? c.json({ success: true }) : c.json({ error: 'Event not found' }, 404);
  });

  return r;
}
