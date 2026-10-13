/**
 * Hono application factory.
 *
 * `getDb(c)` supplies the async db handle: the Worker passes a D1 wrapper
 * built from c.env.DB; tests pass an in-memory SQLite wrapper.
 * Static files are served by the Workers assets binding (c.env.ASSETS).
 */

import { Hono } from 'hono';
import { initConfig } from './config.js';
import { ensureInitialAdmin } from './db/index.js';
import { loadUser, requireAuth, requireAdmin } from './auth/middleware.js';
import { securityHeaders } from './middleware/security.js';

import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { eventRoutes } from './routes/events.js';
import { bookingRoutes } from './routes/bookings.js';
import { ticketRoutes } from './routes/tickets.js';
import { customerRoutes } from './routes/customers.js';
import { reportRoutes } from './routes/reports.js';
import { ticketSourceRoutes } from './routes/ticketsource.js';
import { analysisRoutes } from './routes/analysis.js';

async function serveAsset(c, path) {
  if (!c.env?.ASSETS) return c.text('Static assets unavailable', 503);
  return c.env.ASSETS.fetch(new Request(new URL(path, c.req.url), { headers: c.req.raw.headers }));
}

export function createApp(getDb) {
  const app = new Hono();

  app.use('*', securityHeaders);

  app.use('*', async (c, next) => {
    initConfig(c.env || {});
    const db = getDb(c);
    c.set('db', db);
    await ensureInitialAdmin(db);
    await next();
  });
  app.use('*', loadUser);

  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'fireworks-bookings-web', version: '1.0.0' })
  );

  // Pages
  app.get('/login', (c) => (c.get('user') ? c.redirect('/dashboard') : serveAsset(c, '/login.html')));
  app.get('/', requireAuth, (c) => c.redirect('/dashboard'));
  app.get('/dashboard', requireAuth, (c) => serveAsset(c, '/index.html'));
  app.get('/index.html', (c) => c.redirect('/dashboard'));
  app.get('/login.html', (c) => c.redirect('/login'));

  // API
  app.route('/api/auth', authRoutes());
  app.use('/api/admin/*', requireAuth, requireAdmin);
  app.route('/api/admin', adminRoutes());
  app.use('/api/events/*', requireAuth);
  app.route('/api/events', eventRoutes());
  app.use('/api/bookings/*', requireAuth);
  app.route('/api/bookings', bookingRoutes());
  app.use('/api/tickets/*', requireAuth);
  app.route('/api/tickets', ticketRoutes());
  app.use('/api/customers/*', requireAuth);
  app.route('/api/customers', customerRoutes());
  app.use('/api/reports/*', requireAuth);
  app.route('/api/reports', reportRoutes());
  app.use('/api/ticketsource/*', requireAuth);
  app.route('/api/ticketsource', ticketSourceRoutes());
  app.use('/api/analysis/*', requireAuth);
  app.route('/api/analysis', analysisRoutes());

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not Found', path: c.req.path }, 404);
    return c.redirect(c.get('user') ? '/dashboard' : '/login');
  });

  app.onError((err, c) => {
    console.error('Unhandled server error:', err);
    return c.json(
      { error: 'Internal Server Error', message: c.env?.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred' },
      500
    );
  });

  return app;
}
