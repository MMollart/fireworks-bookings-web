import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDatabase } from './helpers/db.js';
import { createFakeTicketSource } from './helpers/fakeTicketSource.js';
import { initConfig } from '../src/config.js';
import { TicketSourceClient } from '../src/ticketsource/client.js';
import { refreshEvents } from '../src/ticketsource/events.js';
import { syncEventStep } from '../src/ticketsource/engine.js';
import { londonDay, dayToIso, periodOf, weekStart } from '../src/analysis/time.js';
import { loadBookings } from '../src/analysis/data.js';
import { salesOverTime } from '../src/analysis/sales.js';
import { compareEvents } from '../src/analysis/compare.js';
import { loadCodeLines, summariseDiscounts, normaliseCode } from '../src/analysis/discounts.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const line = (gross, { code, codeAmount, refund = false, auto = 0, net } = {}) => ({
  line_type: 'TICKETS',
  payment_method: 'TS',
  is_refund: refund,
  amount: {
    gross, fee: 0, fee_vat: 0, net: net ?? gross,
    discounts: { automatic: auto, code: code === undefined ? { description: '', amount: 0 } : { description: code, ...(codeAmount === undefined ? {} : { amount: codeAmount }) } },
  },
});

describe('Analysis', () => {
  let db;
  let ts;
  const cfg = { settlementDays: 14, customerTtlHours: 168 };

  const sync = async (eventId, mode) => {
    for (let i = 0; i < 100; i++) {
      const client = new TicketSourceClient(db, { apiKey: 'test-key', apiUrl: 'https://api.ticketsource.io', stepCalls: 40, callsPerMinute: 200 }, { fetchImpl: ts.fetch, now: () => NOW });
      const res = await syncEventStep(db, client, eventId, { start: i === 0, mode, now: NOW }, cfg);
      if (res.done) return;
    }
    throw new Error('sync did not finish');
  };
  const refresh = async (force = false) => {
    const client = new TicketSourceClient(db, { apiKey: 'test-key', apiUrl: 'https://api.ticketsource.io', stepCalls: 40, callsPerMinute: 200 }, { fetchImpl: ts.fetch, now: () => NOW });
    await client.begin();
    await refreshEvents(db, client, { force, ttlMs: 3_600_000, now: NOW });
  };

  beforeEach(() => {
    initConfig({ NODE_ENV: 'test' });
    db = createInMemoryDatabase();
    ts = createFakeTicketSource();
  });

  test('Europe/London calendar: BST boundary, Monday weeks, months', () => {
    assert.equal(dayToIso(londonDay('2026-06-30T23:30:00Z')), '2026-07-01'); // 00:30 BST is already July 1st
    assert.equal(dayToIso(londonDay('2026-03-28T23:30:00Z')), '2026-03-28'); // still GMT
    assert.equal(dayToIso(londonDay('2026-03-29T00:30:00Z')), '2026-03-29');
    assert.equal(dayToIso(weekStart(londonDay('2026-11-04T10:00:00Z'))), '2026-11-02'); // Wednesday -> Monday
    assert.equal(dayToIso(weekStart(londonDay('2026-11-08T10:00:00Z'))), '2026-11-02'); // Sunday belongs to the Monday before
    assert.equal(periodOf('monthly', londonDay('2026-02-10')).end - periodOf('monthly', londonDay('2026-02-10')).start, 27);
    assert.equal(londonDay(null), null);
    assert.equal(londonDay('nonsense'), null);
  });

  describe('sales over time', () => {
    beforeEach(async () => {
      ts.addEvent('evt-a', 'Fireworks 2026', { dates: [{ id: 'dat-a1', start: '2026-11-07T19:00:00Z' }, { id: 'dat-a2', start: '2026-11-08T19:00:00Z' }] });
      ts.addBooking('dat-a1', 1, { created: '2026-10-01T09:00:00Z', lines: [line(20, { net: 18 })], seats: 2 });
      ts.addBooking('dat-a1', 2, { created: '2026-10-01T22:30:00Z', lines: [line(10, { net: 9 })], seats: 1 }); // 23:30 BST: same London day
      ts.addBooking('dat-a1', 3, { created: '2026-10-06T10:00:00Z', lines: [line(30, { net: 27 }), line(30, { refund: true, net: 27 })], seats: 0 }); // fully refunded: no active tickets
      ts.addBooking('dat-a2', 4, { created: '2026-10-12T10:00:00Z', lines: [line(12, { net: 11 })], seats: 1 });
      ts.addBooking('dat-a2', 5, { created: null, lines: [line(6, { net: 5 })], seats: 1 }); // no creation date
      await refresh();
      await sync('evt-a');
    });

    test('whole event totals include undated bookings; tickets and money reflect current state', async () => {
      const out = salesOverTime(await loadBookings(db, { eventId: 'evt-a' }), 'whole');
      assert.equal(out.rows.length, 1);
      const row = out.rows[0];
      assert.equal(row.coverage, 'complete');
      assert.equal(row.bookings, 5);
      assert.equal(row.tickets, 5); // 2 + 1 + 0 (refunded) + 1 + 1
      assert.deepEqual(row.gross, { GBP: 48 }); // 20 + 10 + (30-30) + 12 + 6
      assert.deepEqual(row.net, { GBP: 43 }); // 18 + 9 + 0 + 11 + 5
      assert.equal(out.undated, 1);
    });

    test('daily rows use the original creation date and exclude undated bookings (disclosed)', async () => {
      const out = salesOverTime(await loadBookings(db, { eventId: 'evt-a' }), 'daily');
      assert.equal(out.undated, 1);
      const byKey = Object.fromEntries(out.rows.map((r) => [r.key, r]));
      assert.equal(byKey['2026-10-01'].bookings, 2); // 09:00Z and 22:30Z (23:30 BST) are the same London day
      assert.equal(byKey['2026-10-01'].tickets, 3);
      assert.deepEqual(byKey['2026-10-01'].gross, { GBP: 30 });
      assert.equal(byKey['2026-10-06'].bookings, 1);
      assert.equal(byKey['2026-10-06'].tickets, 0);
      assert.deepEqual(byKey['2026-10-06'].gross, { GBP: 0 }); // refunded: current financial status
      assert.equal(byKey['2026-10-02'].bookings, 0); // a quiet day inside a complete download is a confirmed zero
      assert.equal(byKey['2026-10-02'].coverage, 'complete');
      // dated rows sum to totals minus the undated booking
      const sum = out.rows.reduce((s, r) => s + (r.bookings ?? 0), 0);
      assert.equal(sum, 4);
      assert.equal(out.totals.bookings, 5);
    });

    test('weekly rows start on Monday; monthly rows span calendar months', async () => {
      const weekly = salesOverTime(await loadBookings(db, { eventId: 'evt-a' }), 'weekly');
      assert.ok(weekly.rows.every((r) => new Date(r.start).getUTCDay() === 1));
      assert.equal(weekly.rows[0].start, '2026-09-28'); // Thu 1 Oct belongs to the week starting Mon 28 Sep
      const monthly = salesOverTime(await loadBookings(db, { eventId: 'evt-a' }), 'monthly');
      assert.deepEqual(monthly.rows.map((r) => r.start), ['2026-10-01', '2026-11-01']);
    });

    test('optional performance narrows the scope', async () => {
      const out = salesOverTime(await loadBookings(db, { eventId: 'evt-a', performanceId: 'dat-a2' }), 'whole');
      assert.equal(out.rows[0].bookings, 2);
    });

    test('periods not covered by the download are No data (null), not zero', async () => {
      // last sync was 2026-11-20, performances were 7-8 Nov: everything up to the performances is covered...
      let out = salesOverTime(await loadBookings(db, { eventId: 'evt-a' }), 'weekly');
      assert.ok(out.rows.every((r) => r.coverage === 'complete'));

      // ...but a sync that stopped partway through leaves later periods uncovered
      await db.prepare("UPDATE ts_dates SET last_synced_at = '2026-10-05T12:00:00Z' WHERE id IN ('dat-a1','dat-a2')").run();
      out = salesOverTime(await loadBookings(db, { eventId: 'evt-a' }), 'daily');
      const byKey = Object.fromEntries(out.rows.map((r) => [r.key, r]));
      assert.equal(byKey['2026-10-04'].coverage, 'complete');
      assert.equal(byKey['2026-10-05'].coverage, 'partial'); // the day the download ended
      assert.equal(byKey['2026-10-07'].coverage, 'none');
      assert.equal(byKey['2026-10-07'].bookings, null);
      assert.equal(byKey['2026-10-07'].gross, null);

      // an incomplete (still scanning) performance: empty periods are No data, populated ones are partial
      await db.prepare("UPDATE ts_dates SET scan_state = 'scanning' WHERE id = 'dat-a1'").run();
      out = salesOverTime(await loadBookings(db, { eventId: 'evt-a', performanceId: 'dat-a1' }), 'daily');
      const inc = Object.fromEntries(out.rows.map((r) => [r.key, r]));
      assert.equal(inc['2026-10-01'].coverage, 'partial');
      assert.equal(inc['2026-10-03'].coverage, 'none');
      assert.equal(out.incompletePerformances, 1);
    });
  });

  describe('compare events', () => {
    beforeEach(async () => {
      ts.addEvent('evt-a', 'Fireworks 2026', { dates: [{ id: 'dat-a', start: '2026-11-07T19:00:00Z' }] });
      ts.addEvent('evt-b', 'Fireworks 2025', { settled: true, dates: [{ id: 'dat-b', start: '2025-11-08T19:00:00Z' }] });
      ts.addEvent('evt-c', 'Fireworks 2024', { settled: true, dates: [{ id: 'dat-c', start: '2024-11-02T19:00:00Z' }] });
      // 2026: 2 tickets 10 days out, 1 ticket 3 days out, 1 undated
      ts.addBooking('dat-a', 1, { created: '2026-10-28T10:00:00Z', lines: [line(20)], seats: 2 });
      ts.addBooking('dat-a', 2, { created: '2026-11-04T10:00:00Z', lines: [line(10)], seats: 1 });
      ts.addBooking('dat-a', 3, { created: null, lines: [line(10)], seats: 1 });
      // 2025: 3 tickets 10 days out, 4 tickets 1 day out
      ts.addBooking('dat-b', 11, { created: '2025-10-29T10:00:00Z', lines: [line(30)], seats: 3 });
      ts.addBooking('dat-b', 12, { created: '2025-11-07T10:00:00Z', lines: [line(40)], seats: 4 });
      // 2024: 1 ticket 10 days out
      ts.addBooking('dat-c', 21, { created: '2024-10-23T10:00:00Z', lines: [line(5)], seats: 1 });
      await refresh();
      for (const e of ['evt-a', 'evt-b', 'evt-c']) await sync(e);
    });

    const load = async () => ({
      selected: await loadBookings(db, { eventId: 'evt-a' }),
      comparison: await loadBookings(db, { eventId: 'evt-b' }),
      others: await Promise.all(['evt-a', 'evt-b', 'evt-c'].map(async (id) => ({ id, data: await loadBookings(db, { eventId: id }) }))),
    });

    test('whole event: totals, differences, and excluded bookings are disclosed', async () => {
      const out = compareEvents({ ...(await load()), group: 'whole' });
      assert.equal(out.rows.length, 1);
      assert.equal(out.rows[0].selected.tickets, 3);
      assert.equal(out.rows[0].comparison.tickets, 7);
      assert.equal(out.rows[0].difference.tickets, -4);
      assert.deepEqual(out.rows[0].difference.gross, { GBP: -40 }); // 30 - 70
      assert.equal(out.excluded.selected, 1); // the undated booking cannot be aligned
      assert.equal(out.excluded.comparison, 0);
    });

    test('daily bands align on days before the performance', async () => {
      const out = compareEvents({ ...(await load()), group: 'daily' });
      const row = (label) => out.rows.find((r) => r.label === label);
      assert.equal(row('10 days before').selected.tickets, 2);
      assert.equal(row('10 days before').comparison.tickets, 3);
      assert.equal(row('3 days before').selected.tickets, 1);
      assert.equal(row('1 day before').comparison.tickets, 4);
      assert.equal(row('1 day before').selected.tickets, 0); // confirmed zero (complete download)
      assert.equal(out.rows[0].label, '10 days before'); // earliest first, performance day last
    });

    test('weekly and 30-day bands', async () => {
      const weekly = compareEvents({ ...(await load()), group: 'weekly' });
      assert.deepEqual(weekly.rows.map((r) => r.label), ['7-13 days before', '0-6 days before']);
      assert.equal(weekly.rows[0].selected.tickets, 2);
      assert.equal(weekly.rows[1].selected.tickets, 1);
      const band = compareEvents({ ...(await load()), group: 'band30' });
      assert.deepEqual(band.rows.map((r) => r.label), ['0-29 days before']);
      assert.equal(band.rows[0].selected.tickets, 3);
    });

    test('sales-to-date cutoff keeps only bookings made at least N days before the performance', async () => {
      const out = compareEvents({ ...(await load()), group: 'whole', cutoff: 5 });
      assert.equal(out.rows[0].selected.tickets, 2); // the 3-days-before booking is cut
      assert.equal(out.rows[0].comparison.tickets, 3); // the 1-day-before booking is cut
    });

    test('average across all events (those with data) is optional', async () => {
      const without = compareEvents({ ...(await load()), group: 'whole' });
      assert.equal(without.rows[0].average, null);
      const out = compareEvents({ ...(await load()), group: 'whole', includeAverage: true });
      assert.equal(out.averageEvents, 3);
      assert.equal(out.rows[0].average.events, 3);
      assert.equal(Math.round(out.rows[0].average.tickets * 100) / 100, Math.round(((3 + 7 + 1) / 3) * 100) / 100);
    });

    test('bands past the download are No data, not zero', async () => {
      // the 2026 download stopped 5 days before the performance (2 Nov)
      await db.prepare("UPDATE ts_dates SET last_synced_at = '2026-11-02T12:00:00Z' WHERE id = 'dat-a'").run();
      const out = compareEvents({ ...(await load()), group: 'daily' });
      const row = (label) => out.rows.find((r) => r.label === label);
      assert.equal(row('10 days before').selected.coverage, 'complete');
      assert.equal(row('3 days before').selected.coverage, 'none');
      assert.equal(row('3 days before').selected.tickets, null);
      assert.equal(row('3 days before').difference, null);
      assert.equal(row('3 days before').comparison.tickets, 0); // the comparison event is fully downloaded: a real zero
    });
  });

  describe('discount codes', () => {
    beforeEach(async () => {
      ts.addEvent('evt-a', 'Fireworks 2026', { dates: [{ id: 'dat-a', start: '2026-11-07T19:00:00Z' }] });
      ts.addEvent('evt-b', 'Fireworks 2025', { settled: true, dates: [{ id: 'dat-b', start: '2025-11-08T19:00:00Z' }] });
      // same code written three ways -> one row; booked in 2025 for the 2026 show (year follows the performance)
      ts.addBooking('dat-a', 1, { created: '2025-12-01T10:00:00Z', lines: [line(18, { code: 'SCT-Café', codeAmount: 2 })], seats: 1 });
      ts.addBooking('dat-a', 2, { created: '2026-10-01T10:00:00Z', lines: [line(18, { code: '  sct-cafe ', codeAmount: 2 })], seats: 1 });
      ts.addBooking('dat-a', 3, { created: '2026-10-02T10:00:00Z', lines: [line(18, { code: 'SCT-CAFE', codeAmount: 3 }), line(18, { code: 'SCT-CAFE', codeAmount: 1 })], seats: 1 }); // two lines, ONE booking
      ts.addBooking('dat-a', 4, { created: '2026-10-03T10:00:00Z', lines: [line(18, { code: 'SCT-CAFE', codeAmount: 2 }), line(18, { code: 'SCT-CAFE', codeAmount: -2, refund: true })], seats: 0 }); // later refunded: still a use; signed refund adjustment is summed
      ts.addBooking('dat-a', 5, { created: '2026-10-04T10:00:00Z', lines: [line(18, { code: 'ROUND-UP' })], seats: 1 }); // amount not supplied
      ts.addBooking('dat-a', 6, { created: '2026-10-05T10:00:00Z', lines: [line(18, { auto: 5 })], seats: 1 }); // automatic discount only: ignored
      ts.addBooking('dat-a', 7, { created: '2026-10-06T10:00:00Z', lines: [line(18), line(18, { code: 'REVERSED', codeAmount: -1.5, refund: true })], seats: 0 }); // reversal only
      ts.addBooking('dat-b', 11, { created: '2025-10-01T10:00:00Z', lines: [line(18, { code: 'sct-cafe', codeAmount: 4 })], seats: 1 });
      await refresh();
      await sync('evt-a');
      await sync('evt-b');
    });

    const summary = async (scope) => summariseDiscounts(await loadCodeLines(db, scope));
    const find = (out, year, code) => out.rows.find((r) => r.yearLabel === String(year) && r.code.toLowerCase() === code.toLowerCase());

    test('normalises equivalent codes (case, diacritics, whitespace)', () => {
      assert.equal(normaliseCode('  SCT-Café  '), normaliseCode('sct-cafe'));
      assert.equal(normaliseCode('A   B'), normaliseCode('a b'));
    });

    test('selected event: distinct bookings, summed amounts, year of the performance', async () => {
      const out = await summary({ eventId: 'evt-a' });
      assert.equal(out.state, 'ok');
      const cafe = find(out, 2026, 'sct-cafe');
      assert.ok(cafe, 'rows are keyed by performance year (2026), not booking year (2025)');
      assert.equal(cafe.uses, 4); // bookings 1, 2, 3 (two lines = one use) and 4 (refunded later, still a use)
      assert.equal(cafe.total, 2 + 2 + 3 + 1 + 2 - 2); // as supplied, including the signed refund adjustment
      assert.ok(cafe.notes.some((n) => /refund adjustments/.test(n)));
      assert.ok(cafe.notes.some((n) => /Merged spellings/.test(n)));
      assert.equal(cafe.currency, 'GBP');
      assert.ok(!out.rows.some((r) => r.yearLabel === '2025'));
    });

    test('missing amounts are unknown, not zero', async () => {
      const out = await summary({ eventId: 'evt-a' });
      const round = find(out, 2026, 'round-up');
      assert.equal(round.uses, 1);
      assert.equal(round.total, null); // "Unknown"
      assert.ok(round.notes.some((n) => /not supplied/.test(n)));
    });

    test('a code only on reversal lines is flagged, not counted as a use; automatic discounts are ignored', async () => {
      const out = await summary({ eventId: 'evt-a' });
      const rev = find(out, 2026, 'reversed');
      assert.equal(rev.uses, 0);
      assert.equal(rev.reversalOnly, 1);
      assert.equal(rev.total, -1.5); // as supplied
      assert.ok(rev.notes.some((n) => /only on reversal lines/.test(n)));
      assert.equal(out.rows.filter((r) => r.uses > 0).length, 2);
    });

    test('all events by year groups on the performance year', async () => {
      const out = await summary({});
      assert.equal(find(out, 2025, 'sct-cafe').uses, 1);
      assert.equal(find(out, 2025, 'sct-cafe').total, 4);
      assert.ok(find(out, 2026, 'sct-cafe'));
      assert.deepEqual([...new Set(out.rows.map((r) => r.yearLabel))], ['2026', '2025']);
    });

    test('empty and no-download states are distinguished', async () => {
      ts.addEvent('evt-z', 'Quiet Night', { dates: [{ id: 'dat-z', start: '2026-12-01T19:00:00Z' }] });
      ts.addBooking('dat-z', 90, { created: '2026-11-01T10:00:00Z', lines: [line(10)], seats: 1 });
      await refresh(true);
      await sync('evt-z');
      const empty = await summary({ eventId: 'evt-z' });
      assert.equal(empty.state, 'empty'); // bookings downloaded, none used a code
      assert.equal(empty.bookingsInScope, 1);

      db = createInMemoryDatabase();
      assert.equal((await summary({})).state, 'no_bookings');
    });
  });
});
