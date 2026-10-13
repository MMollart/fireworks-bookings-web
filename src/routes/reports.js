import { Hono } from 'hono';
import {
  getDashboardSummary,
  getDailySalesVelocity,
  getDiscountCodeReport,
  getTicketTypeBreakdown,
  exportBookingsCsv,
  exportTransactionsCsv,
} from '../domain/reports.js';

export function reportRoutes() {
  const r = new Hono();

  r.get('/dashboard', async (c) => {
    const summary = await getDashboardSummary(c.get('db'));
    return c.json({ ...summary, summary });
  });

  r.get('/velocity', async (c) => {
    const { eventId, days } = c.req.query();
    return c.json({ velocity: await getDailySalesVelocity(c.get('db'), { eventId, days }) });
  });

  r.get('/discounts', async (c) => c.json({ discounts: await getDiscountCodeReport(c.get('db')) }));

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
