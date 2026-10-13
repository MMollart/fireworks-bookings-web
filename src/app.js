/**
 * Express application factory.
 * Configures middleware, security, routes, and error handling.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { securityHeaders } from './middleware/security.js';
import { generalRateLimiter } from './middleware/rateLimit.js';
import { requireAuth, requireAdmin } from './auth/middleware.js';
import { getSession } from './auth/sessions.js';

// Route imports
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import eventsRoutes from './routes/events.js';
import bookingsRoutes from './routes/bookings.js';
import ticketsRoutes from './routes/tickets.js';
import customersRoutes from './routes/customers.js';
import reportsRoutes from './routes/reports.js';
import syncRoutes from './routes/sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

/**
 * Creates and configures the Express application.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {express.Express}
 */
export function createApp(db) {
  const app = express();

  // Basic settings
  app.set('trust proxy', 1);

  // Security headers and rate limiting
  app.use(securityHeaders);
  app.use(generalRateLimiter);

  // Body parsing & cookies
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser(config.session.secret));

  // Static assets (CSS, JS, images)
  app.use('/css', express.static(path.join(publicDir, 'css'), { maxAge: '1h' }));
  app.use('/js', express.static(path.join(publicDir, 'js'), { maxAge: '1h' }));

  // Public login page route
  app.get('/login', (req, res) => {
    const token = req.cookies?.[config.session.cookieName];
    if (token) {
      const session = getSession(db, token);
      if (session) {
        return res.redirect('/dashboard');
      }
    }
    return res.sendFile(path.join(publicDir, 'login.html'));
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'fireworks-bookings-web',
      version: '1.0.0'
    });
  });

  // Auth routes (login, logout, me)
  app.use('/api/auth', authRoutes(db));

  // Protected static HTML application pages
  app.get('/', requireAuth(db), (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.get('/dashboard', requireAuth(db), (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Protected API routes
  app.use('/api/admin', requireAuth(db), requireAdmin, adminRoutes(db));
  app.use('/api/events', requireAuth(db), eventsRoutes(db));
  app.use('/api/bookings', requireAuth(db), bookingsRoutes(db));
  app.use('/api/tickets', requireAuth(db), ticketsRoutes(db));
  app.use('/api/customers', requireAuth(db), customersRoutes(db));
  app.use('/api/reports', requireAuth(db), reportsRoutes(db));
  app.use('/api/sync', syncRoutes(db));

  // 404 handler
  app.use((req, res) => {
    if (req.accepts('html')) {
      const token = req.cookies?.[config.session.cookieName];
      if (token && getSession(db, token)) {
        return res.redirect('/dashboard');
      }
      return res.redirect('/login');
    }
    res.status(404).json({ error: 'Not Found', path: req.path });
  });

  // Error handling middleware
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error('Unhandled server error:', err);
    if (res.headersSent) {
      return;
    }
    const status = err.status || 500;
    res.status(status).json({
      error: 'Internal Server Error',
      message: config.env === 'development' ? err.message : 'An unexpected error occurred'
    });
  });

  return app;
}
