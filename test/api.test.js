import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDatabase } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { initConfig } from '../src/config.js';
import { resetBootstrapState } from '../src/db/index.js';
import { hashPassword } from '../src/auth/passwords.js';
import { createEvent } from '../src/domain/events.js';
import { createBooking } from '../src/domain/bookings.js';

const ENV = { NODE_ENV: 'test', TICKETSOURCE_WEBHOOK_SECRET: 'whsec_test' };

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
    assert.equal((await call('GET', '/api/sync/status')).status, 401);
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
    const create = await call('POST', '/api/events', { cookie: viewerCookie, json: { name: 'X', event_date: '2026-11-05' } });
    assert.equal(create.status, 403);
    assert.equal((await call('POST', '/api/tickets/checkin', { cookie: viewerCookie, json: { barcode: 'x' } })).status, 403);
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

  test('Gate check-in API endpoint validates barcodes', async () => {
    const ev = await createEvent(db, { name: 'Test Gate Event', event_date: '2026-11-05 18:00:00', capacity: 100 });
    const booking = await createBooking(db, {
      event_id: ev.id,
      customer: { name: 'Gate Attendee', email: 'attendee@example.com' },
      tickets: [{ ticket_type: 'Standard', price: 10.0 }],
    });
    const barcode = booking.tickets[0].barcode;

    const first = await call('POST', '/api/tickets/checkin', { cookie: operatorCookie, json: { barcode } });
    assert.equal(first.status, 200);
    assert.equal(first.body.success, true);

    const second = await call('POST', '/api/tickets/checkin', { cookie: operatorCookie, json: { barcode } });
    assert.equal(second.status, 409);
    assert.equal(second.body.ticket.already_checked_in, true);
  });

  test('Reports and CSV export endpoints', async () => {
    const rep = await call('GET', '/api/reports/dashboard', { cookie: operatorCookie });
    assert.equal(rep.status, 200);
    assert.ok(rep.body.financials);

    const csv = await call('GET', '/api/reports/export.csv', { cookie: operatorCookie });
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  });

  test('Webhook requires the shared secret', async () => {
    const ev = await createEvent(db, { name: 'Hook Event', event_date: '2026-11-05 18:00:00', capacity: 100 });
    const payload = {
      reference: 'TS-HOOK-1',
      eventId: ev.id,
      customer: { name: 'Hook', email: 'hook@example.com' },
      tickets: [{ ticketType: 'Adult', price: 10 }],
    };
    assert.equal((await call('POST', '/api/sync/webhook', { json: payload })).status, 401);
    const ok = await call('POST', '/api/sync/webhook', { json: payload, headers: { 'x-webhook-secret': 'whsec_test' } });
    assert.equal(ok.status, 200);
    const list = await call('GET', '/api/bookings', { cookie: adminCookie });
    assert.equal(list.body.count, 1);
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
