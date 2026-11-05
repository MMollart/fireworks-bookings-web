import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { forecastSellOut, eventCurve, soldOutAt, salesClosure, dayProfile } from '../src/analysis/forecast.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
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
    assert.ok(y24.closed && y24.closed.daysBefore > 0, '2024 is marked as switched off before the day');
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

  describe('sales switched off early, and time of day', () => {
    /**
     * November dates are GMT, so UTC hours are London hours. Days before the performance sell `daily(d)` tickets at
     * noon; the performance day sells `perHour` tickets an hour from 09:00, in bookings of 4, until `stopAt` tickets in
     * total (sales switched off) or the 19:00 start. `until` (ms) cuts the download off, for "today so far".
     */
    function dayEvent(id, perf, { days = 60, daily, perHour, stopAt = Infinity, until = Infinity, synced = true }) {
      const start = Date.parse(`${perf}T19:00:00Z`);
      const bookings = [];
      let total = 0;
      let n = 0;
      const add = (ms, t) => {
        if (ms > until || total + t > stopAt) return false;
        bookings.push({ id: `${id}-${n++}`, created: iso(ms), status: 'active', perf_id: `${id}-p`, event_id: id, tickets: t, money: {} });
        total += t;
        return true;
      };
      for (let d = days; d >= 1; d--) for (let left = Math.round(daily(d)); left > 0; left -= 4) add(start - d * DAY - 7 * HOUR, Math.min(4, left));
      const perBooking = 4;
      const gap = HOUR / (perHour / perBooking);
      for (let ms = start - 10 * HOUR; ms < start - 15 * 60_000; ms += gap) if (!add(ms, perBooking)) break;
      return {
        id,
        label: perf.slice(0, 4),
        firstStart: `${perf}T19:00:00Z`,
        data: {
          performances: [{ id: `${id}-p`, event_id: id, starts_at: `${perf}T19:00:00Z`, last_synced_at: synced ? iso(start + DAY) : iso(until), scan_state: 'idle' }],
          bookings,
        },
      };
    }
    const daily = (k) => (d) => k * (20 + 3000 / (d + 6));

    test('a past year switched off on the day is detected, with the time it would have reached capacity', () => {
      // ~7,500 before the day, then 400/hour from 09:00, switched off at 9,500 (about 14:00)
      const e = dayEvent('y25', '2025-11-05', { daily: daily(0.92), perHour: 400, stopAt: 9500 });
      const curve = eventCurve(e.data);
      const closed = salesClosure(curve, dayProfile(e.data), 10000);
      assert.equal(closed.daysBefore, 0);
      assert.ok(closed.tickets <= 9500 && closed.tickets > 9400);
      assert.ok(Math.abs(closed.ratePerHour - 400) < 20);
      const reach = Date.parse(closed.reachesCapacityAt);
      const expect = Date.parse(closed.at) + ((10000 - closed.tickets) / closed.ratePerHour) * HOUR;
      assert.ok(Math.abs(reach - expect) < 2 * 60_000);
      // still selling at the start: not switched off
      const open = dayEvent('y24', '2024-11-05', { daily: daily(0.92), perHour: 400 });
      assert.equal(salesClosure(eventCurve(open.data), dayProfile(open.data), 10000), null);
      // well short of capacity: not switched off, just a quiet finish
      const quiet = dayEvent('y23', '2023-11-05', { daily: daily(0.3), perHour: 50, stopAt: 4000 });
      assert.equal(salesClosure(eventCurve(quiet.data), dayProfile(quiet.data), 10000), null);
    });

    test('a switched-off year is carried on to capacity, so it does not understate demand', () => {
      const now = Date.parse('2026-10-20T12:00:00Z');
      const past = dayEvent('y25', '2025-11-05', { daily: daily(0.92), perHour: 400, stopAt: 9500 });
      const current = dayEvent('y26', '2026-11-05', { daily: daily(0.92), perHour: 400, until: Date.parse('2026-10-20T00:00:00Z') });
      const res = forecastSellOut({ events: [past, current], selectedId: 'y26', now });
      const y25 = res.references[0];
      assert.ok(y25.closed);
      assert.ok(y25.final <= 9500);
      assert.ok(y25.extendedFinal > 10000, 'carried on at 400/hour to the 19:00 start');
      // the same campaign this year is forecast to reach the full 10,000 on the day
      assert.equal(res.forecast.sellOut.daysBefore, 0);
      assert.ok(res.forecast.projectedFinal.central > 10000);
    });

    test('before the day: forecasts the time of day it reaches 10,000', () => {
      const now = Date.parse('2026-10-20T12:00:00Z');
      const past = [
        dayEvent('y25', '2025-11-05', { daily: daily(0.92), perHour: 400, stopAt: 9500 }),
        dayEvent('y24', '2024-11-05', { daily: daily(0.95), perHour: 380 }),
      ];
      const current = dayEvent('y26', '2026-11-05', { daily: daily(0.92), perHour: 400, until: Date.parse('2026-10-20T00:00:00Z') });
      const res = forecastSellOut({ events: [...past, current], selectedId: 'y26', now });
      const tod = res.forecast.timeOfDay;
      assert.ok(tod, 'time of day is forecast');
      assert.equal(tod.basis, 'projected');
      assert.equal(tod.performanceStart, '2026-11-05T19:00:00.000Z');
      // ~7,500 at the start of the day + ~400/hour from 09:00 reaches 10,000 mid-afternoon
      const hour = new Date(tod.time).getUTCHours();
      assert.ok(hour >= 13 && hour <= 18, `forecast time ${tod.time}`);
      assert.ok(tod.earliest <= tod.time && tod.time <= (tod.latest ?? '9999'));
      assert.equal(tod.rows[tod.rows.length - 1].time, '2026-11-05T19:00:00.000Z');
      assert.ok(tod.rows.every((r) => r.actual === null));
    });

    test('on the day: uses sales so far today, and keeps forecasting to 10,000 after sales are switched off', () => {
      const past = [dayEvent('y25', '2025-11-05', { daily: daily(0.92), perHour: 400, stopAt: 9500 })];
      // This year sells faster on the day: 500/hour from 09:00
      const atNoon = Date.parse('2026-11-05T12:00:00Z');
      const current = dayEvent('y26', '2026-11-05', { daily: daily(0.92), perHour: 500, until: atNoon });
      const res = forecastSellOut({ events: [...past, current], selectedId: 'y26', now: atNoon });
      assert.equal(res.daysToGo, 0);
      const tod = res.forecast.timeOfDay;
      assert.equal(tod.basis, 'today');
      const at = Date.parse(tod.time);
      // start of day + 800/hour from 09:00
      const startOfDay = res.sold.tickets - 3 * 500;
      const expect = Date.parse('2026-11-05T09:00:00Z') + ((10000 - startOfDay) / 500) * HOUR;
      assert.ok(Math.abs(at - expect) < 30 * 60_000, `forecast ${tod.time}, expected about ${iso(expect)}`);
      assert.ok(tod.rows.some((r) => r.actual !== null));

      // Switched off at 9,500 around 13:00; at 15:00 it still says when 10,000 would have been reached.
      const later = Date.parse('2026-11-05T15:00:00Z');
      const closedNow = dayEvent('y26', '2026-11-05', { daily: daily(0.92), perHour: 500, stopAt: 9500, until: later });
      const res2 = forecastSellOut({ events: [...past, closedNow], selectedId: 'y26', now: later });
      const tod2 = res2.forecast.timeOfDay;
      assert.ok(tod2.salesClosed);
      assert.ok(tod2.time, 'a time is still forecast for 10,000');
      assert.ok(Date.parse(tod2.time) > Date.parse(tod2.salesClosed.at));
      assert.ok(Date.parse(tod2.time) < Date.parse('2026-11-05T15:00:00Z'), 'at the closing pace it would have been reached before now');
    });
  });
});

