import { eventLabel } from '../lib/eventName.js';

/** Loads bookings, seats (tickets) and financial lines from the local database for a scope. */

const NET_SIGN = 'CASE WHEN x.is_refund = 1 THEN -ABS(x.%) ELSE x.% END';
const signed = (col) => NET_SIGN.replaceAll('%', col);

function scopeSql(scope, alias = 'd') {
  const where = ['b.ts_booking_id IS NOT NULL'];
  const params = [];
  if (scope.eventId) {
    where.push(`${alias}.event_id = ?`);
    params.push(scope.eventId);
  }
  if (scope.performanceId) {
    where.push(`${alias}.id = ?`);
    params.push(scope.performanceId);
  }
  return { where: where.join(' AND '), params };
}

/** A TicketSource event's id and display name (with its year), or null. */
export async function loadEventName(db, id) {
  const e = await db.prepare('SELECT id, name FROM ts_events WHERE id = ?').get(id);
  if (!e) return null;
  const first = await db.prepare('SELECT MIN(starts_at) AS s FROM ts_dates WHERE event_id = ?').get(id);
  return { id: e.id, name: eventLabel(e.name, first?.s) };
}

/** Events that have downloaded bookings, with their performances and download completeness. */
export async function loadScopeOptions(db) {
  const events = await db
    .prepare(
      `SELECT e.id, e.name, e.archived, e.settled, e.state_override,
              (SELECT COUNT(*) FROM bookings b JOIN ts_dates d ON d.id = b.event_id WHERE d.event_id = e.id AND b.ts_booking_id IS NOT NULL) AS bookings
       FROM ts_events e ORDER BY e.name COLLATE NOCASE`
    )
    .all();
  const dates = await db.prepare('SELECT id, event_id, starts_at, last_synced_at, scan_state, cancelled FROM ts_dates ORDER BY starts_at').all();
  const firstStart = new Map();
  for (const d of dates) if (d.starts_at && !firstStart.has(d.event_id)) firstStart.set(d.event_id, d.starts_at);
  const named = events.map((e) => ({ ...e, name: eventLabel(e.name, firstStart.get(e.id)), first_start: firstStart.get(e.id) || '' }));
  named.sort((a, b) => b.first_start.localeCompare(a.first_start) || a.name.localeCompare(b.name)); // newest event first
  return { events: named, dates };
}

export function isComplete(perf) {
  return Boolean(perf.last_synced_at) && perf.scan_state !== 'scanning';
}

/**
 * Bookings in scope, each with: created (TicketSource creation date or null), status, performance, active ticket count,
 * and money per currency (gross/net as signed sums over financial lines; refund lines subtract).
 */
export async function loadBookings(db, scope = {}) {
  const { where, params } = scopeSql(scope);

  const perfWhere = ['1 = 1'];
  const perfParams = [];
  if (scope.eventId) { perfWhere.push('d.event_id = ?'); perfParams.push(scope.eventId); }
  if (scope.performanceId) { perfWhere.push('d.id = ?'); perfParams.push(scope.performanceId); }
  const perfs = await db
    .prepare(`SELECT d.id, d.event_id, d.starts_at, d.last_synced_at, d.scan_state FROM ts_dates d WHERE ${perfWhere.join(' AND ')} ORDER BY d.starts_at`)
    .all(...perfParams);

  const rows = await db
    .prepare(
      `SELECT b.id, b.ts_created_at AS created, b.status, d.id AS perf_id, d.event_id AS event_id,
              (SELECT COUNT(*) FROM tickets t WHERE t.booking_id = b.id) AS tickets
       FROM bookings b JOIN ts_dates d ON d.id = b.event_id WHERE ${where}`
    )
    .all(...params);

  const money = await db
    .prepare(
      `SELECT x.booking_id, x.currency,
              SUM(CASE WHEN x.line_type = 'DONATION' THEN 0 ELSE ${signed('gross')} END) AS gross,
              SUM(CASE WHEN x.line_type = 'DONATION' THEN 0 ELSE ${signed('net')} END) AS net,
              SUM(CASE WHEN x.line_type = 'DONATION' THEN ${signed('gross')} ELSE 0 END) AS donations
       FROM booking_transactions x JOIN bookings b ON b.id = x.booking_id JOIN ts_dates d ON d.id = b.event_id
       WHERE ${where} GROUP BY x.booking_id, x.currency`
    )
    .all(...params);

  const byBooking = new Map();
  for (const m of money) {
    if (!byBooking.has(m.booking_id)) byBooking.set(m.booking_id, {});
    byBooking.get(m.booking_id)[m.currency] = { gross: m.gross, net: m.net, donations: m.donations };
  }

  return {
    performances: perfs,
    bookings: rows.map((r) => ({ ...r, money: byBooking.get(r.id) || {} })),
  };
}

/** Every event's bookings in one load (three queries in total, not three per event): Map eventId -> { performances, bookings }.
 *  Only events with at least one downloaded booking are included. */
export async function loadBookingsByEvent(db) {
  const all = await loadBookings(db);
  const byEvent = new Map();
  const entry = (id) => {
    if (!byEvent.has(id)) byEvent.set(id, { performances: [], bookings: [] });
    return byEvent.get(id);
  };
  for (const b of all.bookings) entry(b.event_id).bookings.push(b);
  for (const p of all.performances) if (byEvent.has(p.event_id)) byEvent.get(p.event_id).performances.push(p);
  return byEvent;
}

export function addMoney(target, money, sign = 1) {
  for (const [cur, v] of Object.entries(money)) {
    target[cur] ??= { gross: 0, net: 0, donations: 0 };
    target[cur].gross += sign * v.gross;
    target[cur].net += sign * v.net;
    target[cur].donations += sign * (v.donations || 0);
  }
}

export const round2 = (n) => Math.round(n * 100) / 100;

/** { GBP: { gross, net, donations } } -> separate { gross: {GBP}, net: {GBP}, donations: {GBP} }, rounded.
 *  Gross and net are ticket (non-donation) money; donations are reported on their own. */
export function splitMoney(m) {
  const gross = {};
  const net = {};
  const donations = {};
  for (const [cur, v] of Object.entries(m)) {
    gross[cur] = round2(v.gross);
    net[cur] = round2(v.net);
    donations[cur] = round2(v.donations || 0);
  }
  return { gross, net, donations };
}
