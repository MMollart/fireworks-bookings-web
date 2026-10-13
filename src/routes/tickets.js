import { Hono } from 'hono';
import { requireOperator } from '../auth/middleware.js';
import { listTickets, getTicketById, getTicketByBarcode, checkInTicket } from '../domain/tickets.js';

export function ticketRoutes() {
  const r = new Hono();

  r.get('/', async (c) => {
    const { eventId, bookingId, ticketType, isCheckedIn, search, limit, offset } = c.req.query();
    const tickets = await listTickets(c.get('db'), {
      eventId,
      bookingId,
      ticketType,
      isCheckedIn: isCheckedIn !== undefined ? isCheckedIn === 'true' || isCheckedIn === '1' : undefined,
      search,
      limit,
      offset,
    });
    return c.json({ tickets, count: tickets.length });
  });

  const checkIn = async (c) => {
    const { identifier, barcode } = await c.req.json().catch(() => ({}));
    const code = barcode || identifier;
    if (!code) return c.json({ error: 'Ticket barcode or ID is required for check-in' }, 400);

    const result = await checkInTicket(c.get('db'), code);
    if (result.success) return c.json(result);
    return c.json(result, result.already_checked_in ? 409 : 400);
  };
  r.post('/checkin', requireOperator, checkIn);
  r.post('/check-in', requireOperator, checkIn);

  // Registered after the POST routes so '/checkin' is never read as an id.
  r.get('/:id', async (c) => {
    const db = c.get('db');
    const id = c.req.param('id');
    const ticket = (await getTicketById(db, id)) || (await getTicketByBarcode(db, id));
    return ticket ? c.json({ ticket }) : c.json({ error: 'Ticket not found' }, 404);
  });

  return r;
}
