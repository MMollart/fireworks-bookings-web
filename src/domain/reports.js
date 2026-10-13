import { listBookings } from './bookings.js';
import { loadCategoryMap, typeKey } from './ticketTypes.js';
import { loadCodeLines, summariseDiscounts } from '../analysis/discounts.js';
import { withYear } from '../lib/eventName.js';

/** TicketSource events with performance dates, newest first, each with booking / ticket / revenue totals. */
export async function listEventTotals(db) {
  const events = await db.prepare('SELECT id, name FROM ts_events').all();
  const firsts = await db.prepare('SELECT event_id, MIN(starts_at) AS first_start FROM ts_dates GROUP BY event_id').all();
  const bookings = await db
    .prepare(
      `SELECT d.event_id AS event_id, COUNT(*) AS bookings,
              COALESCE(SUM(CASE WHEN b.status = 'confirmed' THEN b.total_price ELSE 0 END), 0) AS gross_revenue
       FROM bookings b JOIN ts_dates d ON d.id = b.event_id WHERE b.ts_booking_id IS NOT NULL GROUP BY d.event_id`
    )
    .all();
  const tickets = await db
    .prepare(
      `SELECT d.event_id AS event_id, COUNT(*) AS tickets
       FROM tickets t JOIN bookings b ON b.id = t.booking_id JOIN ts_dates d ON d.id = b.event_id
       WHERE b.status = 'confirmed' AND b.ts_booking_id IS NOT NULL GROUP BY d.event_id`
    )
    .all();
  const bMap = new Map(bookings.map((r) => [r.event_id, r]));
  const tMap = new Map(tickets.map((r) => [r.event_id, r.tickets]));
  const first = new Map(firsts.map((r) => [r.event_id, r.first_start]));

  return events
    .filter((e) => first.has(e.id))
    .map((e) => ({
      id: e.id,
      name: withYear(e.name, first.get(e.id)),
      starts_at: first.get(e.id),
      bookings: bMap.get(e.id)?.bookings || 0,
      tickets_sold: tMap.get(e.id) || 0,
      gross_revenue: bMap.get(e.id)?.gross_revenue || 0,
    }))
    .sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)));
}

/** Dashboard figures for one TicketSource event; defaults to the latest event. */
export async function getDashboardSummary(db, { eventId } = {}) {
  const events = await listEventTotals(db);
  const selected = events.find((e) => e.id === eventId) || events[0] || null;
  if (!selected) return { selectedEventId: null, events, event: null };

  const inEvent = 'b.ts_booking_id IS NOT NULL AND b.event_id IN (SELECT id FROM ts_dates WHERE event_id = ?)';
  const stats = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN b.status = 'confirmed' THEN b.total_price ELSE 0 END), 0) AS gross_revenue,
         COALESCE(SUM(CASE WHEN b.status = 'confirmed' THEN b.discount_amount ELSE 0 END), 0) AS total_discounts,
         COUNT(*) AS total_bookings_all,
         COALESCE(SUM(CASE WHEN b.status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed_bookings,
         COALESCE(SUM(CASE WHEN b.status = 'refunded' THEN 1 ELSE 0 END), 0) AS refunded_bookings,
         COUNT(DISTINCT b.customer_id) AS customers
       FROM bookings b WHERE ${inEvent}`
    )
    .get(selected.id);

  const confirmed = stats.confirmed_bookings || 0;
  const aov = confirmed > 0 ? parseFloat((stats.gross_revenue / confirmed).toFixed(2)) : 0;
  const breakdown = await getTicketTypeBreakdown(db, selected.id);

  return {
    selectedEventId: selected.id,
    event: { id: selected.id, name: selected.name, starts_at: selected.starts_at },
    events,
    financials: {
      gross_revenue: stats.gross_revenue,
      total_discounts: stats.total_discounts,
      net_revenue: parseFloat((stats.gross_revenue - stats.total_discounts).toFixed(2)),
      confirmed_bookings: confirmed,
      aov,
    },
    bookings: { total: stats.total_bookings_all || 0, confirmed, refunded: stats.refunded_bookings || 0 },
    tickets: { tickets_sold: selected.tickets_sold, breakdown },
    customers: { total: stats.customers || 0 },
    recentBookings: await listBookings(db, { tsEventId: selected.id, limit: 5 }),
  };
}

export async function getDailySalesVelocity(db, options = {}) {
  let sql = `
    SELECT 
      SUBSTR(b.booking_date, 1, 10) AS date,
      COUNT(DISTINCT b.id) AS bookings_count,
      COUNT(t.id) AS tickets_sold,
      COALESCE(SUM(b.total_price), 0) AS revenue
    FROM bookings b
    LEFT JOIN tickets t ON b.id = t.booking_id
    WHERE b.status = 'confirmed'
  `;
  const params = [];

  if (options.eventId) {
    sql += ' AND b.event_id = ?';
    params.push(options.eventId);
  }

  sql += ' GROUP BY SUBSTR(b.booking_date, 1, 10) ORDER BY date ASC';

  if (options.days) {
    const daysLimit = parseInt(options.days, 10);
    sql += ` LIMIT ${Number.isFinite(daysLimit) && daysLimit > 0 ? daysLimit : 365}`;
  }

  return await db.prepare(sql).all(...params);
}

/** Discount-code usage from the downloaded transaction lines (the same figures as the Discount Codes tab). */
export async function getDiscountCodeReport(db, { eventId } = {}) {
  return summariseDiscounts(await loadCodeLines(db, eventId ? { eventId } : {}));
}

/**
 * Tickets by category, using the ticket type dictionary (Admin > Ticket types). A type with no dictionary entry is shown
 * under its own name, flagged `unmapped`. `eventId` is a TicketSource event id; omit for all events.
 */
export async function getTicketTypeBreakdown(db, eventId = null) {
  let sql = `
    SELECT t.ticket_type, COUNT(t.id) AS count, COALESCE(SUM(t.price), 0) AS total_revenue
    FROM tickets t
    JOIN bookings b ON t.booking_id = b.id
    WHERE b.status = 'confirmed' AND b.ts_booking_id IS NOT NULL`;
  const params = [];
  if (eventId && eventId !== 'all') {
    sql += ' AND b.event_id IN (SELECT id FROM ts_dates WHERE event_id = ?)';
    params.push(eventId);
  }
  sql += ' GROUP BY t.ticket_type';

  const map = await loadCategoryMap(db);
  const groups = new Map();
  for (const r of await db.prepare(sql).all(...params)) {
    const category = map.get(typeKey(r.ticket_type));
    const label = category ?? String(r.ticket_type).replace(/\s+/g, ' ').trim();
    const g = groups.get(label) || { ticket_type: label, unmapped: category === undefined, count: 0, total_revenue: 0, types: new Set() };
    g.count += r.count;
    g.total_revenue += r.total_revenue;
    g.types.add(String(r.ticket_type).replace(/\s+/g, ' ').trim());
    groups.set(label, g);
  }
  return [...groups.values()]
    .map((g) => ({ ticket_type: g.ticket_type, unmapped: g.unmapped, count: g.count, total_revenue: Math.round(g.total_revenue * 100) / 100, types: [...g.types].sort() }))
    .sort((a, b) => b.count - a.count || a.ticket_type.localeCompare(b.ticket_type));
}

export async function exportBookingsCsv(db, options = {}) {
  const bookings = await listBookings(db, {
    tsEventId: options.eventId && options.eventId !== 'all' ? options.eventId : undefined,
    status: options.status,
    limit: 100000,
    noCap: true,
  });

  const headers = [
    'Booking Reference',
    'Event',
    'Booking Date',
    'Status',
    'Customer Name',
    'Customer Email',
    'Customer Phone',
    'Customer Postcode',
    'Tickets Count',
    'Subtotal',
    'Discount Code',
    'Discount Amount',
    'Total Price',
    'Payment Method',
  ];

  function escapeCsv(value) {
    if (value === null || value === undefined) return '';
    let str = String(value);
    // Neutralise spreadsheet formula injection from user-supplied text.
    if (/^[=+\-@\t\r]/.test(str) && Number.isNaN(Number(str))) str = `'${str}`;
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const rows = [headers.join(',')];
  for (const b of bookings) {
    rows.push(
      [
        escapeCsv(b.reference),
        escapeCsv(b.event_name),
        escapeCsv(b.booking_date),
        escapeCsv(b.status),
        escapeCsv(b.customer_name),
        escapeCsv(b.customer_email),
        escapeCsv(b.customer_phone),
        escapeCsv(b.customer_postcode),
        escapeCsv(b.ticket_count),
        escapeCsv(b.subtotal.toFixed(2)),
        escapeCsv(b.discount_code || ''),
        escapeCsv(b.discount_amount.toFixed(2)),
        escapeCsv(b.total_price.toFixed(2)),
        escapeCsv(b.payment_method || ''),
      ].join(',')
    );
  }

  return rows.join('\r\n');
}

export async function exportTransactionsCsv(db, options = {}) {
  let sql = `
    SELECT b.reference, e.name AS event_name, b.booking_date, t.line_index, t.line_type, t.payment_method, t.is_refund,
           t.gross, t.fee, t.fee_vat, t.net, t.discount_automatic, t.discount_code_description, t.discount_code_amount,
           t.created_at
    FROM booking_transactions t
    JOIN bookings b ON t.booking_id = b.id
    JOIN events e ON b.event_id = e.id`;
  const params = [];
  if (options.eventId && options.eventId !== 'all') {
    sql += ' WHERE b.event_id IN (SELECT id FROM ts_dates WHERE event_id = ?)';
    params.push(options.eventId);
  }
  sql += ' ORDER BY b.booking_date, b.reference, t.line_index';
  const rows = await db.prepare(sql).all(...params);

  const headers = ['Booking Reference', 'Event', 'Booking Date', 'Line', 'Type', 'Payment Method', 'Refund', 'Gross', 'Fee', 'Fee VAT', 'Net', 'Automatic Discount', 'Discount Code', 'Discount Code Amount', 'Created'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let str = String(v);
    if (/^[=+\-@\t\r]/.test(str) && Number.isNaN(Number(str))) str = `'${str}`;
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [r.reference, r.event_name, r.booking_date, r.line_index, r.line_type, r.payment_method, r.is_refund ? 'yes' : 'no',
       r.gross, r.fee, r.fee_vat, r.net, r.discount_automatic, r.discount_code_description, r.discount_code_amount, r.created_at]
        .map(esc)
        .join(',')
    );
  }
  return lines.join('\r\n');
}

export default {
  getDashboardSummary,
  getDailySalesVelocity,
  getDiscountCodeReport,
  getTicketTypeBreakdown,
  exportBookingsCsv,
  exportTransactionsCsv,
};
