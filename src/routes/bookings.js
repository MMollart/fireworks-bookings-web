import { Hono } from 'hono';
import { listBookings, getBookingById } from '../domain/bookings.js';

export function bookingRoutes() {
  const r = new Hono();

  r.get('/', async (c) => {
    const { status, search, reference, limit, offset } = c.req.query();
    const eventId = c.req.query('eventId') || c.req.query('event_id');
    const bookings = await listBookings(c.get('db'), { eventId, status, search, reference, limit, offset });
    return c.json({ bookings, count: bookings.length, tooShort: Boolean(bookings.tooShort) });
  });

  // Bookings come from TicketSource only: this app never creates or edits them.
  r.get('/:id', async (c) => {
    const booking = await getBookingById(c.get('db'), c.req.param('id'));
    return booking ? c.json({ booking }) : c.json({ error: 'Booking not found' }, 404);
  });

  return r;
}
