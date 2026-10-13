import express from 'express';
import { listTickets, getTicketById, getTicketByBarcode, checkInTicket } from '../domain/tickets.js';

export function createTicketRoutes(db) {
  const router = express.Router();

  // GET /api/tickets
  router.get('/', (req, res) => {
    const { eventId, bookingId, ticketType, isCheckedIn, search, limit, offset } = req.query;
    const tickets = listTickets(db, {
      eventId,
      bookingId,
      ticketType,
      isCheckedIn: isCheckedIn !== undefined ? isCheckedIn === 'true' || isCheckedIn === '1' : undefined,
      search,
      limit,
      offset,
    });
    return res.json({ tickets, count: tickets.length });
  });

  // GET /api/tickets/:id
  router.get('/:id', (req, res) => {
    let ticket = getTicketById(db, req.params.id);
    if (!ticket) {
      ticket = getTicketByBarcode(db, req.params.id);
    }
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    return res.json({ ticket });
  });

  // POST /api/tickets/checkin and /api/tickets/check-in
  const handleCheckIn = (req, res) => {
    if (req.user.role === 'viewer') {
      return res.status(403).json({ error: 'Permission denied. Operator or admin role required for check-in.' });
    }

    const { identifier, barcode } = req.body || {};
    const code = barcode || identifier;
    if (!code) {
      return res.status(400).json({ error: 'Ticket barcode or ID is required for check-in' });
    }

    const result = checkInTicket(db, code);
    if (!result.success) {
      if (result.already_checked_in) {
        return res.status(409).json(result);
      }
      return res.status(400).json(result);
    }

    return res.json(result);
  };

  router.post('/checkin', handleCheckIn);
  router.post('/check-in', handleCheckIn);

  return router;
}

createTicketRoutes.createTicketRoutes = createTicketRoutes;
export default createTicketRoutes;
