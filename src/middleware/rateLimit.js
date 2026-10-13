export function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000; // default 1 minute
  const max = options.max || 100;
  const message = options.message || 'Too many requests, please try again later.';
  const hits = new Map();

  // Periodic cleanup every minute
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits.entries()) {
      if (now - record.resetTime > windowMs) {
        hits.delete(key);
      }
    }
  }, Math.min(windowMs, 60000));

  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return function rateLimiter(req, res, next) {
    // In tests or if disabled, skip
    if (process.env.DISABLE_RATE_LIMIT === 'true') {
      return next();
    }

    const ip =
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown-ip';

    const key = `${options.prefix || 'rl'}:${ip}`;
    const now = Date.now();

    let record = hits.get(key);
    if (!record || now > record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      hits.set(key, record);
    } else {
      record.count += 1;
    }

    const remaining = Math.max(0, max - record.count);
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetTime / 1000));

    if (record.count > max) {
      res.setHeader('Retry-After', retryAfter);
      if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
        return res.status(429).json({
          error: 'Too Many Requests',
          message,
          retryAfter,
        });
      }
      return res.status(429).send(`<h1>429 Too Many Requests</h1><p>${message}</p>`);
    }

    next();
  };
}

// Strict limiter for login to prevent brute force
export const loginRateLimiter = createRateLimiter({
  prefix: 'login',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 minutes
  message: 'Too many login attempts. Please wait 15 minutes before trying again.',
});

// General limiter for API endpoints
export const apiRateLimiter = createRateLimiter({
  prefix: 'api',
  windowMs: 60 * 1000, // 1 minute
  max: 300,
});

export const generalRateLimiter = apiRateLimiter;

export default {
  createRateLimiter,
  loginRateLimiter,
  apiRateLimiter,
  generalRateLimiter,
};
