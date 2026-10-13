/**
 * TicketSource events & dates, cached in D1 so listing them costs no API calls within the TTL.
 *
 * TicketSource has no "settled" flag in its API, so state is derived:
 *   archived  - the event is archived in TicketSource
 *   settled   - not archived and every performance ended more than `settlementDays` ago
 *   unsettled - everything else (upcoming, in progress, or recently finished)
 * An admin can pin an event to settled/unsettled (ts_events.state_override).
 */

const DAY_MS = 86_400_000;

function bool(v) {
  return v ? 1 : 0;
}

export function eventState(event, dates, settlementDays, now = Date.now()) {
  if (event.archived) return 'archived';
  if (event.state_override) return event.state_override;
  if (!dates || dates.length === 0) return 'unsettled';

  const lastEnd = Math.max(
    ...dates.map((d) => Date.parse(d.ends_at || d.starts_at || '') || Number.POSITIVE_INFINITY)
  );
  return Number.isFinite(lastEnd) && now > lastEnd + settlementDays * DAY_MS ? 'settled' : 'unsettled';
}

/** Upserts the events list. One API call per 100 events; skipped while the cache is fresh. */
async function refreshEventList(db, client, { force, ttlMs, now }) {
  const newest = await db.prepare('SELECT MAX(fetched_at) AS t FROM ts_events').get();
  if (!force && newest?.t && now - newest.t < ttlMs) return false;

  const events = await client.list('/events');
  const stmts = events.map((e) => {
    const a = e.attributes || {};
    return db
      .prepare(
        `INSERT INTO ts_events (id, name, reference, activated, archived, is_public, ts_created_at, ts_updated_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, reference = excluded.reference, activated = excluded.activated,
           archived = excluded.archived, is_public = excluded.is_public, ts_created_at = excluded.ts_created_at,
           ts_updated_at = excluded.ts_updated_at, fetched_at = excluded.fetched_at`
      )
      .bind(e.id, a.name ?? null, a.reference ?? null, bool(a.activated), bool(a.archived), bool(a.public), a.created_at ?? null, a.updated_at ?? null, now);
  });
  if (stmts.length) await db.batch(stmts);
  return true;
}

/** Fetches and upserts the performance dates of one event, mirroring each as a row in `events`. */
export async function refreshDates(db, client, tsEvent, now = Date.now()) {
  const dates = await client.list(`/events/${tsEvent.id}/dates`);
  const stmts = [];
  for (const d of dates) {
    const a = d.attributes || {};
    const starts = a.start ?? null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO ts_dates (id, event_id, starts_at, ends_at, doors_open, cancelled, ts_updated_at, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET event_id = excluded.event_id, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
             doors_open = excluded.doors_open, cancelled = excluded.cancelled, ts_updated_at = excluded.ts_updated_at,
             fetched_at = excluded.fetched_at`
        )
        .bind(d.id, tsEvent.id, starts, a.end ?? null, a.doors_open ?? null, bool(a.cancelled), a.updated_at ?? null, now),
      // Each performance date is an "event" in the rest of the app (bookings, check-in, reports)
      db
        .prepare(
          `INSERT INTO events (id, name, venue, event_date, gates_open, capacity, status, ts_event_id, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, 0, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, event_date = excluded.event_date, gates_open = excluded.gates_open,
             status = CASE WHEN excluded.status = 'cancelled' THEN 'cancelled' WHEN events.status = 'cancelled' THEN 'active' ELSE events.status END,
             ts_event_id = excluded.ts_event_id, updated_at = excluded.updated_at`
        )
        .bind(d.id, tsEvent.name || 'TicketSource event', starts || a.created_at || new Date(now).toISOString(), a.doors_open ?? null, a.cancelled ? 'cancelled' : 'active', tsEvent.id, new Date(now).toISOString(), new Date(now).toISOString())
    );
  }
  stmts.push(db.prepare('UPDATE ts_events SET dates_fetched_at = ? WHERE id = ?').bind(now, tsEvent.id));
  await db.batch(stmts);
  return dates.length;
}

/**
 * Refreshes the cached events list and the dates of every non-archived event (needed to derive
 * settled/unsettled). Archived events' dates are fetched lazily when you sync them.
 * Throws StepLimit when the call budget runs out; progress is already saved, so just call again.
 */
export async function refreshEvents(db, client, { force = false, ttlMs, now = Date.now() }) {
  await refreshEventList(db, client, { force, ttlMs, now });

  const stale = await db
    .prepare(
      `SELECT * FROM ts_events WHERE archived = 0 AND (dates_fetched_at IS NULL OR dates_fetched_at < ?)
       ORDER BY name`
    )
    .all(force ? now + 1 : now - ttlMs);
  for (const ev of stale) await refreshDates(db, client, ev, now);
}

export async function listEventSummaries(db, { settlementDays, now = Date.now(), state } = {}) {
  const events = await db.prepare('SELECT * FROM ts_events ORDER BY name COLLATE NOCASE').all();
  const dates = await db.prepare('SELECT * FROM ts_dates ORDER BY starts_at').all();
  const counts = await db
    .prepare(
      `SELECT d.event_id AS event_id, COUNT(b.id) AS bookings
       FROM ts_dates d LEFT JOIN bookings b ON b.event_id = d.id AND b.ts_booking_id IS NOT NULL
       GROUP BY d.event_id`
    )
    .all();
  const bookingCount = new Map(counts.map((c) => [c.event_id, c.bookings]));

  const byEvent = new Map();
  for (const d of dates) {
    if (!byEvent.has(d.event_id)) byEvent.set(d.event_id, []);
    byEvent.get(d.event_id).push(d);
  }

  const out = events.map((e) => {
    const ds = byEvent.get(e.id) || [];
    const synced = ds.map((d) => d.last_synced_at).filter(Boolean).sort();
    return {
      id: e.id,
      name: e.name,
      reference: e.reference,
      state: eventState(e, ds, settlementDays, now),
      state_pinned: e.state_override || null,
      archived: Boolean(e.archived),
      dates: ds.map((d) => ({
        id: d.id,
        starts_at: d.starts_at,
        ends_at: d.ends_at,
        cancelled: Boolean(d.cancelled),
        checkpoint: d.checkpoint,
        last_synced_at: d.last_synced_at,
        scan_state: d.scan_state,
      })),
      dates_known: e.dates_fetched_at !== null || ds.length > 0,
      first_date: ds[0]?.starts_at || null,
      bookings_imported: bookingCount.get(e.id) || 0,
      last_synced_at: synced.length === ds.length && ds.length > 0 ? synced[0] : null,
      sync_in_progress: ds.some((d) => d.scan_state === 'scanning'),
    };
  });

  return state ? out.filter((e) => e.state === state) : out;
}
