import { Hono } from 'hono';
import { listEvents, getEventById } from '../domain/events.js';

/** Read-only: events (performances) come from TicketSource; the app never creates or edits them. */
export function eventRoutes() {
  const r = new Hono();

  r.get('/', async (c) => c.json({ events: await listEvents(c.get('db'), { status: c.req.query('status') }) }));

  r.get('/:id', async (c) => {
    const event = await getEventById(c.get('db'), c.req.param('id'));
    return event ? c.json({ event }) : c.json({ error: 'Event not found' }, 404);
  });

  return r;
}
