import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { forecastSellOut, eventCurve, soldOutAt } from '../src/analysis/forecast.js';

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * An event with one performance at `perf` (ISO date, 19:00 UTC) and bookings generated from `daily(daysBefore)` =
 * tickets sold that day, as bookings of `size` tickets. Downloaded completely the day after the performance.
 */
function makeEvent(id, perf, days, daily, { size = 4, synced = true } = {}) {
  const start = Date.parse(`${perf}T19:00:00Z`);
  const bookings = [];
  let n = 0;
  for (let d = days; d >= 0; d--) {
    const t = Math.round(daily(d));
    for (let left = t; left > 0; left -= size) {
      bookings.push({ id: `${id}-${n++}`, created: iso(start - d * DAY - 3600_000), status: 'active', perf_id: `${id}-p`, event_id: id, tickets: Math.min(size, left), money: {} });
    }
  }
  return {
    id,
    label: perf.slice(0, 4),
    firstStart: `${perf}T19:00:00Z`,
    data: {
      performances: [{ id: `${id}-p`, event_id: id, starts_at: `${perf}T19:00:00Z`, last_synced_at: synced ? iso(start + DAY) : null, scan_state: 'idle' }],
      bookings,
    },
  };
}

// A campaign that accelerates towards the performance: ~17,400 tickets over 60 days at scale 1.
const shape = (scale) => (d) => scale * (40 + 6000 / (d + 6));

describe('Sell-out forecast', () => {
  test('cumulative curve counts tickets booked at least d days before', () => {
    const e = makeEvent('a', '2025-11-05', 3, () => 8);
    const c = eventCurve(e.data);
    assert.equal(c.cumT[0], 32);
    assert.equal(c.cumT[3], 8);
    assert.equal(c.cumT[2], 16);
    assert.equal(soldOutAt(c.cumT, 16), 2);
    assert.equal(soldOutAt(c.cumT, 100), null);
  });

  test('a year selling like past years forecasts a sell-out near when they reached the same total', () => {
    const now = Date.parse('2026-10-06T12:00:00Z'); // 30 days before 5 Nov 2026
    const past = [makeEvent('y24', '2024-11-05', 60, shape(1)), makeEvent('y25', '2025-11-05', 60, shape(1.05))];
    // This year is running 25% ahead of 2024, so it reaches 10,000 before the performance.
    const current = makeEvent('y26', '2026-11-05', 60, (d) => (d > 30 ? shape(1.25)(d) : 0), { synced: true });
    const res = forecastSellOut({ events: [...past, current], selectedId: 'y26', capacity: 10000, now });

    assert.equal(res.status, 'forecast');
    assert.equal(res.daysToGo, 30);
    assert.equal(res.performanceDate, '2026-11-05');
    assert.equal(res.references.length, 2);
    assert.equal(res.forecast.method, 'history');
    assert.equal(res.forecast.scenarios, 4);
    assert.ok(res.forecast.sellOut, 'a sell-out date is forecast');
    assert.ok(res.forecast.sellOut.daysBefore > 0 && res.forecast.sellOut.daysBefore < 30);
    assert.ok(res.forecast.earliest.daysBefore >= res.forecast.sellOut.daysBefore);
    assert.ok(res.forecast.projectedFinal.central > 10000);
    assert.ok(Math.abs(res.bookingsNeeded.ticketsPerBooking - 4) < 0.1);
    assert.ok(res.bookingsNeeded.bookings > 0);
    // chart rows run from the first booking to the performance, actual then forecast
    const last = res.rows[res.rows.length - 1];
    assert.equal(last.daysBefore, 0);
    assert.equal(last.actual, null);
    assert.ok(last.central >= 10000);
    assert.equal(res.rows.find((r) => r.daysBefore === 30).actual, res.sold.tickets);
  });

  test('a slow year does not sell out, and the projected final is below capacity', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const past = [makeEvent('y24', '2024-11-05', 60, shape(0.45)), makeEvent('y25', '2025-11-05', 60, shape(0.5))];
    const current = makeEvent('y26', '2026-11-05', 60, (d) => (d > 30 ? shape(0.4)(d) : 0));
    const res = forecastSellOut({ events: [...past, current], selectedId: 'y26', now });
    assert.equal(res.capacity, 10000);
    assert.equal(res.forecast.sellOut, null);
    assert.equal(res.forecast.selling, 0);
    assert.ok(res.forecast.projectedFinal.central < 10000);
    assert.ok(res.pace.required > res.pace.last7);
  });

  test('momentum responds to a recent surge that the share-of-sales scenario ignores', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const past = [makeEvent('y25', '2025-11-05', 60, shape(0.8))];
    // Same as 2025 until two weeks ago, then double the pace.
    const current = makeEvent('y26', '2026-11-05', 60, (d) => (d > 30 ? shape(0.8)(d) * (d <= 44 ? 2 : 1) : 0));
    const res = forecastSellOut({ events: [...past, current], selectedId: 'y26', now });
    const r = res.references[0];
    assert.ok(r.momentum.ratio > 1.9 && r.momentum.ratio < 2.1);
    assert.ok(r.momentum.final > r.share.final);
  });

  test('a past year that sold out has its curve continued with the growth of years that did not', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    // 2024 is capped at 10,000 (stops selling); 2025 did not sell out.
    let sold = 0;
    const capped = makeEvent('y24', '2024-11-05', 60, (d) => {
      const want = Math.min(shape(1.3)(d), 10000 - sold);
      sold += Math.max(0, Math.round(want));
      return Math.max(0, want);
    });
    const past = [capped, makeEvent('y25', '2025-11-05', 60, shape(0.9))];
    const current = makeEvent('y26', '2026-11-05', 60, (d) => (d > 30 ? shape(0.9)(d) : 0));
    const res = forecastSellOut({ events: [...past, current], selectedId: 'y26', now });
    const y24 = res.references.find((r) => r.id === 'y24');
    assert.ok(y24.soldOut, '2024 is marked as sold out');
    // Without the continuation 2024's share scenario would be flat after its sell-out; with it, it keeps growing.
    assert.ok(y24.share.final > res.sold.tickets * 1.2);
  });

  test('with no completed past year it falls back to the recent pace', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const current = makeEvent('y26', '2026-11-05', 60, (d) => (d > 30 ? 100 : 0));
    const res = forecastSellOut({ events: [current], selectedId: 'y26', now });
    assert.equal(res.forecast.method, 'pace');
    assert.equal(res.pace.last14, 100);
    assert.equal(res.forecast.projectedFinal.central, 3000 + 100 * 31);
  });

  test('incomplete past downloads are left out and named', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const past = [makeEvent('y25', '2025-11-05', 60, shape(1), { synced: false })];
    const current = makeEvent('y26', '2026-11-05', 60, (d) => (d > 30 ? shape(1)(d) : 0));
    const res = forecastSellOut({ events: [...past, current], selectedId: 'y26', now });
    assert.deepEqual(res.incompleteReferences, ['2025']);
    assert.equal(res.references.length, 0);
  });

  test('already sold out, and past events, report the outcome instead of forecasting', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const current = makeEvent('y26', '2026-11-05', 60, (d) => (d > 30 ? 400 : 0));
    const out = forecastSellOut({ events: [current], selectedId: 'y26', capacity: 5000, now });
    assert.equal(out.status, 'sold_out');
    assert.equal(out.soldOut.daysBefore, 48); // 400/day from 60 days before reaches 5,000 on the 13th day
    assert.equal(out.forecast.sellOut, null);

    const past = makeEvent('y25', '2025-11-05', 60, () => 100);
    const res = forecastSellOut({ events: [past], selectedId: 'y25', capacity: 5000, now });
    assert.equal(res.status, 'past');
    assert.equal(res.soldOut.daysBefore, 11);
    assert.equal(res.soldOut.date, '2025-10-25');
  });
});
