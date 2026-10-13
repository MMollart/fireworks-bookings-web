import { Hono } from 'hono';
import { requireOperator } from '../auth/middleware.js';
import { listEvents, getEventById, createEvent, updateEvent, deleteEvent } from '../domain/events.js';

export function eventRoutes() {
  const r = new Hono();

  r.get('/', async (c) => c.json({ events: await listEvents(c.get('db'), { status: c.req.query('status') }) }));

  r.get('/:id', async (c) => {
    const event = await getEventById(c.get('db'), c.req.param('id'));
    return event ? c.json({ event }) : c.json({ error: 'Event not found' }, 404);
  });

  r.post('/', requireOperator, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.name || !body.event_date) return c.json({ error: 'Event name and event_date are required' }, 400);
    try {
      const event = await createEvent(c.get('db'), body);
      return c.json({ success: true, event }, 201);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  r.put('/:id', requireOperator, async (c) => {
    try {
      const event = await updateEvent(c.get('db'), c.req.param('id'), await c.req.json().catch(() => ({})));
      return event ? c.json({ success: true, event }) : c.json({ error: 'Event not found' }, 404);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  r.delete('/:id', async (c) => {
    if (c.get('user').role !== 'admin') {
      return c.json({ error: 'Permission denied. Admin role required to delete events.' }, 403);
    }
    try {
      const ok = await deleteEvent(c.get('db'), c.req.param('id'));
      return ok ? c.json({ success: true, message: 'Event deleted successfully' }) : c.json({ error: 'Event not found' }, 404);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return r;
}
