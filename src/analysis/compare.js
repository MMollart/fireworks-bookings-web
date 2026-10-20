/**
 * Compare two events by "days between each booking's creation date and its own performance start"
 * (Europe/London calendar days), so different sales campaigns line up on the same axis.
 *
 * Bookings missing a creation date or a performance start cannot be aligned: they are excluded and counted.
 * `cutoff` ("sales to date") keeps only bookings made at least that many days before their performance.
 * The comparison can be another event or the average across a set of events (`comparison: 'average'`).
 * Bands not covered by the download are `none` (null values: No data), never zero.
 */
import { londonDay } from './time.js';
import { addMoney, splitMoney, isComplete } from './data.js';
import { combineCoverage } from './sales.js';

export const COMPARE_GROUPS = ['whole', 'daily', 'weekly', 'band30'];
const SIZE = { daily: 1, weekly: 7, band30: 30 };

function bandKey(group, db) {
  if (group === 'whole') return 'all';
  if (db < 0) return 'after';
  return Math.floor(db / SIZE[group]);
}

function bandRange(group, key) {
  if (key === 'all') return { lo: -Infinity, hi: Infinity };
  if (key === 'after') return { lo: -Infinity, hi: -1 };
  const size = SIZE[group];
  return { lo: key * size, hi: key * size + size - 1 };
}

function bandLabel(group, key) {
  if (key === 'all') return 'Whole event';
  if (key === 'after') return 'After the performance';
  if (group === 'daily') return key === 0 ? 'Performance day' : `${key} day${key === 1 ? '' : 's'} before`;
  const { lo, hi } = bandRange(group, key);
  return `${lo}-${hi} days before`;
}

/** Aligns an event's bookings; returns per-band accumulations plus exclusion counts. */
function align(bookings, perfById, group, cutoff) {
  const bands = new Map();
  let excluded = 0;
  let included = 0;
  for (const b of bookings) {
    const created = londonDay(b.created);
    const start = londonDay(perfById.get(b.perf_id)?.starts_at);
    if (created === null || start === null) {
      excluded++;
      continue;
    }
    const db = start - created;
    if (cutoff !== null && db < cutoff) continue;
    included++;
    const key = bandKey(group, db);
    if (!bands.has(key)) bands.set(key, { tickets: 0, bookings: 0, money: {}, perfs: new Set() });
    const band = bands.get(key);
    band.tickets += b.tickets;
    band.bookings += 1;
    addMoney(band.money, b.money);
    band.perfs.add(b.perf_id);
  }
  return { bands, excluded, included };
}

/** Per performance: the days-before position of its last download (null when it cannot be placed). Computed once per event. */
function downloadPositions(perfs) {
  return perfs.map((p) => {
    const start = londonDay(p.starts_at);
    const sync = londonDay(p.last_synced_at);
    return { id: p.id, dbs: !isComplete(p) || start === null || sync === null ? null : start - sync };
  });
}

/** Coverage of a daysBefore band [lo, hi] for an event's performances. */
function coverage(positions, group, key, hasDataPerfs) {
  const { lo, hi } = bandRange(group, key);
  return combineCoverage(
    positions.map(({ id, dbs }) => {
      if (dbs === null) return hasDataPerfs.has(id) ? 'partial' : 'none';
      if (lo > dbs) return 'complete';
      if (hi < dbs) return 'none';
      return 'partial';
    })
  );
}

function values(band) {
  return band ? { tickets: band.tickets, bookings: band.bookings, ...splitMoney(band.money) } : { tickets: 0, bookings: 0, gross: {}, net: {} };
}

export function summariseEvent(data, group, cutoff) {
  const perfById = new Map(data.performances.map((p) => [p.id, p]));
  const aligned = align(data.bookings, perfById, group, cutoff);
  return { ...aligned, performances: data.performances, positions: downloadPositions(data.performances) };
}

const diffMoney = (a, b) => {
  const out = {};
  for (const c of new Set([...Object.keys(a), ...Object.keys(b)])) out[c] = Math.round(((a[c] ?? 0) - (b[c] ?? 0)) * 100) / 100;
  return out;
};

function bandSide(summary, group, key) {
  const band = summary.bands.get(key);
  const cov = coverage(summary.positions, group, key, band ? band.perfs : new Set());
  return cov === 'none' ? { coverage: cov, tickets: null, bookings: null, gross: null, net: null } : { coverage: cov, ...values(band) };
}

function difference(a, b) {
  if (a.coverage === 'none' || b.coverage === 'none') return null;
  return { tickets: a.tickets - b.tickets, bookings: a.bookings - b.bookings, gross: diffMoney(a.gross, b.gross), net: diffMoney(a.net, b.net) };
}

const NO_AVERAGE = { coverage: 'none', events: 0, tickets: null, bookings: null, gross: null, net: null };

/**
 * selected / comparison: { performances, bookings } loaders' output, or comparison = 'average' to compare with the average
 * across `others`. others: [{ id, name, data }] used for the average.
 */
export function compareEvents({ selected, comparison, others = [], group = 'whole', cutoff = null, includeAverage = false }) {
  if (!COMPARE_GROUPS.includes(group)) throw new Error(`group must be one of ${COMPARE_GROUPS.join(', ')}`);
  const versusAverage = comparison === 'average';
  const needAverage = includeAverage || versusAverage;

  const sel = summariseEvent(selected, group, cutoff);
  const avgEvents = needAverage ? others.map((o) => summariseEvent(o.data, group, cutoff)) : [];
  const cmp = versusAverage ? null : summariseEvent(comparison, group, cutoff);

  const keys = new Set(sel.bands.keys());
  for (const s of cmp ? [cmp, ...avgEvents] : avgEvents) for (const k of s.bands.keys()) keys.add(k);
  if (group === 'whole') keys.add('all');

  const numeric = [...keys].filter((k) => typeof k === 'number');
  if (group !== 'whole' && numeric.length) {
    // fill gaps so a missing band is shown as zero or No data rather than silently skipped
    for (let k = Math.min(...numeric); k <= Math.max(...numeric); k++) keys.add(k);
  }
  const ordered = [...keys].sort((a, b) => (a === 'after' ? 1 : b === 'after' ? -1 : typeof a === 'string' ? 0 : b - a));

  const rows = ordered.map((key) => {
    const selected = bandSide(sel, group, key);
    let average = null;
    if (needAverage) {
      const sides = avgEvents.map((e) => bandSide(e, group, key)).filter((s) => s.coverage !== 'none');
      average = sides.length ? averageOf(sides) : NO_AVERAGE;
    }
    const comparison = versusAverage ? average : bandSide(cmp, group, key);
    return {
      key: String(key),
      label: bandLabel(group, key),
      selected,
      comparison,
      average: includeAverage && !versusAverage ? average : null,
      difference: difference(selected, comparison),
    };
  });

  const total = (s) => {
    const acc = { tickets: 0, bookings: 0, money: {} };
    for (const b of s.bands.values()) {
      acc.tickets += b.tickets;
      acc.bookings += b.bookings;
      addMoney(acc.money, b.money);
    }
    const cov = combineCoverage(s.performances.map((p) => (isComplete(p) ? 'complete' : 'partial')));
    return { coverage: cov, tickets: acc.tickets, bookings: acc.bookings, ...splitMoney(acc.money) };
  };
  const averageTotal = () => (avgEvents.length ? averageOf(avgEvents.map(total)) : NO_AVERAGE);
  const totals = { selected: total(sel), comparison: versusAverage ? averageTotal() : total(cmp) };
  totals.difference = difference(totals.selected, totals.comparison);

  const currencies = new Set();
  for (const r of rows) for (const side of [r.selected, r.comparison]) for (const m of [side.gross, side.net]) Object.keys(m ?? {}).forEach((c) => currencies.add(c));

  const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
  const incomplete = (s) => s.performances.filter((p) => !isComplete(p)).length;
  const cmpExcluded = versusAverage ? sum(avgEvents, (e) => e.excluded) : cmp.excluded;
  return {
    group,
    cutoff,
    includeAverage: includeAverage && !versusAverage,
    versusAverage,
    currencies: [...currencies].sort(),
    rows,
    totals,
    excluded: { selected: sel.excluded, comparison: cmpExcluded, total: sel.excluded + cmpExcluded },
    incomplete: {
      selected: incomplete(sel),
      comparison: versusAverage ? sum(avgEvents, incomplete) : incomplete(cmp),
    },
    averageEvents: needAverage ? avgEvents.length : 0,
  };
}

function averageOf(sides) {
  const n = sides.length;
  const avg = (key) => Math.round((sides.reduce((s, x) => s + x[key], 0) / n) * 100) / 100;
  const avgMoney = (key) => {
    const out = {};
    for (const c of new Set(sides.flatMap((s) => Object.keys(s[key])))) out[c] = Math.round((sides.reduce((s, x) => s + (x[key][c] ?? 0), 0) / n) * 100) / 100;
    return out;
  };
  return { coverage: 'complete', events: n, tickets: avg('tickets'), bookings: avg('bookings'), gross: avgMoney('gross'), net: avgMoney('net') };
}
