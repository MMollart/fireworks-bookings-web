import { randomHex, randomInt } from '../lib/bytes.js';

/** Builds (but does not run) an INSERT for a ticket so callers can batch it. */
export function buildTicketInsert(db, data) {
  const id = data.id || `tkt_${randomHex(6)}`;
  const barcode = data.barcode || `FB-${randomInt(10000000, 100000000)}`;
  const stmt = db
    .prepare(
      `INSERT INTO tickets (id, booking_id, event_id, ticket_type, price, barcode, is_checked_in, checked_in_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`
    )
    .bind(id, data.booking_id, data.event_id, data.ticket_type, parseFloat(data.price || 0), barcode, new Date().toISOString());
  return { id, barcode, stmt };
}

export async function createTicket(db, data) {
  const { id, stmt } = buildTicketInsert(db, data);
  await stmt.run();
  return getTicketById(db, id);
}

const TICKET_SELECT = `
  SELECT t.*, e.name AS event_name, b.reference AS booking_reference, b.status AS booking_status
  FROM tickets t
  JOIN events e ON t.event_id = e.id
  JOIN bookings b ON t.booking_id = b.id`;

export function getTicketById(db, id) {
  return db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id);
}

export async function getTicketByBarcode(db, barcode) {
  if (!barcode) return null;
  return db.prepare(`${TICKET_SELECT} WHERE t.barcode = ?`).get(String(barcode).trim());
}

export async function checkInTicket(db, barcodeOrId, options = {}) {
  let ticket = await getTicketByBarcode(db, barcodeOrId);
  if (!ticket) ticket = await getTicketById(db, barcodeOrId);
  if (!ticket) return { success: false, error: 'Ticket not found' };

  if (ticket.booking_status !== 'confirmed') {
    return { success: false, error: `Cannot check in ticket with ${ticket.booking_status} booking status` };
  }
  if (ticket.is_checked_in) {
    return {
      success: false,
      error: 'Ticket already checked in',
      already_checked_in: true,
      ticket: { ...ticket, checked_in: 1, already_checked_in: true },
      checked_in_at: ticket.checked_in_at,
    };
  }

  // Conditional update so two gates scanning the same code can't both succeed.
  const now = options.timestamp || new Date().toISOString();
  const res = await db
    .prepare('UPDATE tickets SET is_checked_in = 1, checked_in_at = ? WHERE id = ? AND is_checked_in = 0')
    .run(now, ticket.id);
  if (res.changes === 0) {
    return {
      success: false,
      error: 'Ticket already checked in',
      already_checked_in: true,
      ticket: { ...ticket, checked_in: 1, already_checked_in: true },
    };
  }

  const updatedTicket = { ...(await getTicketById(db, ticket.id)), checked_in: 1 };
  return {
    success: true,
    ticket: updatedTicket,
    message: `Checked in successfully: ${ticket.ticket_type} ticket for ${ticket.event_name}`,
  };
}

export function listTickets(db, filters = {}) {
  let sql = TICKET_SELECT;
  const params = [];
  const where = [];

  if (filters.eventId) { where.push('t.event_id = ?'); params.push(filters.eventId); }
  if (filters.bookingId) { where.push('t.booking_id = ?'); params.push(filters.bookingId); }
  if (filters.ticketType) { where.push('t.ticket_type = ?'); params.push(filters.ticketType); }
  if (filters.isCheckedIn !== undefined) { where.push('t.is_checked_in = ?'); params.push(filters.isCheckedIn ? 1 : 0); }
  if (filters.search) {
    where.push('(t.barcode LIKE ? OR b.reference LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');

  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);
  sql += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

export default { createTicket, getTicketById, getTicketByBarcode, checkInTicket, listTickets };
