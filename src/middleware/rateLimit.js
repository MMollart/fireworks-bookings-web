/**
 * D1-backed fixed-window rate limiter. Returns { limited, retryAfter }.
 * State lives in the database so it holds across Worker isolates.
 */
export async function hit(db, key, { windowMs, max }) {
  const now = Date.now();
  const row = await db.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?').get(key);

  if (!row || now > row.reset_at) {
    await db
      .prepare('INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)')
      .run(key, now + windowMs);
    return { limited: false, retryAfter: 0 };
  }

  await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
  const limited = row.count + 1 > max;
  return { limited, retryAfter: limited ? Math.ceil((row.reset_at - now) / 1000) : 0 };
}

export async function clear(db, key) {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
}

export function clientIp(c) {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown-ip';
}
