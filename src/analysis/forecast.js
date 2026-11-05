/**
 * Sell-out forecast: when will the selected (upcoming) event reach its ticket capacity (default 10,000), and at what
 * time of day?
 *
 * DAY LEVEL. Every booking is placed on a "days before its own performance" axis (Europe/London days), as in Compare
 * events, so each past year gives a cumulative ticket curve T_y(d) = tickets booked at least d days before the
 * performance. The forecast is projected from the end of yesterday (the last complete day, Nb = days-to-go + 1) so a
 * half-finished today does not drag it down. For every completed past year y it builds two scenarios:
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
 * SALES SWITCHED OFF EARLY. Sales are often turned off before capacity (around 9,500 of 10,000). A past year counts as
 * switched off when it sold at least CLOSED_SHARE of capacity and its last booking was more than an hour before the
 * performance. Its curve would otherwise stop rising at that point and understate demand, so the forecast always runs
 * to full capacity:
 *  - switched off on the performance day: the rest of that day is continued at the rate it was selling in the two
 *    hours before it closed (and the time it would have reached capacity is reported);
 *  - switched off on an earlier day: the curve is continued with the median growth of the years that were not.
 *
 * TIME OF DAY. When the sell-out is forecast for the performance day, each past year's performance-day sales by clock
 * time (Europe/London, 15-minute steps, extended at its closing rate if it was switched off) is scaled to this year:
 *  - before the day, by the size of this year's projected total at the start of the day vs that year's;
 *  - on the day, by this year's sales so far today vs that year's by the same time (once there are enough to go on).
 * The time is when the projected total passes capacity: median, earliest and latest across the past years.
 *
 * PACE. Recent pace (tickets a day over the last 7 / 14 complete days) is compared with past years over the same 7
 * days before their performance, and the forecast gives the expected pace ahead (next 7 days, final 3 days), so the
 * late surge every year has is expected rather than read as falling behind. Daily figures per scenario feed the
 * tickets-per-day chart view.
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
export const CLOSED_SHARE = 0.9; // sold at least this share of capacity and then stopped: treated as switched off
const CLOSED_GAP_MS = 60 * 60_000; // ...with no booking in the last hour before the performance
const CLOSING_RATE_MINUTES = 120; // closing rate measured over the two hours before sales stopped
const SLOT = 15; // minutes per step in the performance-day profile
const MIN_DAY_TICKETS = 50; // on the day, below this many of a past year's tickets by "now", scale by size instead

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, dp = 0) => (n === null || n === undefined ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const isoAt = (ms) => new Date(Math.round(ms / 60_000) * 60_000).toISOString();

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Minutes since London midnight for an epoch ms. */
export function londonMinutes(ms) {
  const p = Object.fromEntries(clock.formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return p.hour * 60 + p.minute;
}

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
 * Performance-day sales by London clock time. grid[i] = tickets booked on the performance day by minute i * SLOT
 * after midnight. Also the first performance's start, and the time of the last booking.
 */
export function dayProfile(data) {
  const meta = new Map();
  for (const p of data.performances) {
    const s = Date.parse(p.starts_at);
    if (Number.isFinite(s)) meta.set(p.id, { startMs: s, day: londonDay(s), midnight: s - londonMinutes(s) * 60_000 });
  }
  if (!meta.size) return null;
  const first = [...meta.values()].sort((a, b) => a.startMs - b.startMs)[0];
  const sales = [];
  let lastMs = null;
  for (const b of data.bookings) {
    const c = Date.parse(b.created);
    if (!Number.isFinite(c)) continue;
    if (lastMs === null || c > lastMs) lastMs = c;
    const m = meta.get(b.perf_id);
    if (m && londonDay(c) === m.day) sales.push({ minute: (c - m.midnight) / 60_000, tickets: b.tickets });
  }
  const slots = Math.ceil((24 * 60) / SLOT) + 1;
  const grid = new Array(slots + 1).fill(0);
  for (const s of sales) grid[Math.min(slots, Math.max(0, Math.ceil(s.minute / SLOT)))] += s.tickets;
  for (let i = 1; i <= slots; i++) grid[i] += grid[i - 1];
  return { startMs: first.startMs, midnight: first.midnight, startMinute: (first.startMs - first.midnight) / 60_000, grid, sales, lastMs };
}

/** Tickets booked on the performance day by minute t (linear between steps), continued at the closing rate if closed. */
function dayTickets(profile, t, closed = null) {
  if (closed && closed.minute !== undefined && t > closed.minute) return dayTickets(profile, closed.minute) + (closed.ratePerHour / 60) * (t - closed.minute);
  const x = Math.max(0, t / SLOT);
  const i = Math.floor(x);
  if (i + 1 >= profile.grid.length) return profile.grid[profile.grid.length - 1];
  return profile.grid[i] + (profile.grid[i + 1] - profile.grid[i]) * (x - i);
}

/** Did a past event switch sales off early? { at, tickets, daysBefore, minute?, ratePerHour?, reachesCapacityAt? } or null. */
export function salesClosure(curve, profile, capacity) {
  if (!profile || profile.lastMs === null || curve.totalTickets < CLOSED_SHARE * capacity) return null;
  if (profile.lastMs >= profile.startMs - CLOSED_GAP_MS) return null;
  const daysBefore = londonDay(profile.startMs) - londonDay(profile.lastMs);
  const out = { at: isoAt(profile.lastMs), tickets: curve.totalTickets, daysBefore };
  if (daysBefore === 0) {
    const minute = (profile.lastMs - profile.midnight) / 60_000;
    const recent = profile.sales.filter((s) => s.minute > minute - CLOSING_RATE_MINUTES && s.minute <= minute).reduce((n, s) => n + s.tickets, 0);
    out.minute = minute;
    out.ratePerHour = round((recent / CLOSING_RATE_MINUTES) * 60, 1);
    out.reachesCapacityAt = out.ratePerHour > 0 && curve.totalTickets < capacity ? isoAt(profile.lastMs + ((capacity - curve.totalTickets) / out.ratePerHour) * 3_600_000) : null;
  }
  return out;
}

/**
 * Continues the curves of past years whose sales were switched off before the performance day, past that point, with
 * the median growth of the years that were not. Returns a function giving T_y(d) for any d >= 0.
 */
function curveReaders(refs) {
  const open = refs.filter((r) => r.stoppedAt === null);
  return new Map(
    refs.map((r) => {
      if (r.stoppedAt === null || open.length === 0) return [r.id, (d) => at(r.curve.cumT, d)];
      const s = r.stoppedAt;
      const base = at(r.curve.cumT, s);
      const growth = new Map();
      const read = (d) => {
        if (d >= s) return at(r.curve.cumT, d);
        if (!growth.has(d)) {
          const g = median(open.map((u) => (at(u.curve.cumT, s) > 0 ? at(u.curve.cumT, d) / at(u.curve.cumT, s) : NaN)));
          growth.set(d, g ?? 1);
        }
        return Math.max(at(r.curve.cumT, d), base * growth.get(d));
      };
      return [r.id, read];
    })
  );
}

/** First day (counting down from `from` to 0) a projection reaches capacity, or null. */
function sellOutDay(values, from, capacity) {
  for (let d = from; d >= 0; d--) if (values[d] >= capacity) return d;
  return null;
}

/** First minute in `times` at which a curve reaches capacity (interpolated between steps), or null. */
function crossing(times, values, capacity) {
  for (let i = 0; i < times.length; i++) {
    if (values[i] === null || values[i] < capacity) continue;
    if (i === 0 || values[i - 1] === null) return times[i];
    const f = (capacity - values[i - 1]) / (values[i] - values[i - 1]);
    return times[i - 1] + f * (times[i] - times[i - 1]);
  }
  return null;
}

/**
 * Time of day on the performance day. scenarios: [{ ref, start }] where start = projected tickets at the start of the
 * day (before the day) or null (on the day: actual sales so far are used).
 */
function performanceDayForecast({ cur, profile, scenarios, onTheDay, now, capacity }) {
  const end = profile.startMinute;
  let nowMinute = onTheDay ? Math.min(end, Math.max(0, (now - profile.midnight) / 60_000)) : 0;
  let salesClosed = null;
  if (onTheDay && profile.lastMs !== null && cur.totalTickets >= CLOSED_SHARE * capacity && profile.lastMs < now - CLOSED_GAP_MS) {
    // This year's sales have been switched off: carry on from the moment they stopped.
    salesClosed = { at: isoAt(profile.lastMs), tickets: cur.totalTickets };
    nowMinute = Math.min(nowMinute, Math.max(0, (profile.lastMs - profile.midnight) / 60_000));
  }
  const times = [];
  for (let t = Math.ceil(nowMinute / SLOT) * SLOT; t < end; t += SLOT) times.push(t);
  times.push(end);
  if (onTheDay && times[0] !== nowMinute) times.unshift(nowMinute);

  const startOfDay = cur.undatedTickets + at(cur.cumT, 1);
  const soFar = dayTickets(profile, nowMinute); // this year's performance-day tickets by "now"
  const curves = [];
  for (const s of scenarios) {
    const r = s.ref;
    const D = (t) => dayTickets(r.profile, t, r.closed);
    const tY = at(r.curve.cumT, 1) + r.curve.undatedTickets;
    if (!(D(end) > 0) || !(tY > 0)) continue;
    let values;
    if (onTheDay) {
      const Dn = D(nowMinute);
      const k = Dn >= MIN_DAY_TICKETS ? soFar / Dn : startOfDay / tY;
      values = times.map((t) => Math.max(cur.totalTickets, cur.totalTickets + k * (D(t) - Dn)));
    } else {
      const k = s.start / tY;
      values = times.map((t) => s.start + k * D(t));
    }
    curves.push({ ref: r, values, minute: crossing(times, values, capacity) });
  }
  if (!curves.length) return null;

  const pointwise = (fn) => times.map((_, i) => fn(curves.map((c) => c.values[i])));
  const central = pointwise(median);
  const low = pointwise((xs) => Math.min(...xs));
  const high = pointwise((xs) => Math.max(...xs));
  const when = (m) => (m === null ? null : isoAt(profile.midnight + m * 60_000));

  // Chart rows for the performance day: actual so far (on the day), then the forecast to the performance.
  const rows = [];
  const lastActual = onTheDay ? nowMinute : -1;
  for (let t = 0; t < end; t += SLOT) {
    if (t <= lastActual && !times.includes(t)) rows.push({ time: when(t), actual: Math.round(startOfDay + dayTickets(profile, t)), central: null, low: null, high: null });
  }
  times.forEach((t, i) => {
    rows.push({
      time: when(t),
      actual: onTheDay && t <= lastActual ? Math.round(startOfDay + dayTickets(profile, t)) : null,
      central: Math.round(central[i]),
      low: Math.round(low[i]),
      high: Math.round(high[i]),
    });
  });

  return {
    basis: onTheDay ? 'today' : 'projected',
    performanceStart: isoAt(profile.startMs),
    time: when(crossing(times, central, capacity)),
    earliest: when(crossing(times, high, capacity)),
    latest: when(crossing(times, low, capacity)),
    selling: curves.filter((c) => c.minute !== null).length,
    pastYears: curves.length,
    salesClosed,
    rows,
  };
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
    closedShare: CLOSED_SHARE,
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
      salesClosed: salesClosure(cur, dayProfile(target.data), capacity),
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
  const incomplete = [];
  const refs = [];
  for (const e of events.filter((x) => x.id !== selectedId)) {
    const curve = eventCurve(e.data);
    if (!curve.hasDated || !curve.perfDays.length || Math.max(...curve.perfDays) >= today) continue;
    if (e.data.performances.some((p) => !isComplete(p))) {
      incomplete.push(e.label);
      continue;
    }
    const profile = dayProfile(e.data);
    const closed = salesClosure(curve, profile, capacity);
    const soldDated = at(curve.cumT, 0); // actual tickets, before any extension
    if (closed && closed.daysBefore === 0 && closed.ratePerHour > 0) {
      // Switched off on the day: carry the rest of the day on at the closing rate, so its final total is what it would
      // have sold rather than where it was stopped.
      curve.cumT = [...curve.cumT];
      curve.cumT[0] = at(curve.cumT, 1) + dayTickets(profile, profile.startMinute, closed);
    }
    refs.push({ id: e.id, label: e.label, year: eventYear(e.firstStart), curve, profile, closed, soldDated, stoppedAt: closed && closed.daysBefore > 0 ? closed.daysBefore : null });
  }
  refs.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  const readers = curveReaders(refs);

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
    const lateT = r.soldDated - at(r.curve.cumT, Nb);
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
      extendedFinal: Math.round(r.curve.undatedTickets + T(0)),
      atThisPoint: r.curve.undatedTickets + at(r.curve.cumT, Nb),
      shareAtThisPoint: finalT ? round((r.curve.undatedTickets + at(r.curve.cumT, Nb)) / finalT, 4) : null,
      sameWindow: round(window, 2),
      ticketsPerBookingAtThisPoint: bAt ? round(at(r.curve.cumT, Nb) / bAt, 2) : null,
      ticketsPerBookingLater: lateB ? round(lateT / lateB, 2) : null,
      paceAtThisPoint: round((tAt - T(Nb + 7)) / 7, 1),
      paceFinalDays: round((T(0) - T(Math.min(3, Nb))) / Math.min(3, Nb), 1),
      closed: r.closed ? { at: r.closed.at, tickets: r.closed.tickets, daysBefore: r.closed.daysBefore, ratePerHour: r.closed.ratePerHour ?? null, reachesCapacityAt: r.closed.reachesCapacityAt ?? null } : null,
      share: null,
      momentum: null,
    };
    if (tAt > 0 && baseT > 0) {
      const values = project((d) => (baseT * T(d)) / tAt);
      const sd = sellOutDay(values, N, capacity);
      out.share = { final: Math.round(values[0]), sellOut: sd === null ? null : { date: dayToIso(perfDay - sd), daysBefore: sd } };
      scenarios.push({ ref: r, values, sellOut: sd });
    }
    if (window > 0) {
      const k = recentT / window;
      const values = project((d) => baseT + k * (T(d) - tAt));
      const sd = sellOutDay(values, N, capacity);
      out.momentum = { final: Math.round(values[0]), ratio: round(k, 2), sellOut: sd === null ? null : { date: dayToIso(perfDay - sd), daysBefore: sd } };
      scenarios.push({ ref: r, values, sellOut: sd });
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
      scenarios.push({ ref: null, values, sellOut: sellOutDay(values, N, capacity) });
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
    timeOfDay: null,
  };

  // Time of day, when the sell-out falls on the performance day (or the performance is today).
  const profile = dayProfile(target.data);
  if (!alreadySoldOut && profile && method === 'history' && (N === 0 || forecast.sellOut?.daysBefore === 0)) {
    const dayScenarios =
      N === 0 ? refs.filter((r) => r.profile).map((r) => ({ ref: r, start: null })) : scenarios.filter((s) => s.ref && s.ref.profile).map((s) => ({ ref: s.ref, start: s.values[1] }));
    forecast.timeOfDay = performanceDayForecast({ cur, profile, scenarios: dayScenarios, onTheDay: N === 0, now, capacity });
  }

  // Pace, learned from past years: how this year's last week compares with theirs, and what the forecast expects ahead.
  const startT = offset + baseT; // end of yesterday
  const daily = scenarios.map((sc) => {
    const v = [];
    for (let d = 0; d <= N; d++) v[d] = sc.values[d] - (d === N ? startT : sc.values[d + 1]);
    return v;
  });
  const dailyAt = (fn) => (daily.length ? Array.from({ length: N + 1 }, (_, d) => fn(daily.map((v) => v[d]))) : null);
  const dailyCentral = dailyAt(median);
  const dailyLow = dailyAt((xs) => Math.min(...xs));
  const dailyHigh = dailyAt((xs) => Math.max(...xs));
  const pastSameWeek = median(references.map((r) => r.paceAtThisPoint));
  pace.pastSameWeek = round(pastSameWeek, 1);
  pace.vsPast = pastSameWeek ? round(pace.last7 / pastSameWeek - 1, 3) : null;
  pace.pastUptick = round(median(references.map((r) => (r.paceAtThisPoint > 0 ? r.paceFinalDays / r.paceAtThisPoint : NaN))), 1);
  if (central) {
    const k7 = Math.min(7, N + 1);
    const k3 = Math.min(3, N + 1);
    pace.expectedNext7 = { days: k7, perDay: round((central[N - k7 + 1] - startT) / k7, 1) };
    pace.expectedFinal = { days: k3, perDay: round((central[0] - (k3 === N + 1 ? startT : central[k3])) / k3, 1) };
  } else {
    pace.expectedNext7 = null;
    pace.expectedFinal = null;
  }

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
      dailyActual: d > N ? at(cur.cumT, d) - at(cur.cumT, d + 1) : d === N ? pace.today : null,
      dailyCentral: dailyCentral && d <= N ? Math.round(dailyCentral[d]) : null,
      dailyLow: dailyLow && d <= N ? Math.round(dailyLow[d]) : null,
      dailyHigh: dailyHigh && d <= N ? Math.round(dailyHigh[d]) : null,
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
