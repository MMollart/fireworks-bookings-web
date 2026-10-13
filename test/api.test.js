import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDatabase } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { createFakeTicketSource } from './helpers/fakeTicketSource.js';
import { initConfig } from '../src/config.js';
import { resetBootstrapState } from '../src/db/index.js';
import { hashPassword } from '../src/auth/passwords.js';

const ENV = { NODE_ENV: 'test' };

describe('HTTP API & Authentication Integration Tests', () => {
  let db;
  let app;
  let adminCookie;
  let operatorCookie;
  let viewerCookie;

  // Thin supertest-like helper over hono's app.request
  const call = async (method, path, { cookie, json, headers = {} } = {}) => {
    const init = { method, headers: { ...headers } };
    if (cookie) init.headers.cookie = cookie;
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await app.request(path, init, ENV);
    const type = res.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, headers: res.headers, body };
  };
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

  const addUser = async (username, password, role) =>
    db
      .prepare("INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, ?, 1)")
      .run(username, await hashPassword(password), role);

  beforeEach(async () => {
    initConfig(ENV);
    resetBootstrapState();
    db = createInMemoryDatabase();
    app = createApp(() => db);
    // Static assets binding stub
    ENV.ASSETS = { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) };

    await addUser('adminuser', 'AdminPass123!', 'admin');
    await addUser('operatoruser', 'OperatorPass123!', 'operator');
    await addUser('vieweruser', 'ViewerPass123!', 'viewer');

    adminCookie = cookieOf(await call('POST', '/api/auth/login', { json: { username: 'adminuser', password: 'AdminPass123!' } }));
    operatorCookie = cookieOf(await call('POST', '/api/auth/login', { json: { username: 'operatoruser', password: 'OperatorPass123!' } }));
    viewerCookie = cookieOf(await call('POST', '/api/auth/login', { json: { username: 'vieweruser', password: 'ViewerPass123!' } }));
  });

  test('Security headers are present on responses', async () => {
    const res = await call('GET', '/health');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-security-policy'));
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('Public access to /login succeeds; /dashboard redirects to /login if unauthenticated', async () => {
    assert.equal((await call('GET', '/login')).status, 200);
    const dash = await call('GET', '/dashboard');
    assert.equal(dash.status, 302);
    assert.equal(dash.headers.get('location'), '/login');
    assert.equal((await call('GET', '/dashboard', { cookie: adminCookie })).status, 200);
  });

  test('Unauthenticated API requests return 401 Unauthorized', async () => {
    const res = await call('GET', '/api/events');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
    assert.equal((await call('GET', '/api/ticketsource/events')).status, 401);
  });

  test('Login failure with incorrect password returns 401', async () => {
    const res = await call('POST', '/api/auth/login', { json: { username: 'adminuser', password: 'WrongPassword' } });
    assert.equal(res.status, 401);
    assert.ok(res.body.message.includes('Invalid username or password'));
  });

  test('Login is rate limited after repeated failures', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await call('POST', '/api/auth/login', { json: { username: 'adminuser', password: 'nope' } });
    }
    assert.equal(last.status, 429);
  });

  test('Authenticated user can access /api/auth/me', async () => {
    const res = await call('GET', '/api/auth/me', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'adminuser');
    assert.equal(res.body.user.role, 'admin');
  });

  test('Logout invalidates the session', async () => {
    await call('POST', '/api/auth/logout', { cookie: operatorCookie });
    assert.equal((await call('GET', '/api/auth/me', { cookie: operatorCookie })).status, 401);
  });

  test('Viewer accounts are read-only', async () => {
    assert.equal((await call('GET', '/api/events', { cookie: viewerCookie })).status, 200);
    assert.equal((await call('POST', '/api/ticketsource/events/refresh', { cookie: viewerCookie, json: {} })).status, 403);
    // Events, bookings and tickets come from TicketSource only: there are no endpoints to create or change them.
    for (const [method, path] of [['POST', '/api/events'], ['PUT', '/api/events/x'], ['DELETE', '/api/events/x'], ['POST', '/api/bookings'], ['POST', '/api/tickets/checkin']]) {
      assert.equal((await call(method, path, { cookie: adminCookie, json: {} })).status, 404, `${method} ${path}`);
    }
  });

  test('Admin user management endpoints work for admin and are blocked for operator', async () => {
    assert.equal((await call('GET', '/api/admin/users', { cookie: operatorCookie })).status, 403);

    const adminGet = await call('GET', '/api/admin/users', { cookie: adminCookie });
    assert.equal(adminGet.status, 200);
    assert.ok(Array.isArray(adminGet.body.users));

    const createRes = await call('POST', '/api/admin/users', {
      cookie: adminCookie,
      json: { username: 'newvolunteer', password: 'VolunteerPass123!', role: 'operator' },
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.user.username, 'newvolunteer');
    const newUserId = createRes.body.user.id;

    const toggleRes = await call('PATCH', `/api/admin/users/${newUserId}/status`, { cookie: adminCookie, json: { is_active: false } });
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.body.user.is_active, 0);

    const resetRes = await call('POST', `/api/admin/users/${newUserId}/password`, { cookie: adminCookie, json: { password: 'BrandNewPassword123!' } });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.body.success, true);
  });

  test('Reports and CSV export endpoints', async () => {
    const rep = await call('GET', '/api/reports/dashboard', { cookie: operatorCookie });
    assert.equal(rep.status, 200);
    assert.equal(rep.body.selectedEventId, null); // nothing downloaded yet

    const csv = await call('GET', '/api/reports/export.csv', { cookie: operatorCookie });
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  });

  test('TicketSource endpoints: list, refresh, step sync, pin state (with role checks)', async () => {
    const ts = createFakeTicketSource();
    ts.addEvent('evt-live', 'Fireworks 2026', { dates: [{ id: 'dat-live', start: new Date(Date.now() + 5 * 86_400_000).toISOString() }] });
    ts.addEvent('evt-old', 'Fireworks 2023', { archived: true, dates: [{ id: 'dat-old', start: '2023-11-05T18:00:00+00:00' }] });
    ts.addBooking('dat-live', 1);
    ENV.TICKETSOURCE_API_KEY = 'test-key';
    const realFetch = globalThis.fetch;
    globalThis.fetch = ts.fetch;
    try {
      assert.equal((await call('POST', '/api/ticketsource/events/refresh', { cookie: viewerCookie, json: {} })).status, 403);

      const refresh = await call('POST', '/api/ticketsource/events/refresh', { cookie: operatorCookie, json: {} });
      assert.equal(refresh.status, 200);
      assert.equal(refresh.body.done, true);

      const all = await call('GET', '/api/ticketsource/events', { cookie: viewerCookie });
      assert.equal(all.body.configured, true);
      assert.deepEqual(all.body.events.map((e) => e.state).sort(), ['archived', 'unsettled']);
      const archived = await call('GET', '/api/ticketsource/events?state=archived', { cookie: viewerCookie });
      assert.deepEqual(archived.body.events.map((e) => e.id), ['evt-old']);
      assert.equal((await call('GET', '/api/ticketsource/events?state=bogus', { cookie: viewerCookie })).status, 400);

      let step;
      for (let i = 0; i < 10; i++) {
        step = await call('POST', '/api/ticketsource/events/evt-live/sync', { cookie: operatorCookie, json: { start: i === 0 } });
        if (step.body.done) break;
      }
      assert.equal(step.body.done, true);
      assert.equal(step.body.imported, 1);
      assert.equal((await call('GET', '/api/bookings', { cookie: adminCookie })).body.count, 1);

      const booking = (await call('GET', '/api/bookings', { cookie: adminCookie })).body.bookings[0];
      const detail = await call('GET', `/api/bookings/${booking.id}`, { cookie: adminCookie });
      assert.equal(detail.body.booking.transactions.length, 1);
      const csv = await call('GET', '/api/reports/transactions.csv', { cookie: adminCookie });
      assert.equal(csv.status, 200);
      assert.match(csv.body, /REF001/);

      assert.equal((await call('PATCH', '/api/ticketsource/events/evt-live/state', { cookie: operatorCookie, json: { state: 'settled' } })).status, 403);
      assert.equal((await call('PATCH', '/api/ticketsource/events/evt-live/state', { cookie: adminCookie, json: { state: 'settled' } })).status, 200);
      const pinned = await call('GET', '/api/ticketsource/events?state=settled', { cookie: adminCookie });
      assert.deepEqual(pinned.body.events.map((e) => e.id), ['evt-live']);
      assert.equal((await call('POST', '/api/ticketsource/events/nope/sync', { cookie: operatorCookie, json: {} })).status, 404);
    } finally {
      globalThis.fetch = realFetch;
      delete ENV.TICKETSOURCE_API_KEY;
    }
  });

  test('Analysis endpoints validate scope and report setup state', async () => {
    assert.equal((await call('GET', '/api/analysis/options')).status, 401);

    const options = await call('GET', '/api/analysis/options', { cookie: viewerCookie });
    assert.equal(options.status, 200);
    assert.equal(options.body.hasDownloadedBookings, false); // setup empty state: nothing downloaded

    assert.equal((await call('GET', '/api/analysis/sales', { cookie: viewerCookie })).status, 400);
    assert.equal((await call('GET', '/api/analysis/sales?eventId=nope&group=daily', { cookie: viewerCookie })).status, 400);
    assert.equal((await call('GET', '/api/analysis/compare?eventId=a&compareEventId=a', { cookie: viewerCookie })).status, 400);
    assert.equal((await call('GET', '/api/analysis/discounts?scope=bogus', { cookie: viewerCookie })).status, 400);
    const years = await call('GET', '/api/analysis/discounts?scope=years', { cookie: viewerCookie });
    assert.equal(years.status, 200);
    assert.equal(years.body.state, 'no_bookings');
  });

  test('Initial admin is created from ADMIN_INITIAL_PASSWORD when no users exist', async () => {
    const env = { ...ENV, ADMIN_INITIAL_USERNAME: 'boss', ADMIN_INITIAL_PASSWORD: 'FirstRunPass123!' };
    const fresh = createInMemoryDatabase();
    resetBootstrapState();
    const freshApp = createApp(() => fresh);
    const res = await freshApp.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'FirstRunPass123!' }),
    }, env);
    assert.equal(res.status, 200);
  });
});
