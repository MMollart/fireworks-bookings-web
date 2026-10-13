/** Performances imported from TicketSource, newest first. Names carry the year (see migration 0006 / refreshDates). */
export async function listEvents(db, filters = {}) {
  const params = [];
  const where = ['e.ts_event_id IS NOT NULL']; // only events that come from TicketSource
  if (filters.status) {
    where.push('e.status = ?');
    params.push(filters.status);
  }
  return db.prepare(`SELECT e.* FROM events e WHERE ${where.join(' AND ')} ORDER BY e.event_date DESC`).all(...params);
}

export async function getEventById(db, id) {
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!event) return null;

  // Aggregated stats
  const stats = await db.prepare(`
    SELECT 
      COUNT(DISTINCT b.id) AS confirmed_bookings,
      COUNT(t.id) AS tickets_sold
    FROM bookings b
    LEFT JOIN tickets t ON b.id = t.booking_id
    WHERE b.event_id = ? AND b.status = 'confirmed'
  `).get(id);

  // Breakdown by ticket type
  const ticketTypes = await db.prepare(`
    SELECT t.ticket_type, COUNT(t.id) AS count
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
    },
    ticket_types: ticketTypes,
  };
}

export default {
  listEvents,
  getEventById,
};
