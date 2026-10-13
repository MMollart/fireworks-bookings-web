import { matchingCustomerIds } from './customers.js';
import { decrypt } from '../crypto/encryption.js';

export async function getBookingById(db, id) {
  const row = await db.prepare(`
    SELECT 
      b.*,
      e.name AS event_name, e.event_date, e.venue AS event_venue,
      d.code AS discount_code, d.discount_type,
      c.name_encrypted, c.email_encrypted, c.phone_encrypted, c.postcode_encrypted
    FROM bookings b
    JOIN events e ON b.event_id = e.id
    JOIN customers c ON b.customer_id = c.id
    LEFT JOIN discount_codes d ON b.discount_code_id = d.id
    WHERE b.id = ?
  `).get(id);

  if (!row) return null;

  const ticketRows = await db.prepare('SELECT * FROM tickets WHERE booking_id = ? ORDER BY barcode').all(id);
  const tickets = await Promise.all(
    ticketRows.map(async ({ attendee_encrypted, ...t }) => {
      const attendee = attendee_encrypted ? JSON.parse(await decrypt(attendee_encrypted)) : null;
      return { ...t, attendee };
    })
  );
  const transactions = await db
    .prepare('SELECT * FROM booking_transactions WHERE booking_id = ? ORDER BY line_index')
    .all(id);

  return {
    id: row.id,
    reference: row.reference,
    booking_reference: row.reference,
    event_id: row.event_id,
    event_name: row.event_name,
    event_date: row.event_date,
    event_venue: row.event_venue,
    customer_id: row.customer_id,
    customer: {
      id: row.customer_id,
      name: await decrypt(row.name_encrypted),
      email: await decrypt(row.email_encrypted),
      phone: await decrypt(row.phone_encrypted),
      postcode: await decrypt(row.postcode_encrypted),
    },
    booking_date: row.booking_date,
    status: row.status,
    subtotal: row.subtotal,
    subtotal_amount: row.subtotal,
    discount_code: row.discount_code,
    discount_amount: row.discount_amount,
    total_price: row.total_price,
    total_amount: row.total_price,
    payment_method: row.payment_method,
    payment_reference: row.payment_reference,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tickets,
    transactions,
  };
}

const LIST_SELECT = `
  SELECT b.*, e.name AS event_name,
         c.name_encrypted, c.email_encrypted, c.phone_encrypted, c.postcode_encrypted,
         d.code AS discount_code,
         (SELECT COUNT(*) FROM tickets t WHERE t.booking_id = b.id) AS ticket_count
  FROM bookings b
  JOIN events e ON b.event_id = e.id
  JOIN customers c ON b.customer_id = c.id
  LEFT JOIN discount_codes d ON b.discount_code_id = d.id`;

const IDS_PER_QUERY = 90; // D1 allows at most 100 bound parameters per statement

async function toBooking(row) {
  return {
    id: row.id,
    reference: row.reference,
    event_id: row.event_id,
    event_name: row.event_name,
    customer_id: row.customer_id,
    customer_name: await decrypt(row.name_encrypted),
    customer_email: await decrypt(row.email_encrypted),
    customer_phone: await decrypt(row.phone_encrypted),
    customer_postcode: await decrypt(row.postcode_encrypted),
    booking_date: row.booking_date,
    status: row.status,
    subtotal: row.subtotal,
    discount_code: row.discount_code,
    discount_amount: row.discount_amount,
    total_price: row.total_price,
    payment_method: row.payment_method,
    ticket_count: row.ticket_count,
    created_at: row.created_at,
  };
}

export async function listBookings(db, options = {}) {
  const where = [];
  const params = [];

  if (options.eventId) {
    where.push('b.event_id = ?');
    params.push(options.eventId);
  }
  if (options.tsEventId) {
    where.push('b.event_id IN (SELECT id FROM ts_dates WHERE event_id = ?)');
    params.push(options.tsEventId);
  }
  if (options.customerId) {
    where.push('b.customer_id = ?');
    params.push(options.customerId);
  }
  if (options.status) {
    where.push('b.status = ?');
    params.push(options.status);
  }
  if (options.reference) {
    where.push('b.reference LIKE ?');
    params.push(`%${options.reference}%`);
  }

  const requested = options.limit ? parseInt(options.limit, 10) || 100 : 100;
  const limit = options.noCap ? requested : Math.min(500, requested);
  const offset = options.offset ? parseInt(options.offset, 10) || 0 : 0;
  const run = (extraWhere, extraParams, max, skip) =>
    db
      .prepare(`${LIST_SELECT} ${[...where, ...extraWhere].length ? `WHERE ${[...where, ...extraWhere].join(' AND ')}` : ''} ORDER BY b.booking_date DESC, b.id LIMIT ? OFFSET ?`)
      .all(...params, ...extraParams, max, skip);

  // Search: a booking reference (SQL) or a customer's name / e-mail (customer search index). Customer ids go to the
  // database in small groups, the results are merged, and only the requested page is decrypted.
  let rows;
  let tooShort = false;
  if (options.search && options.search.trim()) {
    const term = options.search.trim();
    const customerIds = await matchingCustomerIds(db, term);
    tooShort = customerIds === null;
    const found = new Map();
    const wanted = offset + limit;
    for (const r of await run(['b.reference LIKE ?'], [`%${term}%`], wanted, 0)) found.set(r.id, r);
    for (let i = 0; customerIds && i < customerIds.length; i += IDS_PER_QUERY) {
      const part = customerIds.slice(i, i + IDS_PER_QUERY);
      for (const r of await run([`b.customer_id IN (${part.map(() => '?').join(',')})`], part, wanted, 0)) found.set(r.id, r);
    }
    rows = [...found.values()]
      .sort((a, b) => String(b.booking_date).localeCompare(String(a.booking_date)) || String(a.id).localeCompare(String(b.id)))
      .slice(offset, offset + limit);
  } else {
    rows = await run([], [], limit, offset); // paging in SQL: only one page of customers is ever decrypted
  }

  return Object.assign(await Promise.all(rows.map(toBooking)), { tooShort });
}

export default {
  getBookingById,
  listBookings,
};
