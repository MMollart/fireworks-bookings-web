/**
 * Discount-code usage, from locally stored financial lines.
 *
 *  - Rows are grouped by the YEAR OF THE BOOKING'S PERFORMANCE (Europe/London), code, and currency.
 *  - A "use" is a distinct booking, not a ticket or a line. A booking cancelled later still counts as a use.
 *  - Automatic discounts are ignored; only code discounts are considered.
 *  - Equivalent codes are merged: case-insensitive, diacritic-insensitive, whitespace trimmed and collapsed.
 *  - Amounts are summed as supplied, including signed refund adjustments. A missing amount is UNKNOWN (never 0).
 *  - A code that only appears on refund (reversal) lines of a booking is flagged, not counted as a redemption.
 */
import { londonDay, dayYear } from './time.js';
import { round2 } from './data.js';

export function normaliseCode(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const tidy = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim();
const UNNAMED = '(unnamed code)';

export async function loadCodeLines(db, scope = {}) {
  const where = ['b.ts_booking_id IS NOT NULL', 'x.has_code = 1'];
  const params = [];
  if (scope.eventId) { where.push('d.event_id = ?'); params.push(scope.eventId); }
  if (scope.performanceId) { where.push('d.id = ?'); params.push(scope.performanceId); }

  const lines = await db
    .prepare(
      `SELECT x.booking_id, x.is_refund, x.discount_code_description AS code, x.code_amount AS amount, x.currency,
              d.starts_at, d.event_id
       FROM booking_transactions x
       JOIN bookings b ON b.id = x.booking_id
       JOIN ts_dates d ON d.id = b.event_id
       WHERE ${where.join(' AND ')}`
    )
    .all(...params);

  // Is there anything at all downloaded for this scope? (distinguishes "no codes used" from "nothing downloaded")
  const w2 = ['b.ts_booking_id IS NOT NULL'];
  const p2 = [];
  if (scope.eventId) { w2.push('d.event_id = ?'); p2.push(scope.eventId); }
  if (scope.performanceId) { w2.push('d.id = ?'); p2.push(scope.performanceId); }
  const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM bookings b JOIN ts_dates d ON d.id = b.event_id WHERE ${w2.join(' AND ')}`).get(...p2);
  const incomplete = await db
    .prepare(`SELECT COUNT(*) AS n FROM ts_dates d WHERE ${scope.eventId ? 'd.event_id = ?' : '1=1'} ${scope.performanceId ? 'AND d.id = ?' : ''} AND (d.last_synced_at IS NULL OR d.scan_state = 'scanning')`)
    .get(...[scope.eventId, scope.performanceId].filter(Boolean));

  return { lines, bookingsInScope: n, incompletePerformances: incomplete.n };
}

export function summariseDiscounts({ lines, bookingsInScope, incompletePerformances }) {
  const groups = new Map();

  for (const l of lines) {
    const day = londonDay(l.starts_at);
    const year = day === null ? null : dayYear(day);
    const norm = normaliseCode(l.code) || normaliseCode(UNNAMED);
    const key = `${year}|${norm}|${l.currency}`;
    if (!groups.has(key)) {
      groups.set(key, { year, norm, currency: l.currency, labels: new Map(), bookings: new Map(), amount: 0, knownAmounts: 0, unknownLines: 0 });
    }
    const g = groups.get(key);
    const label = tidy(l.code) || UNNAMED;
    g.labels.set(label, (g.labels.get(label) ?? 0) + 1);

    if (!g.bookings.has(l.booking_id)) g.bookings.set(l.booking_id, { redeemed: false, unknown: false, refunds: 0 });
    const b = g.bookings.get(l.booking_id);
    if (l.is_refund) b.refunds++;
    else b.redeemed = true;

    if (l.amount === null || l.amount === undefined) {
      g.unknownLines++;
      b.unknown = true;
    } else {
      g.amount += l.amount; // as supplied, signed
      g.knownAmounts++;
    }
  }

  const rows = [...groups.values()].map((g) => {
    const label = [...g.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    let uses = 0;
    let reversalOnly = 0;
    let unknownBookings = 0;
    let withRefundLines = 0;
    for (const b of g.bookings.values()) {
      if (b.redeemed) uses++;
      else reversalOnly++;
      if (b.unknown) unknownBookings++;
      if (b.refunds) withRefundLines++;
    }
    const notes = [];
    if (reversalOnly) notes.push(`${reversalOnly} booking${reversalOnly === 1 ? '' : 's'} with this code only on reversal lines: flagged, not counted as a use`);
    if (unknownBookings) notes.push(`Amount not supplied for ${unknownBookings} booking${unknownBookings === 1 ? '' : 's'}: unknown, not counted as zero`);
    if (withRefundLines) notes.push(`Includes signed refund adjustments on ${withRefundLines} booking${withRefundLines === 1 ? '' : 's'}`);
    if (g.labels.size > 1) notes.push(`Merged spellings: ${[...g.labels.keys()].sort().join(', ')}`);

    return {
      year: g.year,
      yearLabel: g.year === null ? 'Unknown year' : String(g.year),
      code: label,
      currency: g.currency,
      uses,
      reversalOnly,
      total: g.knownAmounts > 0 ? round2(g.amount) : null, // null = Unknown
      unknownAmounts: unknownBookings,
      notes,
    };
  });

  rows.sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || a.code.localeCompare(b.code) || a.currency.localeCompare(b.currency));

  return {
    rows,
    bookingsInScope,
    incompletePerformances,
    state: bookingsInScope === 0 ? 'no_bookings' : rows.length === 0 ? 'empty' : 'ok',
  };
}
