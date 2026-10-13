import express from 'express';
import { listEvents, getEventById, createEvent, updateEvent, deleteEvent } from '../domain/events.js';

export function createEventRoutes(db) {
  const router = express.Router();

  // GET /api/events
  router.get('/', (req, res) => {
    const { status } = req.query;
    const events = listEvents(db, { status });
    return res.json({ events });
  });

  // GET /api/events/:id
  router.get('/:id', (req, res) => {
    const event = getEventById(db, req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    return res.json({ event });
  });

  // POST /api/events
  router.post('/', (req, res) => {
    if (req.user.role === 'viewer') {
      return res.status(403).json({ error: 'Permission denied. Operator or admin role required.' });
    }

    const { name, event_date, venue, capacity, description, gates_open, display_time, status } = req.body || {};
    if (!name || !event_date) {
      return res.status(400).json({ error: 'Event name and event_date are required' });
    }

    try {
      const created = createEvent(db, {
        name,
        event_date,
        venue,
        capacity,
        description,
        gates_open,
        display_time,
        status,
      });
      return res.status(201).json({ success: true, event: created });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  // PUT /api/events/:id
  router.put('/:id', (req, res) => {
    if (req.user.role === 'viewer') {
      return res.status(403).json({ error: 'Permission denied. Operator or admin role required.' });
    }

    try {
      const updated = updateEvent(db, req.params.id, req.body || {});
      if (!updated) {
        return res.status(404).json({ error: 'Event not found' });
      }
      return res.json({ success: true, event: updated });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/events/:id
  router.delete('/:id', (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Permission denied. Admin role required to delete events.' });
    }

    try {
      const ok = deleteEvent(db, req.params.id);
      if (!ok) {
        return res.status(404).json({ error: 'Event not found' });
      }
      return res.json({ success: true, message: 'Event deleted successfully' });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  return router;
}

createEventRoutes.createEventRoutes = createEventRoutes;
export default createEventRoutes;
