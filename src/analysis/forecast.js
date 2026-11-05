/**
 * Sell-out forecast: when will the selected (upcoming) event reach its ticket capacity (default 10,000)?
 *
 * Every booking is placed on a "days before its own performance" axis (Europe/London days), as in Compare events, so
 * each past year gives a cumulative ticket curve T_y(d) = tickets booked at least d days before the performance.
 *
 * The forecast is projected from the end of yesterday (the last complete day, Nb = days-to-go + 1) so a half-finished
 * today does not drag it down. For every completed past year y it builds two scenarios:
 *
 *  - Share of sales ("curve"): this year sells the same share of its final total by each point as year y did.
 *      proj(d) = base * T_y(d) / T_y(Nb)
 *  - Momentum: this year's last 14 days are compared with year y's same 14 days, and the rest of the campaign is
 *    scaled by that ratio, so a recent surge (or slow-down) carries forward.
 *      proj(d) = base + k * (T_y(d) - T_y(Nb)),  k = this year's last 14 days / year y's same 14 days
 *
 * The central forecast is the median of all scenarios at each day; the range is their lowest and highest. The
 * "likelihood" is how many scenarios reach capacity before the performance. With no completed past year, the
 * forecast falls back to the recent daily pace held steady.
 *
 * A past year that itself sold out has a curve that stops rising at its sell-out point, which would understate later
 * demand. Past that point its curve is continued with the median growth of the years that did not sell out.
 *
 * Tickets per booking: the share-of-sales scenario is the same whether projected through bookings x tickets per booking
 * or through tickets directly (the two cancel), so tickets per booking is used to turn the remaining tickets into the
 * number of bookings still needed, allowing for later bookings being larger or smaller as they were in past years.
 *
 * Bookings without a creation date count towards tickets sold but cannot be placed on the curve.
 */
import { londonDay, dayToIso } from './time.js';
import { isComplete } from './data.js';
import { eventYear } from '../lib/eventName.js';

export const DEFAULT_CAPACITY = 10000;
export const MOMENTUM_DAYS = 14;

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, dp = 0) => (n === null || n === undefined ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * An event's bookings on the days-before axis. cumT[d] / cumB[d] = tickets / bookings booked at least d days before
 * their performance (d >= 0). Bookings after the performance and undated bookings are only in the totals.
 */
export function eventCurve(data) {
  const perfDay = new Map(data.performances.map((p) => [p.id, londonDay(p.starts_at)]));
  const tickets = new Map();
  const bookings = new Map();
  let maxDb = 0;
  let totalTickets = 0;
  let totalBookings = 0;
  let undatedTickets = 0;
  for (const b of data.bookings) {
    totalTickets += b.tickets;
    totalBookings += 1;
    const created = londonDay(b.created);
    const start = perfDay.get(b.perf_id);
    if (created === null || start === null || start === undefined) {
      undatedTickets += b.tickets;
      continue;
    }
    const db = start - created;
    if (db < 0) continue;
    tickets.set(db, (tickets.get(db) || 0) + b.tickets);
    bookings.set(db, (bookings.get(db) || 0) + 1);
    if (db > maxDb) maxDb = db;
  }
  const cumT = new Array(maxDb + 2).fill(0);
  const cumB = new Array(maxDb + 2).fill(0);
  for (let d = maxDb; d >= 0; d--) {
    cumT[d] = cumT[d + 1] + (tickets.get(d) || 0);
    cumB[d] = cumB[d + 1] + (bookings.get(d) || 0);
  }
  const perfDays = [...perfDay.values()].filter((d) => d !== null);
  return { cumT, cumB, maxDb, totalTickets, totalBookings, undatedTickets, perfDays, hasDated: tickets.size > 0 };
}

const at = (cum, d) => (d < 0 ? cum[0] ?? 0 : d >= cum.length ? 0 : cum[d]);

/** Largest days-before at which the cumulative curve reached `capacity` (i.e. the sell-out point), or null. */
export function soldOutAt(cum, capacity) {
  for (let d = cum.length - 1; d >= 0; d--) if (cum[d] >= capacity) return d;
  return null;
}

/**
 * Continues the curves of past years that sold out, past their sell-out point, with the median growth of the years
 * that did not. Returns a function giving T_y(d) for any d >= 0.
 */
function curveReaders(refs, capacity) {
  const uncapped = refs.filter((r) => r.soldOutAt === null);
  return new Map(
    refs.map((r) => {
      if (r.soldOutAt === null || uncapped.length === 0) return [r.id, (d) => at(r.curve.cumT, d)];
      const s = r.soldOutAt;
      const base = at(r.curve.cumT, s);
      const growth = new Map();
      const read = (d) => {
        if (d >= s) return at(r.curve.cumT, d);
        if (!growth.has(d)) {
          const g = median(uncapped.map((u) => (at(u.curve.cumT, s) > 0 ? at(u.curve.cumT, d) / at(u.curve.cumT, s) : NaN)));
          growth.set(d, g ?? 1);
        }
        return Math.max(at(r.curve.cumT, d), base * growth.get(d));
      };
      return [r.id, read];
    })
  );
}

/** First day (counting down from `from` to 0) a projection reaches capacity: { daysBefore } or null. */
function sellOutDay(values, from, capacity) {
  for (let d = from; d >= 0; d--) if (values[d] >= capacity) return d;
  return null;
}

/**
 * events: [{ id, label, firstStart, data: { performances, bookings } }] (every event with bookings, including the
 * selected one). Returns everything the Forecast view shows.
 */
export function forecastSellOut({ events, selectedId, capacity = DEFAULT_CAPACITY, now = Date.now() }) {
  const today = londonDay(now);
  const target = events.find((e) => e.id === selectedId);
  if (!target) throw new Error('Unknown event');
  const cur = eventCurve(target.data);
  const upcoming = cur.perfDays.filter((d) => d >= today).sort((a, b) => a - b);
  const lastPerf = cur.perfDays.length ? Math.max(...cur.perfDays) : null;
  const sold = {
    tickets: cur.totalTickets,
    bookings: cur.totalBookings,
    ticketsPerBooking: cur.totalBookings ? round(cur.totalTickets / cur.totalBookings, 2) : null,
    share: round(cur.totalTickets / capacity, 4),
  };
  const base = {
    capacity,
    today: dayToIso(today),
    sold,
    remaining: Math.max(0, capacity - cur.totalTickets),
    undatedTickets: cur.undatedTickets,
    incompleteSelected: target.data.performances.filter((p) => !isComplete(p)).length,
  };

  const soldOutDate = (curve, perfDay) => {
    const d = soldOutAt(curve.cumT, capacity - curve.undatedTickets);
    return d === null || perfDay === null ? null : { date: dayToIso(perfDay - d), daysBefore: d };
  };

  if (!upcoming.length) {
    // The performance has happened (or has no date): report the outcome rather than a forecast.
    return {
      ...base,
      status: lastPerf === null ? 'no_date' : 'past',
      performanceDate: lastPerf === null ? null : dayToIso(lastPerf),
      soldOut: cur.totalTickets >= capacity ? soldOutDate(cur, lastPerf) ?? { date: null, daysBefore: null } : null,
      references: [],
      rows: [],
    };
  }

  const perfDay = upcoming[0];
  const N = perfDay - today; // days to go (0 = the performance is today)
  const Nb = N + 1; // end of yesterday, the last complete day
  const daysLeft = N + 1; // selling days left, today and performance day included

  // Recent pace (complete days only).
  const lastDays = (n) => at(cur.cumT, Nb) - at(cur.cumT, Nb + n);
  const pace = {
    last7: round(lastDays(7) / 7, 1),
    last14: round(lastDays(MOMENTUM_DAYS) / MOMENTUM_DAYS, 1),
    required: round(base.remaining / daysLeft, 1),
    today: cur.totalTickets - cur.undatedTickets - at(cur.cumT, Nb),
  };

  // Completed past years: every performance before today and fully downloaded.
  const candidates = events.filter((e) => e.id !== selectedId);
  const incomplete = [];
  const refs = [];
  for (const e of candidates) {
    const curve = eventCurve(e.data);
    if (!curve.hasDated || !curve.perfDays.length || Math.max(...curve.perfDays) >= today) continue;
    if (e.data.performances.some((p) => !isComplete(p))) {
      incomplete.push(e.label);
      continue;
    }
    refs.push({ id: e.id, label: e.label, year: eventYear(e.firstStart), curve, soldOutAt: soldOutAt(curve.cumT, capacity - curve.undatedTickets) });
  }
  refs.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  const readers = curveReaders(refs, capacity);

  const baseT = at(cur.cumT, Nb); // dated tickets up to the end of yesterday
  const recentT = baseT - at(cur.cumT, Nb + MOMENTUM_DAYS);
  const floor = cur.totalTickets; // a projection never goes below what is already sold
  const offset = cur.undatedTickets;

  const scenarios = [];
  const references = refs.map((r) => {
    const T = readers.get(r.id);
    const tAt = T(Nb);
    const window = tAt - T(Nb + MOMENTUM_DAYS);
    const bAt = at(r.curve.cumB, Nb);
    const finalT = r.curve.totalTickets;
    const lateT = at(r.curve.cumT, 0) - at(r.curve.cumT, Nb);
    const lateB = at(r.curve.cumB, 0) - bAt;
    const project = (fn) => {
      const values = [];
      for (let d = 0; d <= N; d++) values[d] = Math.max(floor, offset + fn(d));
      return values;
    };
    const out = {
      id: r.id,
      label: r.label,
      year: r.year,
      final: finalT,
      atThisPoint: r.curve.undatedTickets + at(r.curve.cumT, Nb),
      shareAtThisPoint: finalT ? round((r.curve.undatedTickets + at(r.curve.cumT, Nb)) / finalT, 4) : null,
      sameWindow: round(window, 2),
      ticketsPerBookingAtThisPoint: bAt ? round(at(r.curve.cumT, Nb) / bAt, 2) : null,
      ticketsPerBookingLater: lateB ? round(lateT / lateB, 2) : null,
      soldOut: r.soldOutAt === null ? null : { daysBefore: r.soldOutAt },
      share: null,
      momentum: null,
    };
    if (tAt > 0 && baseT > 0) {
      const values = project((d) => (baseT * T(d)) / tAt);
      const sd = sellOutDay(values, N, capacity);
      out.share = { final: Math.round(values[0]), sellOut: sd === null ? null : { date: dayToIso(perfDay - sd), daysBefore: sd } };
      scenarios.push({ values, sellOut: sd });
    }
    if (window > 0) {
      const k = recentT / window;
      const values = project((d) => baseT + k * (T(d) - tAt));
      const sd = sellOutDay(values, N, capacity);
      out.momentum = { final: Math.round(values[0]), ratio: round(k, 2), sellOut: sd === null ? null : { date: dayToIso(perfDay - sd), daysBefore: sd } };
      scenarios.push({ values, sellOut: sd });
    }
    return out;
  });

  let method = 'history';
  if (!scenarios.length) {
    // No usable history: hold the recent pace steady (last 14 days, else last 7, else nothing to go on).
    const rate = pace.last14 || pace.last7 || 0;
    method = rate > 0 ? 'pace' : 'none';
    if (rate > 0) {
      const values = [];
      for (let d = 0; d <= N; d++) values[d] = Math.max(floor, offset + baseT + rate * (Nb - d));
      scenarios.push({ values, sellOut: sellOutDay(values, N, capacity) });
    }
  }

  const pointwise = (fn) => {
    const v = [];
    for (let d = 0; d <= N; d++) v[d] = fn(scenarios.map((s) => s.values[d]));
    return v;
  };
  const central = scenarios.length ? pointwise(median) : null;
  const low = scenarios.length ? pointwise((xs) => Math.min(...xs)) : null;
  const high = scenarios.length ? pointwise((xs) => Math.max(...xs)) : null;
  const dateOf = (sd) => (sd === null ? null : { date: dayToIso(perfDay - sd), daysBefore: sd });

  const alreadySoldOut = cur.totalTickets >= capacity;
  const forecast = {
    method,
    scenarios: scenarios.length,
    sellOut: alreadySoldOut ? null : central ? dateOf(sellOutDay(central, N, capacity)) : null,
    earliest: alreadySoldOut || !high ? null : dateOf(sellOutDay(high, N, capacity)),
    latest: alreadySoldOut || !low ? null : dateOf(sellOutDay(low, N, capacity)),
    selling: scenarios.filter((s) => s.sellOut !== null).length,
    projectedFinal: central ? { central: Math.round(central[0]), low: Math.round(low[0]), high: Math.round(high[0]) } : null,
  };

  // Tickets per booking: later bookings tend to differ in size from earlier ones; carry past years' ratio forward.
  const tpbNow = baseT && at(cur.cumB, Nb) ? baseT / at(cur.cumB, Nb) : sold.ticketsPerBooking;
  const lateRatio = median(references.map((r) => (r.ticketsPerBookingAtThisPoint && r.ticketsPerBookingLater ? r.ticketsPerBookingLater / r.ticketsPerBookingAtThisPoint : NaN)));
  const tpbLater = tpbNow ? tpbNow * (lateRatio ?? 1) : null;
  const bookingsNeeded = {
    ticketsPerBooking: round(tpbLater, 2),
    adjusted: lateRatio !== null,
    bookings: tpbLater ? Math.ceil(base.remaining / tpbLater) : null,
  };

  // Chart rows: this year's actual cumulative tickets up to today, then the forecast to the performance.
  const rows = [];
  const firstDb = Math.max(cur.maxDb, N);
  for (let d = firstDb; d >= 0; d--) {
    const actual = d > N ? offset + at(cur.cumT, d) : d === N ? cur.totalTickets : null;
    rows.push({
      date: dayToIso(perfDay - d),
      daysBefore: d,
      actual,
      central: central && d <= N ? Math.round(central[d]) : null,
      low: low && d <= N ? Math.round(low[d]) : null,
      high: high && d <= N ? Math.round(high[d]) : null,
    });
  }

  return {
    ...base,
    status: alreadySoldOut ? 'sold_out' : 'forecast',
    performanceDate: dayToIso(perfDay),
    daysToGo: N,
    soldOut: alreadySoldOut ? soldOutDate(cur, perfDay) ?? { date: dayToIso(today), daysBefore: N } : null,
    pace,
    forecast,
    bookingsNeeded,
    references,
    incompleteReferences: incomplete,
    rows,
  };
}
