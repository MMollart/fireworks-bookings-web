import { Hono } from 'hono';
import { config } from '../config.js';
import { loadScopeOptions, loadBookings, loadBookingsByEvent, isComplete, loadEventName } from '../analysis/data.js';
import { salesOverTime, GROUPS } from '../analysis/sales.js';
import { compareEvents, COMPARE_GROUPS } from '../analysis/compare.js';
import { loadCodeLines, summariseDiscounts } from '../analysis/discounts.js';
import { yearlyTotals } from '../analysis/years.js';
import { eventState } from '../ticketsource/events.js';

async function requireEvent(db, id) {
  if (!id) return null;
  return loadEventName(db, id);
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
    const { eventId, group = 'whole' } = c.req.query();
    if (!GROUPS.includes(group)) return c.json({ error: `group must be one of ${GROUPS.join(', ')}` }, 400);
    if (!(await requireEvent(db, eventId))) return c.json({ error: 'Choose an event' }, 400);

    const data = await loadBookings(db, { eventId });
    return c.json({ scope: { eventId }, ...salesOverTime(data, group) });
  });

  // compareEventId = 'average' compares with the average across all events with downloaded bookings.
  r.get('/compare', async (c) => {
    const db = c.get('db');
    const { eventId, compareEventId, group = 'whole', cutoff, average } = c.req.query();
    const versusAverage = compareEventId === 'average';
    if (!COMPARE_GROUPS.includes(group)) return c.json({ error: `group must be one of ${COMPARE_GROUPS.join(', ')}` }, 400);
    const selectedEvent = await requireEvent(db, eventId);
    if (!selectedEvent) return c.json({ error: 'Choose an event' }, 400);
    const comparisonEvent = versusAverage ? null : await requireEvent(db, compareEventId);
    if (!versusAverage && !comparisonEvent) return c.json({ error: 'Choose an event to compare with' }, 400);
    if (compareEventId === eventId) return c.json({ error: 'Choose a different event to compare with' }, 400);

    let cut = null;
    if (cutoff !== undefined && cutoff !== '') {
      cut = Number(cutoff);
      if (!Number.isInteger(cut) || cut < 0) return c.json({ error: 'Sales to date must be a whole number of days, 0 or more' }, 400);
    }

    const includeAverage = versusAverage || average === '1' || average === 'true';
    let selected, comparison;
    let others = [];
    if (includeAverage) {
      // one load for every event, rather than three queries per event
      const byEvent = await loadBookingsByEvent(db);
      selected = byEvent.get(eventId) || (await loadBookings(db, { eventId }));
      comparison = versusAverage ? 'average' : byEvent.get(compareEventId) || (await loadBookings(db, { eventId: compareEventId }));
      others = [...byEvent].map(([id, data]) => ({ id, data }));
    } else {
      selected = await loadBookings(db, { eventId });
      comparison = await loadBookings(db, { eventId: compareEventId });
    }

    const result = compareEvents({ selected, comparison, others, group, cutoff: cut, includeAverage });
    const names = {
      selected: selectedEvent.name,
      comparison: versusAverage ? `Average of ${result.averageEvents} events` : comparisonEvent.name,
    };
    return c.json({ scope: { eventId, compareEventId }, names, ...result });
  });

  // All events side by side by year. mode = all | equivalent (sales up to the same point in the sales cycle as `eventId` is at today).
  r.get('/years', async (c) => {
    const db = c.get('db');
    const { eventId, mode = 'all' } = c.req.query();
    if (!['all', 'equivalent'].includes(mode)) return c.json({ error: 'mode must be all or equivalent' }, 400);
    if (!(await requireEvent(db, eventId))) return c.json({ error: 'Choose an event' }, 400);

    const { events } = await loadScopeOptions(db);
    const list = [];
    for (const e of events.filter((x) => x.bookings > 0 || x.id === eventId)) {
      list.push({ id: e.id, label: e.name, firstStart: e.first_start, data: await loadBookings(db, { eventId: e.id }) });
    }
    return c.json({ scope: { eventId }, ...yearlyTotals({ events: list, selectedId: eventId, mode }) });
  });

  // Discount codes: scope=event (needs eventId) or scope=years (all events, grouped by performance year).
  r.get('/discounts', async (c) => {
    const db = c.get('db');
    const { scope = 'event', eventId } = c.req.query();
    if (!['event', 'years'].includes(scope)) return c.json({ error: 'scope must be event or years' }, 400);

    let filter = {};
    if (scope === 'event') {
      if (!(await requireEvent(db, eventId))) return c.json({ error: 'Choose an event' }, 400);
      filter = { eventId };
    }
    const result = summariseDiscounts(await loadCodeLines(db, filter));
    return c.json({ scope: { scope, eventId: filter.eventId || null }, ...result });
  });

  return r;
}
