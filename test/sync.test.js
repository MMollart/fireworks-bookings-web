import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDatabase } from './helpers/db.js';
import { runSync, getSyncStatus, ingestWebhookEvent, generateSimulatedBatch } from '../src/sync/ticketsource.js';
import { createEvent } from '../src/domain/events.js';
import { listBookings } from '../src/domain/bookings.js';

describe('Resumable Sync & TicketSource Ingestion', () => {
  let db;

  beforeEach(async () => {
    db = createInMemoryDatabase();
    // Ensure an event exists for ingestion mapping
    await createEvent(db, {
      name: 'Default Fireworks Night',
      event_date: '2026-11-05 19:30:00',
      capacity: 1000
    });
  });

  test('generates simulated batch with valid order structure', async () => {
    const batch = generateSimulatedBatch(5);
    assert.equal(batch.length, 5);
    const order = batch[0];
    assert.ok(order.reference);
    assert.ok(order.customer.name);
    assert.ok(order.customer.email);
    assert.ok(Array.isArray(order.tickets));
    assert.ok(order.tickets.length >= 1);
  });

  test('runs sync, creates checkpoint and ingests orders', async () => {
    const statusBefore = await getSyncStatus(db);
    assert.equal(statusBefore.checkpoint, null);

    const result = await runSync(db, { batchSize: 3 });
    assert.equal(result.success, true);
    assert.equal(result.imported, 3);
    assert.equal(result.errors, 0);

    const statusAfter = await getSyncStatus(db);
    assert.ok(statusAfter.checkpoint);
    assert.equal(statusAfter.checkpoint.status, 'completed');
    assert.equal(statusAfter.checkpoint.records_imported, 3);
    assert.ok(statusAfter.checkpoint.last_sync_cursor);

    // Verify bookings exist in the database
    const bookings = await listBookings(db);
    assert.equal(bookings.length, 3);
  });

  test('idempotency: re-ingesting existing orders does not duplicate records', async () => {
    const batch = generateSimulatedBatch(2);

    // Ingest first time
    const res1 = await runSync(db, { customBatch: batch });
    assert.equal(res1.imported, 2);

    const bookingsAfterFirst = await listBookings(db);
    assert.equal(bookingsAfterFirst.length, 2);

    // Ingest same batch again
    const res2 = await runSync(db, { customBatch: batch });
    assert.equal(res2.imported, 2);

    // Bookings count must remain 2, not 4
    const bookingsAfterSecond = await listBookings(db);
    assert.equal(bookingsAfterSecond.length, 2);
  });

  test('processes incoming webhook event in real time', async () => {
    const webhookPayload = {
      event: 'booking.created',
      data: {
        reference: 'TS-WEBHOOK-999',
        customer: {
          name: 'Webhook Tester',
          email: 'webhook@example.com',
          phone: '07700 900888',
          postcode: 'OX5 5ZZ'
        },
        tickets: [
          { type: 'VIP', price: 25.00 }
        ],
        subtotal: 25.00,
        discount: 0,
        total: 25.00,
        payment_method: 'ticketsource_apple_pay'
      }
    };

    const webhookResult = await ingestWebhookEvent(db, webhookPayload);
    assert.equal(webhookResult.status, 'created');
    assert.equal(webhookResult.reference, 'TS-WEBHOOK-999');

    // Re-processing same webhook is idempotent
    const duplicateResult = await ingestWebhookEvent(db, webhookPayload);
    assert.equal(duplicateResult.status, 'already_processed');
  });
});
