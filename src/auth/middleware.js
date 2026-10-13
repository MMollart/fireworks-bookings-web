import { config } from '../config.js';
import { getSession } from './sessions.js';

export const PUBLIC_EXACT_PATHS = new Set([
  '/',
  '/login',
  '/logout',
  '/api/auth/login',
  '/api/auth/logout',
  '/health',
  '/api/health',
  '/favicon.ico',
]);

export const PUBLIC_PREFIXES = [
  '/css/',
  '/js/login.js',
  '/images/',
  '/assets/',
];

export function isPublicPath(pathname) {
  if (PUBLIC_EXACT_PATHS.has(pathname)) {
    return true;
  }
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function createAuthMiddleware(db) {
  return function authMiddleware(req, res, next) {
    const rawToken =
      (req.cookies && req.cookies[config.sessionCookieName]) ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);

    let session = null;
    if (rawToken) {
      session = getSession(db, rawToken);
    }

    if (session) {
      req.user = session.user;
      req.sessionToken = rawToken;
      res.locals.user = session.user;
    } else {
      req.user = null;
      req.sessionToken = null;
      res.locals.user = null;
    }

    const pathname = req.path;

    // Allow explicitly public paths
    if (isPublicPath(pathname)) {
      // If user is already logged in and visiting /login or root, redirect them to dashboard
      if (req.user && (pathname === '/login' || pathname === '/')) {
        return res.redirect('/dashboard');
      }
      return next();
    }

    // Unauthenticated user attempting to access protected route
    if (!req.user) {
      if (pathname.startsWith('/api/')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required to access this resource',
        });
      }
      return res.redirect('/login');
    }

    return next();
  };
}

export function requireAuth(arg1, arg2, arg3) {
  if (arg2 && typeof arg2.status === 'function') {
    // Called directly as middleware (req, res, next)
    const req = arg1;
    const res = arg2;
    const next = arg3;
    if (!req.user) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }
      return res.redirect('/login');
    }
    return next();
  }

  // Called as middleware factory: requireAuth(db)
  const db = arg1;
  return function requireAuthMiddleware(req, res, next) {
    if (!req.user && db) {
      const cookieName = config.sessionCookieName || config.session?.cookieName || 'fb_session';
      const rawToken =
        (req.cookies && req.cookies[cookieName]) ||
        (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : null);
      if (rawToken) {
        const session = getSession(db, rawToken);
        if (session) {
          req.user = session.user;
          req.sessionToken = rawToken;
          res.locals.user = session.user;
        }
      }
    }

    if (!req.user) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }
      return res.redirect('/login');
    }
    return next();
  };
}

export function requireAdmin(arg1, arg2, arg3) {
  if (arg2 && typeof arg2.status === 'function') {
    const req = arg1;
    const res = arg2;
    const next = arg3;
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Administrator privileges required',
      });
    }
    return next();
  }

  return function requireAdminMiddleware(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Administrator privileges required',
      });
    }
    return next();
  };
}

export default {
  isPublicPath,
  createAuthMiddleware,
  requireAuth,
  requireAdmin,
};
