/**
 * Rate-limit-aware TicketSource API client.
 *
 * TicketSource allows 240 calls/minute. This client:
 *  - keeps a global, rolling 60s call count in D1 (shared by every Worker instance) and only
 *    reserves as many calls for a step as that leaves free, under a lower self-imposed ceiling;
 *  - caps each Worker invocation to `stepCalls` API calls (Workers limit external subrequests);
 *  - honours 429 responses (Retry-After) by recording a "blocked until" time that every later step respects.
 *
 * READ-ONLY: this application never writes to TicketSource. All traffic goes through request(),
 * which refuses anything but GET.
 *
 * When it runs out of budget it throws StepLimit. Callers persist their progress and report
 * `retryAfterMs`, so a long sync simply continues over several short invocations.
 */

const BUCKET_MS = 10_000;
const WINDOW_BUCKETS = 6; // 6 x 10s = rolling minute

export class StepLimit extends Error {
  constructor(reason, retryAfterMs = 0, message = '') {
    super(message || `TicketSource step limit: ${reason}`);
    this.name = 'StepLimit';
    this.reason = reason; // 'budget' | 'rate' | 'rate_limited'
    this.retryAfterMs = retryAfterMs;
  }
}

export async function getState(db, key) {
  const row = await db.prepare('SELECT value FROM ts_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

export async function setState(db, key, value) {
  await db.prepare('INSERT OR REPLACE INTO ts_state (key, value) VALUES (?, ?)').run(key, String(value));
}

export async function rateStatus(db, callsPerMinute, now = Date.now()) {
  const current = Math.floor(now / BUCKET_MS);
  const row = await db
    .prepare('SELECT COALESCE(SUM(calls), 0) AS used FROM ts_api_calls WHERE bucket > ?')
    .get(current - WINDOW_BUCKETS);
  const blockedUntil = Number(await getState(db, 'blocked_until')) || 0;
  return {
    usedLastMinute: row.used,
    limitPerMinute: callsPerMinute,
    available: Math.max(0, callsPerMinute - row.used),
    blockedUntil: blockedUntil > now ? new Date(blockedUntil).toISOString() : null,
  };
}

export class TicketSourceClient {
  constructor(db, { apiKey, apiUrl, stepCalls, callsPerMinute }, { fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
    this.db = db;
    this.apiKey = apiKey;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.stepCalls = stepCalls;
    this.callsPerMinute = callsPerMinute;
    this.fetch = fetchImpl;
    this.now = now;
    this.remaining = 0;
    this.reserved = 0;
    this.used = 0;
  }

  /** Reserves this step's call budget. Throws StepLimit if nothing can be spent right now. */
  async begin() {
    if (!this.apiKey) throw new Error('TICKETSOURCE_API_KEY is not configured');

    const now = this.now();
    const blockedUntil = Number(await getState(this.db, 'blocked_until')) || 0;
    if (blockedUntil > now) throw new StepLimit('rate_limited', blockedUntil - now, 'TicketSource asked us to slow down');

    const { available } = await rateStatus(this.db, this.callsPerMinute, now);
    const grant = Math.min(this.stepCalls, available);
    if (grant <= 0) {
      throw new StepLimit('rate', BUCKET_MS - (now % BUCKET_MS) + 500, 'Waiting for the per-minute API allowance');
    }

    const bucket = Math.floor(now / BUCKET_MS);
    await this.db
      .prepare('INSERT INTO ts_api_calls (bucket, calls) VALUES (?, ?) ON CONFLICT(bucket) DO UPDATE SET calls = calls + excluded.calls')
      .run(bucket, grant);
    await this.db.prepare('DELETE FROM ts_api_calls WHERE bucket <= ?').run(bucket - WINDOW_BUCKETS - 1);

    this.bucket = bucket;
    this.reserved = grant;
    this.remaining = grant;
    return grant;
  }

  /** Returns unused reserved calls to the shared allowance. */
  async end() {
    if (this.remaining > 0 && this.bucket !== undefined) {
      await this.db
        .prepare('UPDATE ts_api_calls SET calls = MAX(0, calls - ?) WHERE bucket = ?')
        .run(this.remaining, this.bucket);
      this.remaining = 0;
    }
  }

  get callsMade() {
    return this.used;
  }

  /** Read-only guard: the single choke point for outbound TicketSource requests. */
  async request(method, pathOrUrl, params = {}) {
    if (method !== 'GET') throw new Error(`TicketSource is read-only in this application; refusing ${method}`);
    return this.#get(pathOrUrl, params);
  }

  /** GET a path (relative to the API) or an absolute `links.next` URL. */
  get(pathOrUrl, params = {}) {
    return this.request('GET', pathOrUrl, params);
  }

  async #get(pathOrUrl, params = {}) {
    if (this.remaining <= 0) throw new StepLimit('budget', 1000, 'Step call budget used');
    this.remaining--;
    this.used++;

    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`);
    if (url.origin !== new URL(this.apiUrl).origin) throw new Error('Refusing to call a non-TicketSource URL');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const res = await this.fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });

    if (res.status === 429) {
      const retryMs = parseRetryAfter(res.headers.get('retry-after'), this.now()) ?? 30_000;
      await setState(this.db, 'blocked_until', this.now() + retryMs);
      throw new StepLimit('rate_limited', retryMs, 'TicketSource rate limit hit');
    }

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || '';
      } catch {
        // non-JSON error body
      }
      const err = new Error(`TicketSource API error: ${res.status}${detail ? ` - ${detail}` : ''} (${url.pathname})`);
      err.status = res.status;
      throw err;
    }

    // Defensive: if the API reports an exhausted allowance, back off before the next call.
    const left = res.headers.get('x-ratelimit-remaining');
    if (left !== null && Number(left) <= 0) {
      const retryMs = parseRetryAfter(res.headers.get('retry-after'), this.now()) ?? 15_000;
      await setState(this.db, 'blocked_until', this.now() + retryMs);
    }

    return res.json();
  }

  /** Fetches every page of a list resource (follows links.next), up to maxPages. */
  async list(path, params = {}, maxPages = 50) {
    const items = [];
    let next = path;
    let query = { per_page: 100, ...params };
    for (let page = 0; next && page < maxPages; page++) {
      const body = await this.get(next, query);
      items.push(...(body.data || []));
      next = body.links?.next || null;
      query = {};
    }
    return items;
  }
}

export function parseRetryAfter(header, now = Date.now()) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(1, seconds) * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(1000, date - now);
}
