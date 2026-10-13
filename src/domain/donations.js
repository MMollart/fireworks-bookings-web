/**
 * Donations: booking lines of type DONATION (TicketSource booking schema, `lines[].line_type`; `donation.gift_aid`
 * flags Gift Aid). Refund lines subtract. Donations are reported on their own, never as ticket revenue.
 */
import { decrypt } from '../crypto/encryption.js';
import { eventLabel } from '../lib/eventName.js';

const SIGNED = 'CASE WHEN x.is_refund = 1 THEN -ABS(x.gross) ELSE x.gross END';

/** Totals per event year, newest first. eventId (a TicketSource event id) narrows to one event. */
export async function donationTotals(db, { eventId } = {}) {
  const rows = await db
    .prepare(
      `SELECT d.event_id AS event_id, MIN(d.starts_at) AS starts_at,
              COUNT(DISTINCT x.booking_id) AS bookings,
              COALESCE(SUM(${SIGNED}), 0) AS total,
              COUNT(DISTINCT CASE WHEN x.gift_aid = 1 THEN x.booking_id END) AS gift_aid_bookings,
              COALESCE(SUM(CASE WHEN x.gift_aid = 1 THEN ${SIGNED} ELSE 0 END), 0) AS gift_aid_total
       FROM booking_transactions x
       JOIN bookings b ON b.id = x.booking_id
       JOIN ts_dates d ON d.id = b.event_id
       WHERE x.line_type = 'DONATION' AND b.ts_booking_id IS NOT NULL ${eventId ? 'AND d.event_id = ?' : ''}
       GROUP BY d.event_id`
    )
    .all(...(eventId ? [eventId] : []));
  const round = (n) => Math.round(n * 100) / 100;
  return rows
    .map((r) => ({ ...r, label: eventLabel(null, r.starts_at), total: round(r.total), gift_aid_total: round(r.gift_aid_total) }))
    .sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)));
}

/** The individual donations (newest first), with the donor's name decrypted. */
export async function listDonations(db, { eventId, limit = 200 } = {}) {
  const rows = await db
    .prepare(
      `SELECT b.id AS booking_id, b.reference, b.booking_date, x.is_refund, x.gift_aid, ${SIGNED} AS amount, x.currency,
              c.name_encrypted, d.starts_at
       FROM booking_transactions x
       JOIN bookings b ON b.id = x.booking_id
       JOIN ts_dates d ON d.id = b.event_id
       JOIN customers c ON c.id = b.customer_id
       WHERE x.line_type = 'DONATION' AND b.ts_booking_id IS NOT NULL ${eventId ? 'AND d.event_id = ?' : ''}
       ORDER BY b.booking_date DESC, b.id
       LIMIT ?`
    )
    .all(...(eventId ? [eventId] : []), limit);
  return Promise.all(
    rows.map(async (r) => ({
      booking_id: r.booking_id,
      reference: r.reference,
      booking_date: r.booking_date,
      event: eventLabel(null, r.starts_at),
      customer_name: await decrypt(r.name_encrypted),
      amount: r.amount,
      currency: r.currency,
      gift_aid: r.gift_aid === null || r.gift_aid === undefined ? null : Boolean(r.gift_aid),
      is_refund: Boolean(r.is_refund),
    }))
  );
}
