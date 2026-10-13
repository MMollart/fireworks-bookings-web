import { config } from '../config.js';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Mirrors public/_headers, which covers statically served assets. */
export async function securityHeaders(c, next) {
  await next();
  // Responses proxied from the assets binding have immutable headers; clone first.
  c.res = new Response(c.res.body, c.res);
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  h.set('Content-Security-Policy', CSP);
  if (config.isProd) h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
