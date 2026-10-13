/**
 * Sales over time for one event (optionally one performance).
 *
 * - Bookings are attributed to their ORIGINAL creation date (Europe/London calendar, weeks start Monday), but their
 *   tickets and money are the CURRENT state (cancelled seats are gone; refund lines subtract). Not as-of-date history.
 * - Bookings without a creation date appear in whole-event totals but cannot be placed in a dated row; they are counted
 *   in `undated` so the page can disclose it.
 * - Download coverage: a period is `complete` (a zero is a confirmed zero), `partial`, or `none` (No data: not downloaded,
 *   so values are null, never 0).
 */
import { londonDay, periodsBetween, dayToIso } from './time.js';
import { addMoney, splitMoney, isComplete } from './data.js';

export const GROUPS = ['whole', 'daily', 'weekly', 'monthly'];

function blank() {
  return { tickets: 0, bookings: 0, money: {} };
}

function add(acc, b) {
  acc.tickets += b.tickets;
  acc.bookings += 1;
  addMoney(acc.money, b.money);
}

function finish(acc) {
  return { tickets: acc.tickets, bookings: acc.bookings, ...splitMoney(acc.money) };
}

/** How well the download covers a London-day range [startDay, endDay] for one performance. */
export function perfCoverage(perf, startDay, endDay, hasBookingsInRange) {
  if (!isComplete(perf)) return hasBookingsInRange ? 'partial' : 'none';
  const sync = londonDay(perf.last_synced_at);
  if (sync === null) return hasBookingsInRange ? 'partial' : 'none';
  if (endDay < sync) return 'complete';
  if (startDay > sync) return 'none';
  return 'partial';
}

export function combineCoverage(list) {
  if (list.length === 0) return 'none';
  if (list.every((c) => c === 'complete')) return 'complete';
  if (list.every((c) => c === 'none')) return 'none';
  return 'partial';
}

export function salesOverTime({ performances, bookings }, group = 'whole') {
  if (!GROUPS.includes(group)) throw new Error(`group must be one of ${GROUPS.join(', ')}`);

  const incomplete = performances.filter((p) => !isComplete(p));
  const currencies = new Set();
  const total = blank();
  let undated = 0;
  const dated = [];

  for (const b of bookings) {
    add(total, b);
    for (const c of Object.keys(b.money)) currencies.add(c);
    const day = londonDay(b.created);
    if (day === null) undated++;
    else dated.push({ ...b, day });
  }

  const base = {
    group,
    hasData: bookings.length > 0,
    performances: performances.length,
    incompletePerformances: incomplete.length,
    undated,
    currencies: [...currencies].sort(),
  };

  if (group === 'whole') {
    const coverage = bookings.length === 0 && incomplete.length > 0 ? 'none' : incomplete.length ? 'partial' : performances.length ? 'complete' : 'none';
    return {
      ...base,
      rows: [{ key: 'whole', label: 'Whole event', start: null, end: null, coverage, ...(coverage === 'none' ? nulls() : finish(total)) }],
      totals: finish(total),
    };
  }

  if (dated.length === 0) return { ...base, rows: [], totals: finish(total) };

  const minDay = Math.min(...dated.map((b) => b.day));
  const perfDays = performances.map((p) => londonDay(p.starts_at)).filter((d) => d !== null);
  const maxDay = Math.max(...dated.map((b) => b.day), ...perfDays);
  const periods = periodsBetween(group, minDay, maxDay);

  const rows = periods.map((p) => {
    const inPeriod = dated.filter((b) => b.day >= p.start && b.day <= p.end);
    const perfsWithData = new Set(inPeriod.map((b) => b.perf_id));
    const coverage = combineCoverage(performances.map((perf) => perfCoverage(perf, p.start, p.end, perfsWithData.has(perf.id))));
    const acc = blank();
    for (const b of inPeriod) add(acc, b);
    return {
      key: dayToIso(p.start),
      label: p.label,
      start: dayToIso(p.start),
      end: dayToIso(p.end),
      coverage,
      ...(coverage === 'none' ? nulls() : finish(acc)),
    };
  });

  return { ...base, rows, totals: finish(total) };
}

function nulls() {
  return { tickets: null, bookings: null, gross: null, net: null, donations: null };
}
