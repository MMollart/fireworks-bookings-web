import { randomHex, randomInt } from '../lib/bytes.js';
import { upsertCustomer } from './customers.js';
import { getDiscountByCode, calculateDiscount, buildDiscountUsageUpdate } from './discounts.js';
import { buildTicketInsert } from './tickets.js';
import { decrypt } from '../crypto/encryption.js';

export async function createBooking(db, data) {
  const eventId = data.eventId || data.event_id;
  if (!eventId) throw new Error('Event ID is required');
  if (!data.customer || !data.customer.email) throw new Error('Customer information with valid email is required');
  if (!data.tickets || !Array.isArray(data.tickets) || data.tickets.length === 0) {
    throw new Error('At least one ticket is required for booking');
  }

  const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) throw new Error('Event not found');

  // Upsert customer (personal data encrypted at rest)
  const customer = await upsertCustomer(db, data.customer);

  let subtotal = 0;
  for (const t of data.tickets) subtotal += parseFloat(t.price || 0);

  let discountCodeId = null;
  let discountAmount = 0;
  const rawDiscountCode = data.discountCode || data.discount_code;
  if (rawDiscountCode) {
    const discount = await getDiscountByCode(db, rawDiscountCode);
    if (discount && discount.is_active) {
      discountCodeId = discount.id;
      discountAmount = calculateDiscount(discount, subtotal).discountAmount;
    }
  }

  const totalPrice = Math.max(0, parseFloat((subtotal - discountAmount).toFixed(2)));
  const bookingId = data.id || `bk_${randomHex(6)}`;
  const reference = data.reference || data.booking_reference || `FB-${randomInt(100000, 1000000)}`;
  const now = new Date().toISOString();
  const bookingDate = data.bookingDate || data.booking_date || now;
  const status = data.status || 'confirmed';

  // D1 has no interactive transactions: booking, tickets and discount usage go in one atomic batch.
  const statements = [
    db
      .prepare(
        `INSERT INTO bookings (
           id, reference, event_id, customer_id, booking_date, status,
           subtotal, discount_code_id, discount_amount, total_price,
           payment_method, payment_reference, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        bookingId, reference, eventId, customer.id, bookingDate, status,
        subtotal, discountCodeId, discountAmount, totalPrice,
        data.paymentMethod || data.payment_method || 'card',
        data.paymentReference || data.payment_reference || null,
        data.notes || null, now, now
      ),
  ];

  for (const t of data.tickets) {
    statements.push(
      buildTicketInsert(db, {
        booking_id: bookingId,
        event_id: eventId,
        ticket_type: t.ticketType || t.ticket_type || 'Standard',
        price: t.price || 0,
        barcode: t.barcode,
      }).stmt
    );
  }

  if (status === 'confirmed' && discountCodeId) {
    statements.push(buildDiscountUsageUpdate(db, discountCodeId, discountAmount, totalPrice));
  }

  await db.batch(statements);

  const result = await getBookingById(db, bookingId);
  result.booking_reference = result.reference;
  result.subtotal_amount = result.subtotal;
  result.total_amount = result.total_price;
  result.booking = {
    ...result,
    booking_reference: result.reference,
    subtotal_amount: result.subtotal,
    total_amount: result.total_price,
  };
  return result;
}

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

  const tickets = await db.prepare('SELECT * FROM tickets WHERE booking_id = ?').all(id);

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
  };
}

export async function listBookings(db, options = {}) {
  let sql = `
    SELECT 
      b.*,
      e.name AS event_name,
      c.name_encrypted, c.email_encrypted, c.phone_encrypted, c.postcode_encrypted,
      d.code AS discount_code,
      COUNT(t.id) AS ticket_count
    FROM bookings b
    JOIN events e ON b.event_id = e.id
    JOIN customers c ON b.customer_id = c.id
    LEFT JOIN discount_codes d ON b.discount_code_id = d.id
    LEFT JOIN tickets t ON b.id = t.booking_id
  `;

  const where = [];
  const params = [];

  if (options.eventId) {
    where.push('b.event_id = ?');
    params.push(options.eventId);
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

  if (where.length > 0) {
    sql += ' WHERE ' + where.join(' AND ');
  }

  sql += ' GROUP BY b.id ORDER BY b.booking_date DESC';

  const rows = await db.prepare(sql).all(...params);

  // Decrypt customer fields in-memory for authorized viewing
  let bookings = await Promise.all(rows.map(async (row) => ({
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
  })));

  if (options.search) {
    const q = options.search.toLowerCase();
    bookings = bookings.filter(
      (b) =>
        b.reference.toLowerCase().includes(q) ||
        (b.customer_name && b.customer_name.toLowerCase().includes(q)) ||
        (b.customer_email && b.customer_email.toLowerCase().includes(q)) ||
        (b.event_name && b.event_name.toLowerCase().includes(q))
    );
  }

  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const offset = options.offset ? parseInt(options.offset, 10) : 0;
  return bookings.slice(offset, offset + limit);
}

export async function updateBookingStatus(db, id, newStatus) {
  const validStatuses = ['confirmed', 'pending', 'cancelled', 'refunded'];
  if (!validStatuses.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`);
  }

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE bookings
    SET status = ?, updated_at = ?
    WHERE id = ?
  `);
  await stmt.run(newStatus, now, id);

  return getBookingById(db, id);
}

export default {
  createBooking,
  getBookingById,
  listBookings,
  updateBookingStatus,
};
