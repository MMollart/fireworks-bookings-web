import { Hono } from 'hono';
import { requireOperator } from '../auth/middleware.js';
import { listBookings, getBookingById, createBooking, updateBookingStatus } from '../domain/bookings.js';

export function bookingRoutes() {
  const r = new Hono();

  r.get('/', async (c) => {
    const { status, search, reference, limit, offset } = c.req.query();
    const eventId = c.req.query('eventId') || c.req.query('event_id');
    const bookings = await listBookings(c.get('db'), { eventId, status, search, reference, limit, offset });
    return c.json({ bookings, count: bookings.length });
  });

  r.get('/:id', async (c) => {
    const booking = await getBookingById(c.get('db'), c.req.param('id'));
    return booking ? c.json({ booking }) : c.json({ error: 'Booking not found' }, 404);
  });

  r.post('/', requireOperator, async (c) => {
    try {
      const booking = await createBooking(c.get('db'), await c.req.json().catch(() => ({})));
      return c.json({ success: true, booking }, 201);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  r.patch('/:id/status', requireOperator, async (c) => {
    const { status } = await c.req.json().catch(() => ({}));
    if (!status) return c.json({ error: 'Status is required' }, 400);
    try {
      const booking = await updateBookingStatus(c.get('db'), c.req.param('id'), status);
      return booking ? c.json({ success: true, booking }) : c.json({ error: 'Booking not found' }, 404);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return r;
}
