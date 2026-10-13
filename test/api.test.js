import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createInMemoryDatabase } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { createEvent } from '../src/domain/events.js';
import { createBooking } from '../src/domain/bookings.js';

describe('HTTP API & Authentication Integration Tests', () => {
  let db;
  let app;
  let adminCookie;
  let operatorCookie;

  beforeEach(async () => {
    db = createInMemoryDatabase();
    app = createApp(db);

    // Seed admin user
    const adminHash = hashPassword('AdminPass123!');
    db.prepare('INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, ?, ?)')
      .run('adminuser', adminHash, 'admin', 1);

    // Seed operator user
    const opHash = hashPassword('OperatorPass123!');
    db.prepare('INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, ?, ?)')
      .run('operatoruser', opHash, 'operator', 1);

    // Login as admin to get session cookie
    const adminLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'adminuser', password: 'AdminPass123!' });
    adminCookie = adminLoginRes.headers['set-cookie'];

    // Login as operator to get session cookie
    const opLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'operatoruser', password: 'OperatorPass123!' });
    operatorCookie = opLoginRes.headers['set-cookie'];
  });

  test('Security headers are present on responses', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-security-policy']);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('Public access to /login succeeds; /dashboard redirects to /login if unauthenticated', async () => {
    const loginRes = await request(app).get('/login');
    assert.equal(loginRes.status, 200);

    const dashRes = await request(app).get('/dashboard');
    assert.equal(dashRes.status, 302);
    assert.equal(dashRes.headers.location, '/login');
  });

  test('Unauthenticated API requests return 401 Unauthorized', async () => {
    const res = await request(app).get('/api/events');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  test('Login failure with incorrect password returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'adminuser', password: 'WrongPassword' });

    assert.equal(res.status, 401);
    assert.ok(res.body.message.includes('Invalid username or password'));
  });

  test('Authenticated user can access /api/auth/me', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', adminCookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'adminuser');
    assert.equal(res.body.user.role, 'admin');
  });

  test('Admin user management endpoints work for admin and are blocked for operator', async () => {
    // 1. Operator attempts to access /api/admin/users -> 403 Forbidden
    const opAttempt = await request(app)
      .get('/api/admin/users')
      .set('Cookie', operatorCookie);
    assert.equal(opAttempt.status, 403);

    // 2. Admin accesses /api/admin/users -> 200 OK
    const adminGet = await request(app)
      .get('/api/admin/users')
      .set('Cookie', adminCookie);
    assert.equal(adminGet.status, 200);
    assert.ok(Array.isArray(adminGet.body.users));

    // 3. Admin creates new approved user
    const createRes = await request(app)
      .post('/api/admin/users')
      .set('Cookie', adminCookie)
      .send({
        username: 'newvolunteer',
        password: 'VolunteerPass123!',
        role: 'operator'
      });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.user.username, 'newvolunteer');
    const newUserId = createRes.body.user.id;

    // 4. Admin toggles user status (disable)
    const toggleRes = await request(app)
      .patch(`/api/admin/users/${newUserId}/status`)
      .set('Cookie', adminCookie)
      .send({ is_active: false });
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.body.user.is_active, 0);

    // 5. Admin resets password
    const resetRes = await request(app)
      .post(`/api/admin/users/${newUserId}/password`)
      .set('Cookie', adminCookie)
      .send({ password: 'BrandNewPassword123!' });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.body.success, true);
  });

  test('Gate check-in API endpoint validates barcodes', async () => {
    // Create event and booking
    const ev = createEvent(db, {
      name: 'Test Gate Event',
      event_date: '2026-11-05 18:00:00',
      capacity: 100
    });

    const bookingRes = createBooking(db, {
      event_id: ev.id,
      customer: { name: 'Gate Attendee', email: 'attendee@example.com' },
      tickets: [{ ticket_type: 'Standard', price: 10.00 }]
    });

    const barcode = bookingRes.tickets[0].barcode;

    // Check in with operator cookie
    const checkInRes1 = await request(app)
      .post('/api/tickets/checkin')
      .set('Cookie', operatorCookie)
      .send({ barcode });

    assert.equal(checkInRes1.status, 200);
    assert.equal(checkInRes1.body.success, true);

    // Second check in
    const checkInRes2 = await request(app)
      .post('/api/tickets/checkin')
      .set('Cookie', operatorCookie)
      .send({ barcode });

    assert.equal(checkInRes2.status, 409);
    assert.equal(checkInRes2.body.ticket.already_checked_in, true);
  });

  test('Reports and CSV export endpoints', async () => {
    const repRes = await request(app)
      .get('/api/reports/dashboard')
      .set('Cookie', operatorCookie);
    assert.equal(repRes.status, 200);
    assert.ok(repRes.body.financials);

    const csvRes = await request(app)
      .get('/api/reports/export.csv')
      .set('Cookie', operatorCookie);
    assert.equal(csvRes.status, 200);
    assert.equal(csvRes.headers['content-type'], 'text/csv; charset=utf-8');
  });
});
