import { Hono } from 'hono';
import { config } from '../config.js';
import { loadScopeOptions, loadBookings, isComplete } from '../analysis/data.js';
import { salesOverTime, GROUPS } from '../analysis/sales.js';
import { compareEvents, COMPARE_GROUPS } from '../analysis/compare.js';
import { loadCodeLines, summariseDiscounts } from '../analysis/discounts.js';
import { eventState } from '../ticketsource/events.js';

async function requireEvent(db, id) {
  if (!id) return null;
  return (await db.prepare('SELECT id, name FROM ts_events WHERE id = ?').get(id)) || null;
}

async function checkPerformance(db, eventId, performanceId) {
  if (!performanceId) return true;
  return Boolean(await db.prepare('SELECT 1 AS ok FROM ts_dates WHERE id = ? AND event_id = ?').get(performanceId, eventId));
}

export function analysisRoutes() {
  const r = new Hono();

  // Events and performances available to analyse, with download completeness.
  r.get('/options', async (c) => {
    const { events, dates } = await loadScopeOptions(c.get('db'));
    const byEvent = new Map();
    for (const d of dates) {
      if (!byEvent.has(d.event_id)) byEvent.set(d.event_id, []);
      byEvent.get(d.event_id).push(d);
    }
    const out = events.map((e) => {
      const performances = byEvent.get(e.id) || [];
      return {
        id: e.id,
        name: e.name,
        bookings: e.bookings,
        state: eventState(e, performances, config.ticketSource.settlementDays),
        complete: performances.length > 0 && performances.every(isComplete),
        performances: performances.map((d) => ({ id: d.id, starts_at: d.starts_at, cancelled: Boolean(d.cancelled), complete: isComplete(d) })),
      };
    });
    return c.json({ events: out, hasDownloadedBookings: out.some((e) => e.bookings > 0) });
  });

  r.get('/sales', async (c) => {
    const db = c.get('db');
    const { eventId, performanceId, group = 'whole' } = c.req.query();
    if (!GROUPS.includes(group)) return c.json({ error: `group must be one of ${GROUPS.join(', ')}` }, 400);
    if (!(await requireEvent(db, eventId))) return c.json({ error: 'Choose an event' }, 400);
    if (!(await checkPerformance(db, eventId, performanceId))) return c.json({ error: 'Performance not found for this event' }, 404);

    const data = await loadBookings(db, { eventId, performanceId: performanceId || undefined });
    return c.json({ scope: { eventId, performanceId: performanceId || null }, ...salesOverTime(data, group) });
  });

  r.get('/compare', async (c) => {
    const db = c.get('db');
    const { eventId, performanceId, compareEventId, group = 'whole', cutoff, average } = c.req.query();
    if (!COMPARE_GROUPS.includes(group)) return c.json({ error: `group must be one of ${COMPARE_GROUPS.join(', ')}` }, 400);
    if (!(await requireEvent(db, eventId))) return c.json({ error: 'Choose an event' }, 400);
    if (!(await requireEvent(db, compareEventId))) return c.json({ error: 'Choose an event to compare with' }, 400);
    if (compareEventId === eventId) return c.json({ error: 'Choose a different event to compare with' }, 400);
    if (!(await checkPerformance(db, eventId, performanceId))) return c.json({ error: 'Performance not found for this event' }, 404);

    let cut = null;
    if (cutoff !== undefined && cutoff !== '') {
      cut = Number(cutoff);
      if (!Number.isInteger(cut) || cut < 0) return c.json({ error: 'Sales to date must be a whole number of days, 0 or more' }, 400);
    }

    const includeAverage = average === '1' || average === 'true';
    const selected = await loadBookings(db, { eventId, performanceId: performanceId || undefined });
    const comparison = await loadBookings(db, { eventId: compareEventId });

    let others = [];
    if (includeAverage) {
      const { events } = await loadScopeOptions(db);
      others = [];
      for (const e of events.filter((x) => x.bookings > 0)) {
        others.push({ id: e.id, name: e.name, data: await loadBookings(db, { eventId: e.id }) });
      }
    }

    const names = {
      selected: (await requireEvent(db, eventId)).name,
      comparison: (await requireEvent(db, compareEventId)).name,
    };
    return c.json({ scope: { eventId, performanceId: performanceId || null, compareEventId }, names, ...compareEvents({ selected, comparison, others, group, cutoff: cut, includeAverage }) });
  });

  // Discount codes: scope=event (needs eventId) or scope=years (all events, grouped by performance year).
  r.get('/discounts', async (c) => {
    const db = c.get('db');
    const { scope = 'event', eventId, performanceId } = c.req.query();
    if (!['event', 'years'].includes(scope)) return c.json({ error: 'scope must be event or years' }, 400);

    let filter = {};
    if (scope === 'event') {
      if (!(await requireEvent(db, eventId))) return c.json({ error: 'Choose an event' }, 400);
      if (!(await checkPerformance(db, eventId, performanceId))) return c.json({ error: 'Performance not found for this event' }, 404);
      filter = { eventId, performanceId: performanceId || undefined };
    }
    const result = summariseDiscounts(await loadCodeLines(db, filter));
    return c.json({ scope: { scope, eventId: filter.eventId || null, performanceId: filter.performanceId || null }, ...result });
  });

  return r;
}
