import crypto from 'node:crypto';

export function createTicket(db, data) {
  const id = data.id || `tkt_${crypto.randomBytes(6).toString('hex')}`;
  const barcode = data.barcode || `FB-${Math.floor(10000000 + Math.random() * 90000000)}`;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO tickets (id, booking_id, event_id, ticket_type, price, barcode, is_checked_in, checked_in_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)
  `);

  stmt.run(
    id,
    data.booking_id,
    data.event_id,
    data.ticket_type,
    parseFloat(data.price || 0),
    barcode,
    now
  );

  return getTicketById(db, id);
}

export function getTicketById(db, id) {
  return db.prepare(`
    SELECT t.*, e.name AS event_name, b.reference AS booking_reference, b.status AS booking_status
    FROM tickets t
    JOIN events e ON t.event_id = e.id
    JOIN bookings b ON t.booking_id = b.id
    WHERE t.id = ?
  `).get(id);
}

export function getTicketByBarcode(db, barcode) {
  if (!barcode) return null;
  return db.prepare(`
    SELECT t.*, e.name AS event_name, b.reference AS booking_reference, b.status AS booking_status
    FROM tickets t
    JOIN events e ON t.event_id = e.id
    JOIN bookings b ON t.booking_id = b.id
    WHERE t.barcode = ?
  `).get(barcode.trim());
}

export function checkInTicket(db, barcodeOrId, options = {}) {
  let ticket = getTicketByBarcode(db, barcodeOrId);
  if (!ticket) {
    ticket = getTicketById(db, barcodeOrId);
  }
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  if (ticket.booking_status !== 'confirmed') {
    return { success: false, error: `Cannot check in ticket with ${ticket.booking_status} booking status` };
  }
  if (ticket.is_checked_in) {
    const t = {
      ...ticket,
      checked_in: 1,
      already_checked_in: true,
    };
    return {
      success: false,
      error: 'Ticket already checked in',
      already_checked_in: true,
      ticket: t,
      checked_in_at: ticket.checked_in_at,
    };
  }

  const now = options.timestamp || new Date().toISOString();
  db.prepare(`
    UPDATE tickets
    SET is_checked_in = 1, checked_in_at = ?
    WHERE id = ?
  `).run(now, ticket.id);

  const updatedTicket = {
    ...getTicketById(db, ticket.id),
    checked_in: 1,
  };
  return {
    success: true,
    ticket: updatedTicket,
    message: `Checked in successfully: ${ticket.ticket_type} ticket for ${ticket.event_name}`,
  };
}

export function listTickets(db, filters = {}) {
  let sql = `
    SELECT t.*, e.name AS event_name, b.reference AS booking_reference, b.status AS booking_status
    FROM tickets t
    JOIN events e ON t.event_id = e.id
    JOIN bookings b ON t.booking_id = b.id
  `;
  const params = [];
  const where = [];

  if (filters.eventId) {
    where.push('t.event_id = ?');
    params.push(filters.eventId);
  }
  if (filters.bookingId) {
    where.push('t.booking_id = ?');
    params.push(filters.bookingId);
  }
  if (filters.ticketType) {
    where.push('t.ticket_type = ?');
    params.push(filters.ticketType);
  }
  if (filters.isCheckedIn !== undefined) {
    where.push('t.is_checked_in = ?');
    params.push(filters.isCheckedIn ? 1 : 0);
  }
  if (filters.search) {
    where.push('(t.barcode LIKE ? OR b.reference LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  if (where.length > 0) {
    sql += ' WHERE ' + where.join(' AND ');
  }

  sql += ' ORDER BY t.created_at DESC';

  const limit = filters.limit ? parseInt(filters.limit, 10) : 100;
  const offset = filters.offset ? parseInt(filters.offset, 10) : 0;
  sql += ` LIMIT ${limit} OFFSET ${offset}`;

  return db.prepare(sql).all(...params);
}

export default {
  createTicket,
  getTicketById,
  getTicketByBarcode,
  checkInTicket,
  listTickets,
};
