import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDatabase } from './helpers/db.js';
import { createFakeTicketSource } from './helpers/fakeTicketSource.js';
import { initConfig } from '../src/config.js';
import { TicketSourceClient } from '../src/ticketsource/client.js';
import { refreshEvents, listEventSummaries } from '../src/ticketsource/events.js';
import { syncEventStep } from '../src/ticketsource/engine.js';
import { refreshUnsettled } from '../src/ticketsource/auto.js';
import { eventLabel } from '../src/lib/eventName.js';
import { getDashboardSummary, getTicketTypeBreakdown, getDiscountCodeReport, listEventTotals } from '../src/domain/reports.js';
import { listCustomers, reindexCustomers, upsertCustomer } from '../src/domain/customers.js';
import { listBookings } from '../src/domain/bookings.js';
import { listEvents } from '../src/domain/events.js';
import { listTicketTypes, saveTicketType, deleteTicketType, suggestCategory, typeKey } from '../src/domain/ticketTypes.js';
import { loadScopeOptions, loadBookings } from '../src/analysis/data.js';
import { yearlyTotals } from '../src/analysis/years.js';
import { donationTotals, listDonations } from '../src/domain/donations.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const DAY = 86_400_000;
const past = (days) => new Date(NOW - days * DAY).toISOString();
const future = (days) => new Date(NOW + days * DAY).toISOString();

describe('Event names, dashboard, reports, dictionary, search, auto refresh', () => {
  let db;
  let ts;
  let clientCfg;
  const cfg = { settlementDays: 14, customerTtlHours: 168 };

  const client = () => new TicketSourceClient(db, clientCfg, { fetchImpl: ts.fetch, now: () => NOW });
  const refresh = async () => {
    const c = client();
    await c.begin();
    await refreshEvents(db, c, { ttlMs: 3_600_000, now: NOW });
    await c.end();
  };
  const syncAll = async (id) => {
    for (let i = 0; i < 100; i++) {
      const r = await syncEventStep(db, client(), id, { start: i === 0, now: NOW }, cfg);
      if (r.done) return;
    }
    throw new Error('did not finish');
  };

  beforeEach(async () => {
    initConfig({ NODE_ENV: 'test' });
    db = createInMemoryDatabase();
    ts = createFakeTicketSource();
    clientCfg = { apiKey: 'test-key', apiUrl: 'https://api.ticketsource.io', stepCalls: 40, callsPerMinute: 200 };
    ts.addEvent('evt-2026', 'Lydiard Fireworks & Bonfire Spectacular', { dates: [{ id: 'dat-2026', start: '2026-11-07T19:00:00+00:00' }] });
    ts.addEvent('evt-2025', 'Lydiard Fireworks & Bonfire Spectacular', { settled: true, dates: [{ id: 'dat-2025', start: '2025-11-08T19:00:00+00:00' }] });
    for (let n = 1; n <= 4; n++) ts.addBooking('dat-2026', n, { gross: 20, seats: 2 });
    for (let n = 11; n <= 13; n++) ts.addBooking('dat-2025', n, { gross: 30, seats: 3 });
    await refresh();
    await syncAll('evt-2026');
    await syncAll('evt-2025');
  });

  test('events are labelled by the year of their performance', async () => {
    assert.equal(eventLabel('Lydiard Fireworks & Bonfire Spectacular', '2026-11-07T19:00:00+00:00'), '2026');
    assert.equal(eventLabel('Lydiard', null), 'Lydiard'); // no date: fall back to the TicketSource name

    const names = (await listEvents(db)).map((e) => e.name);
    assert.deepEqual(names, ['2026', '2025']); // newest first
    assert.deepEqual((await listEventSummaries(db, { settlementDays: 14, now: NOW })).map((e) => e.name).sort(), names.slice().sort());
    assert.equal((await loadScopeOptions(db)).events[0].name, names[0]);
  });

  test('dashboard defaults to the latest event and can be switched', async () => {
    const latest = await getDashboardSummary(db);
    assert.equal(latest.selectedEventId, 'evt-2026');
    assert.equal(latest.event.name, '2026');
    assert.equal(latest.bookings.confirmed, 4);
    assert.equal(latest.tickets.tickets_sold, 8);
    assert.equal(latest.customers.total, 4);
    assert.equal(latest.recentBookings.length, 4);
    assert.ok(latest.recentBookings.every((b) => b.event_id === 'dat-2026'));
    assert.deepEqual(latest.events.map((e) => e.id), ['evt-2026', 'evt-2025']);

    const older = await getDashboardSummary(db, { eventId: 'evt-2025' });
    assert.equal(older.selectedEventId, 'evt-2025');
    assert.equal(older.bookings.confirmed, 3);
    assert.equal(older.tickets.tickets_sold, 9);

    assert.equal((await getDashboardSummary(db, { eventId: 'nope' })).selectedEventId, 'evt-2026'); // unknown falls back to latest
  });

  test('ticket type dictionary groups tiers; unmapped types show under their own name', async () => {
    await db.prepare("UPDATE tickets SET ticket_type = 'Early Bird Adult Ticket - 15yrs and older' WHERE rowid % 4 = 0 AND ticket_type = 'Adult'").run();
    await db.prepare("UPDATE tickets SET ticket_type = 'Adult  Ticket - 15yrs and older' WHERE rowid % 4 = 1 AND ticket_type = 'Adult'").run();

    await db.prepare('DELETE FROM ticket_type_map').run(); // start from an empty dictionary
    let tiers = await getTicketTypeBreakdown(db, 'evt-2026');
    assert.ok(tiers.every((t) => t.unmapped));
    const total = tiers.reduce((n, t) => n + t.count, 0);
    assert.equal(total, 8);

    await saveTicketType(db, 'Early Bird Adult Ticket - 15yrs and older', 'Adult');
    await saveTicketType(db, 'Adult', 'Adult');
    await saveTicketType(db, 'adult ticket - 15yrs and older', 'Adult'); // case/space-insensitive match of "Adult  Ticket..."
    tiers = await getTicketTypeBreakdown(db, 'evt-2026');
    const adult = tiers.find((t) => t.ticket_type === 'Adult');
    assert.ok(adult && !adult.unmapped);
    assert.ok(adult.types.length >= 2, 'several ticket types are merged into the Adult category');
    assert.equal(tiers.reduce((n, t) => n + t.count, 0), 8);

    const { types, categories } = await listTicketTypes(db);
    assert.ok(categories.includes('Adult'));
    assert.equal(types.find((t) => t.key === typeKey('Child'))?.suggested, 'Child'); // unmapped type, with a suggestion

    assert.equal(await deleteTicketType(db, 'EARLY BIRD ADULT TICKET - 15YRS AND OLDER'), true);
    assert.equal(await deleteTicketType(db, 'not there'), false);
    await assert.rejects(saveTicketType(db, '', 'Adult'), /required/);
    await assert.rejects(saveTicketType(db, 'X', '  '), /required/);
  });

  test('the migration seeds the known ticket types and suggestions follow the same rules', async () => {
    const seeded = await db.prepare('SELECT category FROM ticket_type_map WHERE type_key = ?').get('early bird adult ticket - 15yrs and older');
    assert.equal(seeded.category, 'Adult');
    assert.equal((await db.prepare('SELECT category FROM ticket_type_map WHERE type_key = ?').get('infant ticket - under 5yrs old')).category, 'Infant');
    assert.equal(suggestCategory('Early Bird Family Ticket - 2 Adults and upto 3 Children (5 - 14yrs inclusive)'), 'Family');
    assert.equal(suggestCategory('Under 5yrs - 14yrs prebooked ticket price'), 'Child');
    assert.equal(suggestCategory('Mystery'), null);
  });

  test('customers are found by the start of a name or email address, quickly and without decrypting everyone', async () => {
    await upsertCustomer(db, { name: 'Maria Fernandez-Gómez', email: 'm.fernandez@example.org' });
    await upsertCustomer(db, { name: 'Johnny Appleseed', email: 'jappleseed@example.org' });

    const byName = await listCustomers(db, { search: 'fern' });
    assert.equal(byName.length, 1);
    assert.equal(byName[0].name, 'Maria Fernandez-Gómez');
    assert.equal((await listCustomers(db, { search: 'GOMEZ' }))[0]?.email, 'm.fernandez@example.org'); // accents and case ignored
    assert.equal((await listCustomers(db, { search: 'maria fer' })).length, 1); // every word must match
    assert.equal((await listCustomers(db, { search: 'maria appleseed' })).length, 0);
    assert.equal((await listCustomers(db, { search: 'jappleseed@example.org' }))[0].name, 'Johnny Appleseed'); // full address
    assert.equal((await listCustomers(db, { search: 'japple' }))[0].name, 'Johnny Appleseed'); // start of an address
    assert.equal((await listCustomers(db, { search: 'ann' })).length, 7); // Ann Lee1-4, 11-13 from the TicketSource download

    const short = await listCustomers(db, { search: 'jo' });
    assert.equal(short.length, 0);
    assert.equal(short.tooShort, true);

    // without a search: newest first, paged in SQL, with booking totals
    const page = await listCustomers(db, { limit: 3 });
    assert.equal(page.length, 3);
    const ann = (await listCustomers(db, { search: 'lee1' }))[0];
    assert.equal(ann.total_bookings, 1);
    assert.ok(ann.total_spent > 0);
  });

  test('customers not yet in the search index are still found, and the reindex catches them up', async () => {
    await db.prepare('DELETE FROM customer_search').run();
    await db.prepare('UPDATE customers SET search_indexed = 0').run();
    assert.equal((await listCustomers(db, { search: 'lee3' })).length, 1); // unindexed customers are always candidates

    let r = await reindexCustomers(db, 3);
    assert.equal(r.indexed, 3);
    assert.ok(r.remaining > 0);
    while (r.remaining > 0) r = await reindexCustomers(db, 3);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM customers WHERE search_indexed = 0').get()).n, 0);
    assert.equal((await listCustomers(db, { search: 'lee3' })).length, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM customer_search').get()).n > 0, true);
  });

  test('bookings are searched by reference or customer name / email, paged in SQL', async () => {
    assert.equal((await listBookings(db, { search: 'REF002' })).length, 1);
    assert.equal((await listBookings(db, { search: 'lee3' })).length, 1);
    assert.equal((await listBookings(db, { search: 'ann4@example' }))[0].reference, 'REF004');
    assert.equal((await listBookings(db, { limit: 2 })).length, 2);
    assert.equal((await listBookings(db, { limit: 2, offset: 5 })).length, 2);
    assert.equal((await listBookings(db, { tsEventId: 'evt-2025' })).length, 3);
    const none = await listBookings(db, { search: 'zzz-no-such' });
    assert.equal(none.length, 0);
  });

  test('a search matching more than 100 customers still works (D1 allows 100 parameters per statement)', async () => {
    for (let i = 0; i < 130; i++) await upsertCustomer(db, { name: `Bulkperson ${i}`, email: `bulk${i}@example.org` });
    const customers = await listCustomers(db, { search: 'bulkperson', limit: 200 });
    assert.equal(customers.length, 130);
    // give one of them a booking, then find it through the customer search
    const bulk = customers[0];
    await db.prepare(
      "INSERT INTO bookings (id, reference, event_id, customer_id, booking_date, status, subtotal, discount_amount, total_price, created_at, updated_at) VALUES ('bk-bulk', 'BULK001', 'dat-2026', ?, '2026-10-01T10:00:00Z', 'confirmed', 10, 0, 10, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')"
    ).run(bulk.id);
    const found = await listBookings(db, { search: 'bulkperson' });
    assert.equal(found.length, 1);
    assert.equal(found[0].reference, 'BULK001');
  });

  test('Reports discount performance is filled from the downloaded transaction lines', async () => {
    const all = await getDiscountCodeReport(db);
    assert.equal(all.state, 'ok');
    const early = all.rows.filter((r) => r.code.toLowerCase() === 'early');
    assert.deepEqual(early.map((r) => [r.yearLabel, r.uses]).sort(), [['2025', 3], ['2026', 4]]);

    const one = await getDiscountCodeReport(db, { eventId: 'evt-2026' });
    assert.equal(one.rows.length, 1);
    assert.equal(one.rows[0].uses, 4);
    assert.equal(one.rows[0].total, 8);
  });

  const addDonation = async (n, { gift = true, amount = 5 } = {}) => {
    const tickets = { line_type: 'TICKETS', payment_method: 'TS', is_refund: false, amount: { gross: 20, fee: 0, fee_vat: 0, net: 20, discounts: {} }, created_at: '2026-10-01T10:00:00+00:00' };
    const donation = { line_type: 'DONATION', payment_method: 'TS', is_refund: false, amount: { gross: amount, fee: 0, fee_vat: 0, net: amount, discounts: {} }, donation: { gift_aid: gift }, created_at: '2026-10-01T10:00:00+00:00' };
    ts.addBooking('dat-2026', n, { lines: [tickets, donation], updated: '2026-11-20T11:00:00+00:00' });
    await syncAll('evt-2026');
  };

  test('donations are shown separately from ticket revenue', async () => {
    const before = await getDashboardSummary(db);
    await addDonation(5, { gift: true, amount: 5 });
    await addDonation(6, { gift: false, amount: 10 });

    const dash = await getDashboardSummary(db);
    assert.deepEqual([dash.donations.total, dash.donations.bookings, dash.donations.gift_aid_bookings, dash.donations.gift_aid_total], [15, 2, 1, 5]);
    assert.equal(dash.financials.gross_revenue - before.financials.gross_revenue, 40); // 2 x 20 of tickets, donations excluded

    const items = await listDonations(db, { eventId: 'evt-2026' });
    assert.deepEqual(items.map((d) => [d.amount, d.gift_aid, d.event]).sort(), [[10, false, '2026'], [5, true, '2026']]);
    assert.equal((await donationTotals(db))[0].label, '2026');
    assert.equal((await donationTotals(db, { eventId: 'evt-2025' })).length, 0);

    const booking = (await listBookings(db, { search: 'REF005' }))[0];
    assert.equal(booking.donation, 5);
    assert.equal((await listBookings(db, { search: 'REF001' }))[0].donation, 0);

    // analysis revenue excludes donations, which have their own figure
    const out = (await import('../src/analysis/sales.js')).salesOverTime(await loadBookings(db, { eventId: 'evt-2026' }), 'whole');
    assert.equal(out.totals.donations.GBP, 15);
    assert.equal(out.totals.gross.GBP, 6 * 20);
  });

  test('tickets carry no assumed price', async () => {
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE price <> 0').get()).n, 0);
    const tiers = await getTicketTypeBreakdown(db);
    assert.ok(tiers.every((t) => !('total_revenue' in t)));
  });

  test('all years side by side, earliest first, optionally to the equivalent date', async () => {
    const events = [];
    for (const id of ['evt-2026', 'evt-2025']) {
      const e = (await loadScopeOptions(db)).events.find((x) => x.id === id);
      events.push({ id, label: e.name, firstStart: e.first_start, data: await loadBookings(db, { eventId: id }) });
    }
    const all = yearlyTotals({ events, selectedId: 'evt-2026', mode: 'all', now: Date.parse('2026-10-31T12:00:00Z') });
    assert.deepEqual(all.rows.map((r) => r.label), ['2025', '2026']);
    assert.deepEqual(all.rows.map((r) => [r.bookings, r.tickets]), [[3, 9], [4, 8]]);
    assert.equal(all.cutoff, null);
    assert.equal(all.rows[1].selected, true);

    // 7 Nov performance, today 31 Oct -> sales made at least 7 days before each performance; fake bookings are created 30 Sep / 1 Oct
    const eq = yearlyTotals({ events, selectedId: 'evt-2026', mode: 'equivalent', now: Date.parse('2026-10-31T12:00:00Z') });
    assert.equal(eq.cutoff, 7);
    assert.equal(eq.equivalent, true);
    const bookingsBy = Object.fromEntries(eq.rows.map((r) => [r.label, r.bookings]));
    assert.equal(bookingsBy['2026'], 4); // created ~38 days before 7 Nov
    assert.equal(bookingsBy['2025'], 0); // created in 2026 for a 2025 show: after the performance, so not "equivalent"

    // once the selected performance has passed there is no equivalent point: all sales
    const past = yearlyTotals({ events, selectedId: 'evt-2026', mode: 'equivalent', now: Date.parse('2026-12-01T12:00:00Z') });
    assert.equal(past.equivalent, false);
    assert.equal(past.cutoff, null);
  });

  test('event totals list newest first', async () => {
    assert.deepEqual((await listEventTotals(db)).map((e) => e.id), ['evt-2026', 'evt-2025']);
  });
});

describe('Scheduled refresh of unsettled events', () => {
  let db;
  let ts;
  let cfg;
  const NOW2 = Date.parse('2026-11-01T12:00:00Z');

  beforeEach(async () => {
    initConfig({ NODE_ENV: 'test' });
    db = createInMemoryDatabase();
    ts = createFakeTicketSource();
    cfg = { apiKey: 'test-key', apiUrl: 'https://api.ticketsource.io', stepCalls: 40, callsPerMinute: 200, settlementDays: 14, customerTtlHours: 168, eventsTtlMinutes: 60 };
    ts.addEvent('evt-live', 'Lydiard Fireworks', { dates: [{ id: 'dat-live', start: '2026-11-07T19:00:00+00:00' }] });
    ts.addEvent('evt-done', 'Lydiard Fireworks', { settled: true, dates: [{ id: 'dat-done', start: '2025-11-08T19:00:00+00:00' }] });
    for (let n = 1; n <= 3; n++) ts.addBooking('dat-live', n);
    ts.addBooking('dat-done', 11);
  });

  const run = (extra = {}) => refreshUnsettled(db, cfg, { now: () => NOW2, sleep: async () => {}, clientOptions: { fetchImpl: ts.fetch, now: () => NOW2 }, ...extra });
  const bookingCount = async (date) => (await db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE event_id = ?').get(date)).n;

  test('downloads the unsettled event and leaves settled events alone', async () => {
    const r = await run();
    assert.equal(r.status, 'ok');
    assert.equal(await bookingCount('dat-live'), 3);
    assert.equal(await bookingCount('dat-done'), 0);
    assert.ok(ts.methods.every((m) => m === 'GET'));
    assert.ok(!ts.calls.some((c) => c.includes('dat-done/bookings')));
    assert.ok(await db.prepare("SELECT value FROM ts_state WHERE key = 'auto_refresh_at'").get());
    assert.equal(JSON.parse((await db.prepare("SELECT value FROM ts_state WHERE key = 'auto_refresh_result'").get()).value).imported, 3);
  });

  test('a later run picks up only new or changed bookings', async () => {
    await run();
    ts.addBooking('dat-live', 4, { updated: '2026-11-01T11:00:00+00:00' });
    ts.calls.length = 0;
    const r = await run();
    assert.equal(r.imported, 1);
    assert.equal(await bookingCount('dat-live'), 4);
    assert.ok(!ts.calls.some((c) => c.includes('/bookings/bkg-1/seats')), 'unchanged bookings are not re-fetched');
  });

  test('skips when not configured or when another run holds the lock, and releases the lock afterwards', async () => {
    assert.equal((await refreshUnsettled(db, { ...cfg, apiKey: '' })).status, 'skipped');
    await db.prepare("INSERT OR REPLACE INTO ts_state (key, value) VALUES ('auto_refresh_lock', ?)").run(String(NOW2 - 60_000));
    assert.equal((await run()).reason, 'a refresh is already running');
    await db.prepare("INSERT OR REPLACE INTO ts_state (key, value) VALUES ('auto_refresh_lock', ?)").run(String(NOW2 - 20 * 60_000)); // stale lock
    assert.equal((await run()).status, 'ok');
    assert.equal((await db.prepare("SELECT value FROM ts_state WHERE key = 'auto_refresh_lock'").get()).value, '0');
  });

  test('records an error instead of throwing', async () => {
    ts.state = null;
    const r = await run({ clientOptions: { fetchImpl: async () => new Response('{}', { status: 500 }), now: () => NOW2 } });
    assert.equal(r.status, 'error');
    assert.ok(r.error);
  });
});
