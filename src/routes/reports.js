import { Hono } from 'hono';
import {
  getDashboardSummary,
  listEventTotals,
  getDailySalesVelocity,
  getDiscountCodeReport,
  getTicketTypeBreakdown,
  exportBookingsCsv,
  exportTransactionsCsv,
} from '../domain/reports.js';
import { donationTotals, listDonations } from '../domain/donations.js';

export function reportRoutes() {
  const r = new Hono();

  r.get('/dashboard', async (c) => {
    const summary = await getDashboardSummary(c.get('db'), { eventId: c.req.query('eventId') });
    return c.json({ ...summary, summary });
  });

  // Events (newest first) for the event selectors on the dashboard and Reports.
  r.get('/events', async (c) => c.json({ events: await listEventTotals(c.get('db')) }));

  r.get('/velocity', async (c) => {
    const { eventId, days } = c.req.query();
    return c.json({ velocity: await getDailySalesVelocity(c.get('db'), { eventId, days }) });
  });

  r.get('/discounts', async (c) => {
    const eventId = c.req.query('eventId');
    return c.json(await getDiscountCodeReport(c.get('db'), { eventId: eventId && eventId !== 'all' ? eventId : undefined }));
  });

  r.get('/donations', async (c) => {
    const eventId = c.req.query('eventId');
    const scope = eventId && eventId !== 'all' ? { eventId } : {};
    return c.json({ totals: await donationTotals(c.get('db'), scope), items: await listDonations(c.get('db'), scope) });
  });

  r.get('/tickets', async (c) => c.json({ breakdown: await getTicketTypeBreakdown(c.get('db'), c.req.query('eventId')) }));

  r.get('/export.csv', async (c) => {
    const { eventId, status } = c.req.query();
    const csv = await exportBookingsCsv(c.get('db'), { eventId, status });
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="fireworks-bookings-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(csv);
  });

  r.get('/transactions.csv', async (c) => {
    const csv = await exportTransactionsCsv(c.get('db'), { eventId: c.req.query('eventId') });
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="fireworks-transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(csv);
  });

  return r;
}
