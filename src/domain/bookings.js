import crypto from 'node:crypto';
import { upsertCustomer, getCustomerById } from './customers.js';
import { getDiscountByCode, calculateDiscount, recordDiscountUsage } from './discounts.js';
import { createTicket } from './tickets.js';
import { decrypt } from '../crypto/encryption.js';

export function createBooking(db, data) {
  const eventId = data.eventId || data.event_id;
  if (!eventId) {
    throw new Error('Event ID is required');
  }
  if (!data.customer || !data.customer.email) {
    throw new Error('Customer information with valid email is required');
  }
  if (!data.tickets || !Array.isArray(data.tickets) || data.tickets.length === 0) {
    throw new Error('At least one ticket is required for booking');
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) {
    throw new Error('Event not found');
  }

  // Upsert customer (personal data encrypted at rest)
  const customer = upsertCustomer(db, data.customer);

  // Calculate ticket subtotal
  let subtotal = 0;
  for (const t of data.tickets) {
    subtotal += parseFloat(t.price || 0);
  }

  // Handle discount code if supplied
  let discountCodeId = null;
  let discountAmount = 0;
  const rawDiscountCode = data.discountCode || data.discount_code;
  if (rawDiscountCode) {
    const discount = getDiscountByCode(db, rawDiscountCode);
    if (discount && discount.is_active) {
      discountCodeId = discount.id;
      const calc = calculateDiscount(discount, subtotal);
      discountAmount = typeof calc === 'number' ? calc : (calc?.discountAmount ?? 0);
    }
  }

  const totalPrice = Math.max(0, parseFloat((subtotal - discountAmount).toFixed(2)));
  const bookingId = data.id || `bk_${crypto.randomBytes(6).toString('hex')}`;
  const reference = data.reference || data.booking_reference || `FB-${Math.floor(100000 + Math.random() * 900000)}`;
  const now = new Date().toISOString();
  const bookingDate = data.bookingDate || data.booking_date || now;
  const status = data.status || 'confirmed';

  // Insert booking
  const insertBooking = db.prepare(`
    INSERT INTO bookings (
      id, reference, event_id, customer_id, booking_date, status,
      subtotal, discount_code_id, discount_amount, total_price,
      payment_method, payment_reference, notes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertBooking.run(
    bookingId,
    reference,
    eventId,
    customer.id,
    bookingDate,
    status,
    subtotal,
    discountCodeId,
    discountAmount,
    totalPrice,
    data.paymentMethod || data.payment_method || 'card',
    data.paymentReference || data.payment_reference || null,
    data.notes || null,
    now,
    now
  );

  // Insert tickets
  const createdTickets = [];
  for (const t of data.tickets) {
    const ticket = createTicket(db, {
      booking_id: bookingId,
      event_id: eventId,
      ticket_type: t.ticketType || t.ticket_type || 'Standard',
      price: t.price || 0,
      barcode: t.barcode,
    });
    createdTickets.push(ticket);
  }

  // If confirmed and had discount, record usage
  if (status === 'confirmed' && (discountCodeId || rawDiscountCode)) {
    recordDiscountUsage(db, discountCodeId || rawDiscountCode, discountAmount, totalPrice);
  }

  const result = getBookingById(db, bookingId);
  result.booking_reference = result.reference;
  result.subtotal_amount = result.subtotal;
  result.total_amount = result.total_price;
  result.tickets = createdTickets;
  result.booking = {
    ...result,
    booking_reference: result.reference,
    subtotal_amount: result.subtotal,
    total_amount: result.total_price,
  };
  return result;
}

export function getBookingById(db, id) {
  const row = db.prepare(`
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

  const tickets = db.prepare('SELECT * FROM tickets WHERE booking_id = ?').all(id);

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
      name: decrypt(row.name_encrypted),
      email: decrypt(row.email_encrypted),
      phone: decrypt(row.phone_encrypted),
      postcode: decrypt(row.postcode_encrypted),
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

export function listBookings(db, options = {}) {
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

  const rows = db.prepare(sql).all(...params);

  // Decrypt customer fields in-memory for authorized viewing
  let bookings = rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    event_id: row.event_id,
    event_name: row.event_name,
    customer_id: row.customer_id,
    customer_name: decrypt(row.name_encrypted),
    customer_email: decrypt(row.email_encrypted),
    customer_phone: decrypt(row.phone_encrypted),
    customer_postcode: decrypt(row.postcode_encrypted),
    booking_date: row.booking_date,
    status: row.status,
    subtotal: row.subtotal,
    discount_code: row.discount_code,
    discount_amount: row.discount_amount,
    total_price: row.total_price,
    payment_method: row.payment_method,
    ticket_count: row.ticket_count,
    created_at: row.created_at,
  }));

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

export function updateBookingStatus(db, id, newStatus) {
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
  stmt.run(newStatus, now, id);

  return getBookingById(db, id);
}

export default {
  createBooking,
  getBookingById,
  listBookings,
  updateBookingStatus,
};
