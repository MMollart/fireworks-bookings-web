import express from 'express';
import { TicketSourceSync } from '../sync/ticketsource.js';
import { config } from '../config.js';

export function createSyncRoutes(db) {
  const router = express.Router();
  const syncEngine = new TicketSourceSync(db, {
    apiKey: config.ticketSource.apiKey,
    apiUrl: config.ticketSource.apiUrl,
  });

  // GET /api/sync/status
  router.get('/status', (req, res) => {
    const latestCheckpoint = syncEngine.getLatestCheckpoint();
    const recentLogs = syncEngine.getRecentLogs(30);

    return res.json({
      status: latestCheckpoint ? latestCheckpoint.status : 'idle',
      latestCheckpoint,
      recentLogs,
      hasApiKey: Boolean(config.ticketSource.apiKey),
    });
  });

  // POST /api/sync/trigger
  router.post('/trigger', async (req, res) => {
    if (req.user.role === 'viewer') {
      return res.status(403).json({ error: 'Permission denied. Operator or admin role required to trigger sync.' });
    }

    try {
      const result = await syncEngine.runSync(req.body || {});
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/sync/webhook (TicketSource incoming webhook)
  router.post('/webhook', (req, res) => {
    // Webhook payloads can be ingested immediately
    const payload = req.body;
    if (!payload) {
      return res.status(400).json({ error: 'Payload missing' });
    }

    try {
      if (payload.order || payload.reference) {
        const orderData = payload.order || payload;
        syncEngine.ingestBooking(orderData);
      }
      return res.json({ received: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

createSyncRoutes.createSyncRoutes = createSyncRoutes;
export default createSyncRoutes;
