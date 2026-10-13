import express from 'express';
import {
  getDashboardSummary,
  getDailySalesVelocity,
  getDiscountCodeReport,
  getTicketTypeBreakdown,
  exportBookingsCsv,
} from '../domain/reports.js';

export function createReportRoutes(db) {
  const router = express.Router();

  // GET /api/reports/dashboard
  router.get('/dashboard', (req, res) => {
    const summary = getDashboardSummary(db);
    return res.json({ summary });
  });

  // GET /api/reports/velocity
  router.get('/velocity', (req, res) => {
    const { eventId, days } = req.query;
    const velocity = getDailySalesVelocity(db, { eventId, days });
    return res.json({ velocity });
  });

  // GET /api/reports/discounts
  router.get('/discounts', (req, res) => {
    const discounts = getDiscountCodeReport(db);
    return res.json({ discounts });
  });

  // GET /api/reports/tickets
  router.get('/tickets', (req, res) => {
    const { eventId } = req.query;
    const breakdown = getTicketTypeBreakdown(db, eventId);
    return res.json({ breakdown });
  });

  // GET /api/reports/export.csv
  router.get('/export.csv', (req, res) => {
    const { eventId, status } = req.query;
    const csvData = exportBookingsCsv(db, { eventId, status });
    const filename = `fireworks-bookings-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvData);
  });

  return router;
}

createReportRoutes.createReportRoutes = createReportRoutes;
export default createReportRoutes;
