import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDatabase } from './helpers/db.js';
import { createFakeTicketSource } from './helpers/fakeTicketSource.js';
import { initConfig, config } from '../src/config.js';
import { TicketSourceClient, StepLimit, rateStatus, parseRetryAfter } from '../src/ticketsource/client.js';
import { refreshEvents, listEventSummaries, eventState } from '../src/ticketsource/events.js';
import { syncEventStep } from '../src/ticketsource/engine.js';
import { summariseLines } from '../src/ticketsource/ingest.js';
import { getBookingById, listBookings } from '../src/domain/bookings.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const past = (days) => new Date(NOW - days * DAY).toISOString();
const future = (days) => new Date(NOW + days * DAY).toISOString();

describe('TicketSource integration', () => {
  let db;
  let ts;
  let clientCfg;
  let cfg;

  const newClient = (overrides = {}, now = () => NOW) =>
    new TicketSourceClient(db, { ...clientCfg, ...overrides }, { fetchImpl: ts.fetch, now });

  const runToCompletion = async (eventId, opts = {}, clientOverrides = {}) => {
    const steps = [];
    for (let i = 0; i < 100; i++) {
      const res = await syncEventStep(db, newClient(clientOverrides), eventId, { ...opts, start: i === 0, now: NOW }, cfg);
      steps.push(res);
      if (res.done) return steps;
      assert.ok(!res.waiting || res.waiting === 'budget', `unexpected wait: ${res.waiting}`);
    }
    throw new Error('did not finish');
  };

  beforeEach(async () => {
    initConfig({ NODE_ENV: 'test' });
    db = createInMemoryDatabase();
    ts = createFakeTicketSource();
    clientCfg = { apiKey: 'test-key', apiUrl: 'https://api.ticketsource.io', stepCalls: 40, callsPerMinute: 200 };
    cfg = { settlementDays: 14, customerTtlHours: 168 };

    ts.addEvent('evt-live', 'Fireworks 2026', { dates: [{ id: 'dat-live', start: future(5) }] });
    ts.addEvent('evt-done', 'Fireworks 2025', { settled: true, dates: [{ id: 'dat-done', start: past(60) }] });
    ts.addEvent('evt-old', 'Fireworks 2023', { archived: true, dates: [{ id: 'dat-old', start: past(900) }] });
    for (let n = 1; n <= 5; n++) ts.addBooking('dat-live', n);
    for (let n = 11; n <= 12; n++) ts.addBooking('dat-done', n, { gross: 30, refund: 30 });
    ts.addBooking('dat-old', 21);
  });

  const refresh = async (extra = {}) => {
    const client = newClient();
    await client.begin();
    await refreshEvents(db, client, { ttlMs: 3_600_000, now: NOW, ...extra });
    await client.end();
    return client.callsMade;
  };

  test('lists events as unsettled / settled / archived and caches them', async () => {
    const calls = await refresh();
    assert.equal(calls, 2 + 3); // all events + settled set + dates for each of the three events

    const states = Object.fromEntries((await listEventSummaries(db, { settlementDays: 14, now: NOW })).map((e) => [e.id, e.state]));
    assert.deepEqual(states, { 'evt-live': 'unsettled', 'evt-done': 'settled', 'evt-old': 'archived' });

    // Fresh cache: no further API calls
    ts.calls.length = 0;
    assert.equal(await refresh(), 0);
    assert.equal(ts.calls.length, 0);

    // force bypasses the cache
    assert.equal(await refresh({ force: true }), 5);

    const unsettled = await listEventSummaries(db, { settlementDays: 14, now: NOW, state: 'unsettled' });
    assert.deepEqual(unsettled.map((e) => e.id), ['evt-live']);
  });

  test('settled events are not hidden by the API default; falls back cleanly if the any-operator is rejected', async () => {
    // the plain default request would miss evt-done entirely
    const plain = await ts.fetch('https://api.ticketsource.io/events', { headers: { Authorization: 'Bearer test-key' } });
    assert.deepEqual((await plain.json()).data.map((e) => e.id).sort(), ['evt-live', 'evt-old']);

    await refresh();
    const ids = (await listEventSummaries(db, { settlementDays: 14, now: NOW })).map((e) => e.id).sort();
    assert.deepEqual(ids, ['evt-done', 'evt-live', 'evt-old']);
    const settledFlags = await db.prepare('SELECT id, settled FROM ts_events ORDER BY id').all();
    assert.deepEqual(settledFlags.map((r) => r.settled), [1, 0, 0]);

    // API rejects `any`: still lists events (unsettled-only default), settled flag stays unknown rather than wrong
    db = createInMemoryDatabase();
    ts.rejectAnyOperator = true;
    await refresh();
    const fallback = await db.prepare('SELECT id, settled FROM ts_events ORDER BY id').all();
    assert.deepEqual(fallback.map((r) => r.id), ['evt-live', 'evt-old']);
    assert.ok(fallback.every((r) => r.settled === null));
  });

  test('settlement state can be pinned and respects the settlement window', () => {
    const ev = { archived: 0, state_override: null, settled: null };
    assert.equal(eventState({ ...ev, settled: 1 }, [{ starts_at: future(5) }], 14, NOW), 'settled');
    assert.equal(eventState({ ...ev, settled: 0 }, [{ starts_at: past(900) }], 14, NOW), 'unsettled');
    const d = [{ starts_at: past(10) }];
    assert.equal(eventState(ev, d, 14, NOW), 'unsettled');
    assert.equal(eventState(ev, d, 7, NOW), 'settled');
    assert.equal(eventState({ ...ev, state_override: 'unsettled' }, [{ starts_at: past(900) }], 14, NOW), 'unsettled');
    assert.equal(eventState({ archived: 1 }, d, 14, NOW), 'archived');
  });

  test('full sync stores bookings, encrypted customers, tickets and transaction lines', async () => {
    await refresh();
    const steps = await runToCompletion('evt-live');
    assert.equal(steps.at(-1).done, true);
    assert.equal(steps.at(-1).mode, 'incremental');

    const bookings = await listBookings(db, { eventId: 'dat-live' });
    assert.equal(bookings.length, 5);

    const full = await getBookingById(db, bookings.find((b) => b.reference === 'REF001').id);
    assert.equal(full.customer.name, 'Ann Lee1');
    assert.equal(full.customer.postcode, 'AB1 2CD');
    assert.equal(full.tickets.length, 2);
    assert.deepEqual(full.tickets.map((t) => t.ticket_type).sort(), ['Adult', 'Child']);
    assert.equal(full.tickets.find((t) => t.ticket_type === 'Adult').attendee.email, 'ann1@example.com');
    assert.equal(full.transactions.length, 1);
    assert.equal(full.transactions[0].gross, 20);
    assert.equal(full.transactions[0].discount_code_amount, 2);
    assert.equal(full.total_price, 20);
    assert.equal(full.ts_booking_id, undefined); // internal column not leaked by the domain mapper

    // PII is encrypted at rest, in customers and in ticket attendee details
    const raw = await db.prepare('SELECT name_encrypted, email_encrypted, address_encrypted FROM customers LIMIT 1').get();
    for (const v of Object.values(raw)) assert.match(v, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    const att = await db.prepare('SELECT attendee_encrypted FROM tickets WHERE attendee_encrypted IS NOT NULL LIMIT 1').get();
    assert.doesNotMatch(att.attendee_encrypted, /ann/);
    const dump = JSON.stringify(await db.prepare('SELECT * FROM customers').all());
    assert.doesNotMatch(dump, /ann\d@example\.com|Lee\d|AB\d 2CD/);
  });

  test('refunded bookings are marked refunded and keep their refund transaction', async () => {
    await refresh();
    await runToCompletion('evt-done');
    const [b] = await listBookings(db, { eventId: 'dat-done', limit: 1 });
    assert.equal(b.status, 'refunded');
    const tx = await db.prepare("SELECT COUNT(*) AS n FROM booking_transactions WHERE is_refund = 1").get();
    assert.equal(tx.n, 2);
  });

  test('settled and archived events are fully scanned; archived dates are fetched on demand', async () => {
    await refresh();
    const steps = await runToCompletion('evt-old');
    assert.equal(steps.at(-1).mode, 'full');
    assert.equal((await listBookings(db, { eventId: 'dat-old' })).length, 1);
  });

  test('incremental sync only fetches what changed since the checkpoint', async () => {
    await refresh();
    await runToCompletion('evt-live');
    const checkpoint = (await db.prepare("SELECT checkpoint FROM ts_dates WHERE id = 'dat-live'").get()).checkpoint;
    assert.ok(checkpoint);

    // nothing changed: one list call, nothing else
    ts.calls.length = 0;
    let steps = await runToCompletion('evt-live');
    assert.equal(steps.at(-1).imported, 0);
    assert.deepEqual(ts.calls.map((c) => c.split('?')[0]), ['/dates/dat-live/bookings']);
    assert.match(ts.calls[0], /filter%5Bupdated_at%5D%5Boperator%5D=after/);

    // one booking changes upstream, one new booking arrives
    const changed = ts.bookings['dat-live'][0];
    changed.attributes.updated_at = '2026-12-01T00:00:00+00:00';
    changed.attributes.lines[0].amount.gross = 25;
    ts.addBooking('dat-live', 6, { updated: '2026-12-02T00:00:00+00:00' });
    ts.calls.length = 0;
    steps = await runToCompletion('evt-live');
    assert.equal(steps.at(-1).imported, 2);
    assert.equal((await listBookings(db, { eventId: 'dat-live' })).length, 6);
    const refreshed = await db.prepare("SELECT total_price FROM bookings WHERE reference = 'REF001'").get();
    assert.equal(refreshed.total_price, 25);
    // customer of the changed booking came from cache: only the new booking's customer was fetched
    assert.equal(ts.calls.filter((c) => c.startsWith('/customers/')).length, 1);
  });

  test('falls back to a local comparison when the API rejects the updated_at filter', async () => {
    ts = createFakeTicketSource({ filterSupported: false });
    ts.addEvent('evt-live', 'Fireworks 2026', { dates: [{ id: 'dat-live', start: future(5) }] });
    ts.addBooking('dat-live', 1);
    await refresh();
    await runToCompletion('evt-live');
    ts.addBooking('dat-live', 2, { updated: '2026-12-02T00:00:00+00:00' });
    const steps = await runToCompletion('evt-live');
    assert.equal(steps.at(-1).imported, 1);
    assert.equal((await listBookings(db, { eventId: 'dat-live' })).length, 2);
  });

  test('force mode re-imports everything and bypasses the customer cache', async () => {
    await refresh();
    await runToCompletion('evt-live');
    ts.calls.length = 0;
    const steps = await runToCompletion('evt-live', { mode: 'force' });
    assert.equal(steps.at(-1).imported, 5);
    assert.equal(ts.calls.filter((c) => c.startsWith('/customers/')).length, 5);
  });

  test('a forced re-sync with a tiny call budget still completes (progress survives step boundaries)', async () => {
    await refresh();
    await runToCompletion('evt-live');
    const steps = await runToCompletion('evt-live', { mode: 'force' }, { stepCalls: 4 });
    assert.ok(steps.length > 2, 'needed several steps');
    assert.equal(steps.at(-1).done, true);
    assert.equal(steps.reduce((n, x) => n + x.imported, 0), 5); // every booking re-read exactly once
  });

  test('a small call budget spreads one sync over several resumable steps', async () => {
    await refresh();
    const steps = await runToCompletion('evt-live', {}, { stepCalls: 4 });
    assert.ok(steps.length > 1, 'expected multiple steps');
    assert.ok(steps.slice(0, -1).every((s) => !s.done && s.waiting === 'budget'));
    assert.ok(steps.every((s) => s.calls <= 4));
    assert.equal((await listBookings(db, { eventId: 'dat-live' })).length, 5);
  });

  test('never exceeds the per-minute allowance across steps and reports when to retry', async () => {
    await refresh(); // 3 calls
    const limited = { callsPerMinute: 10, stepCalls: 40 };
    const first = await syncEventStep(db, newClient(limited), 'evt-live', { start: true, now: NOW }, cfg);
    assert.equal(first.done, false);
    assert.equal(first.waiting, 'budget');
    assert.ok(first.calls <= 10 - 3);

    const second = await syncEventStep(db, newClient(limited), 'evt-live', { now: NOW }, cfg);
    assert.equal(second.done, false);
    assert.equal(second.waiting, 'rate');
    assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= 11_000);

    const status = await rateStatus(db, 10, NOW);
    assert.equal(status.usedLastMinute <= 10, true);

    // a minute later the allowance is back
    const later = newClient(limited, () => NOW + 61_000);
    assert.ok((await later.begin()) > 0);
  });

  test('429 pauses all syncing until Retry-After passes, and progress is kept', async () => {
    await refresh();
    ts.rateLimitAfter = ts.calls.length + 3;
    const first = await syncEventStep(db, newClient(), 'evt-live', { start: true, now: NOW }, cfg);
    assert.equal(first.done, false);
    assert.equal(first.waiting, 'rate_limited');
    assert.equal(first.retryAfterMs, 30_000);

    // still blocked, no API call made
    const callsBefore = ts.calls.length;
    const blocked = await syncEventStep(db, newClient(), 'evt-live', { now: NOW + 5_000 }, cfg);
    assert.equal(blocked.waiting, 'rate_limited');
    assert.equal(ts.calls.length, callsBefore);

    // after the pause it carries on and finishes
    ts.rateLimitAfter = Infinity;
    let res;
    for (let i = 0; i < 20; i++) {
      res = await syncEventStep(db, newClient({}, () => NOW + 31_000), 'evt-live', { now: NOW + 31_000 }, cfg);
      if (res.done) break;
    }
    assert.equal(res.done, true);
    assert.equal((await listBookings(db, { eventId: 'dat-live' })).length, 5);
  });

  test('is read-only: never sends anything but GET to TicketSource', async () => {
    await refresh();
    await runToCompletion('evt-live');
    assert.ok(ts.methods.length > 0);
    assert.ok(ts.methods.every((m) => m === 'GET'), `non-GET sent: ${ts.methods}`);

    const client = newClient();
    await client.begin();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await assert.rejects(() => client.request(method, '/customers'), /read-only/);
    }
  });

  test('helpers: line totals and Retry-After parsing', () => {
    const lines = [
      { line_type: 'TICKETS', amount: { gross: 30, discounts: { code: { description: 'X', amount: 3 }, automatic: 1 } } },
      { line_type: 'TICKETS', is_refund: true, amount: { gross: 10 } },
    ];
    const s = summariseLines(lines);
    assert.equal(s.total, 20);
    assert.equal(s.discount, 4);
    assert.equal(s.status, 'confirmed');
    assert.equal(summariseLines([{ line_type: 'TICKETS', amount: { gross: 5 } }, { line_type: 'TICKETS', is_refund: true, amount: { gross: 5 } }]).status, 'refunded');

    assert.equal(parseRetryAfter('12'), 12_000);
    assert.equal(parseRetryAfter(null), null);
    assert.ok(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) >= 1000);
    assert.ok(new StepLimit('x', 1) instanceof Error);
  });
});
