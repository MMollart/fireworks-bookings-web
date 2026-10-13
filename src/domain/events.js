import crypto from 'node:crypto';

export function listEvents(db, filters = {}) {
  let sql = `
    SELECT 
      e.*,
      COALESCE(SUM(CASE WHEN b.status = 'confirmed' THEN 1 ELSE 0 END), 0) AS total_confirmed_bookings,
      COALESCE(COUNT(t.id), 0) AS tickets_sold,
      COALESCE(SUM(CASE WHEN b.status = 'confirmed' THEN t.price ELSE 0 END), 0) AS gross_revenue
    FROM events e
    LEFT JOIN bookings b ON e.id = b.event_id AND b.status = 'confirmed'
    LEFT JOIN tickets t ON b.id = t.booking_id
  `;
  const params = [];
  const where = [];

  if (filters.status) {
    where.push('e.status = ?');
    params.push(filters.status);
  }

  if (where.length > 0) {
    sql += ' WHERE ' + where.join(' AND ');
  }

  sql += ' GROUP BY e.id ORDER BY e.event_date ASC';

  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => ({
    ...row,
    occupancy_pct: row.capacity > 0 ? Math.min(100, Math.round((row.tickets_sold / row.capacity) * 100)) : 0,
    remaining_capacity: Math.max(0, row.capacity - row.tickets_sold),
  }));
}

export function getEventById(db, id) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!event) return null;

  // Aggregated stats
  const stats = db.prepare(`
    SELECT 
      COUNT(DISTINCT b.id) AS confirmed_bookings,
      COUNT(t.id) AS tickets_sold,
      COALESCE(SUM(t.price), 0) AS gross_revenue,
      SUM(CASE WHEN t.is_checked_in = 1 THEN 1 ELSE 0 END) AS checked_in_count
    FROM bookings b
    LEFT JOIN tickets t ON b.id = t.booking_id
    WHERE b.event_id = ? AND b.status = 'confirmed'
  `).get(id);

  // Breakdown by ticket type
  const ticketTypes = db.prepare(`
    SELECT t.ticket_type, COUNT(t.id) AS count, COALESCE(SUM(t.price), 0) AS revenue
    FROM tickets t
    JOIN bookings b ON t.booking_id = b.id
    WHERE b.event_id = ? AND b.status = 'confirmed'
    GROUP BY t.ticket_type
    ORDER BY count DESC
  `).all(id);

  return {
    ...event,
    stats: {
      confirmed_bookings: stats.confirmed_bookings || 0,
      tickets_sold: stats.tickets_sold || 0,
      gross_revenue: stats.gross_revenue || 0,
      checked_in_count: stats.checked_in_count || 0,
      occupancy_pct: event.capacity > 0 ? Math.min(100, Math.round(((stats.tickets_sold || 0) / event.capacity) * 100)) : 0,
      remaining_capacity: Math.max(0, event.capacity - (stats.tickets_sold || 0)),
    },
    ticket_types: ticketTypes,
  };
}

export function createEvent(db, data) {
  const id = data.id || `evt_${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  const slug = data.slug || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const stmt = db.prepare(`
    INSERT INTO events (id, name, slug, venue, event_date, gates_open, display_time, capacity, status, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    data.name,
    slug,
    data.venue || null,
    data.event_date,
    data.gates_open || null,
    data.display_time || null,
    parseInt(data.capacity || 0, 10),
    data.status || 'active',
    data.description || null,
    now,
    now
  );

  return getEventById(db, id);
}

export function updateEvent(db, id, data) {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE events
    SET name = ?, venue = ?, event_date = ?, gates_open = ?, display_time = ?,
        capacity = ?, status = ?, description = ?, updated_at = ?
    WHERE id = ?
  `);

  stmt.run(
    data.name !== undefined ? data.name : existing.name,
    data.venue !== undefined ? data.venue : existing.venue,
    data.event_date !== undefined ? data.event_date : existing.event_date,
    data.gates_open !== undefined ? data.gates_open : existing.gates_open,
    data.display_time !== undefined ? data.display_time : existing.display_time,
    data.capacity !== undefined ? parseInt(data.capacity, 10) : existing.capacity,
    data.status !== undefined ? data.status : existing.status,
    data.description !== undefined ? data.description : existing.description,
    now,
    id
  );

  return getEventById(db, id);
}

export function deleteEvent(db, id) {
  const bookingCount = db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE event_id = ?').get(id);
  if (bookingCount.count > 0) {
    throw new Error('Cannot delete event with existing bookings');
  }
  const stmt = db.prepare('DELETE FROM events WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export default {
  listEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
};
