import express from 'express';
import { listBookings, getBookingById, createBooking, updateBookingStatus } from '../domain/bookings.js';

export function createBookingRoutes(db) {
  const router = express.Router();

  // GET /api/bookings
  router.get('/', (req, res) => {
    const { eventId, status, search, reference, limit, offset } = req.query;
    const bookings = listBookings(db, {
      eventId,
      status,
      search,
      reference,
      limit,
      offset,
    });
    return res.json({ bookings, count: bookings.length });
  });

  // GET /api/bookings/:id
  router.get('/:id', (req, res) => {
    const booking = getBookingById(db, req.params.id);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    return res.json({ booking });
  });

  // POST /api/bookings
  router.post('/', (req, res) => {
    if (req.user.role === 'viewer') {
      return res.status(403).json({ error: 'Permission denied. Operator or admin role required.' });
    }

    try {
      const booking = createBooking(db, req.body || {});
      return res.status(201).json({ success: true, booking });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  // PATCH /api/bookings/:id/status
  router.patch('/:id/status', (req, res) => {
    if (req.user.role === 'viewer') {
      return res.status(403).json({ error: 'Permission denied. Operator or admin role required.' });
    }

    const { status } = req.body || {};
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    try {
      const updated = updateBookingStatus(db, req.params.id, status);
      if (!updated) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      return res.json({ success: true, booking: updated });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  return router;
}

createBookingRoutes.createBookingRoutes = createBookingRoutes;
export default createBookingRoutes;
