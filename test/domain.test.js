import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDatabase } from '../src/db/index.js';
import { createEvent, listEvents, getEventById } from '../src/domain/events.js';
import { createOrUpdateCustomer, getCustomerById, searchCustomers } from '../src/domain/customers.js';
import { createDiscountCode, getDiscountCode, calculateDiscount, recordDiscountUsage } from '../src/domain/discounts.js';
import { checkInTicket, getTicketByBarcode } from '../src/domain/tickets.js';
import { createBooking, getBookingById, listBookings } from '../src/domain/bookings.js';
import { getDashboardSummary, getTicketTypeBreakdown, exportBookingsCsv } from '../src/domain/reports.js';

describe('Fireworks Domain Logic & Data Model', () => {
  let db;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });

  test('Event creation and retrieval', () => {
    const ev = createEvent(db, {
      name: 'Bonfire Night 2026',
      description: 'Annual village fireworks',
      event_date: '2026-11-05 18:30:00',
      venue: 'Recreation Ground',
      capacity: 500
    });

    assert.ok(ev.id);
    assert.equal(ev.name, 'Bonfire Night 2026');
    assert.equal(ev.capacity, 500);

    const retrieved = getEventById(db, ev.id);
    assert.equal(retrieved.name, 'Bonfire Night 2026');

    const list = listEvents(db);
    assert.equal(list.length, 1);
  });

  test('Customer storage with field-level encryption and blind indexing', () => {
    const customer = createOrUpdateCustomer(db, {
      name: 'Alice Johnson',
      email: 'alice@example.com',
      phone: '07700 900111',
      postcode: 'OX1 1AA'
    });

    assert.ok(customer.id);
    assert.equal(customer.name, 'Alice Johnson');
    assert.equal(customer.email, 'alice@example.com');

    // Verify in raw DB that email is encrypted, not stored in plaintext
    const rawRow = db.prepare('SELECT email_encrypted, phone_encrypted, email_blind_index FROM customers WHERE id = ?').get(customer.id);
    assert.ok(rawRow.email_encrypted);
    assert.ok(rawRow.email_encrypted.includes(':')); // iv:tag:ciphertext
    assert.notEqual(rawRow.email_encrypted, 'alice@example.com');
    assert.ok(rawRow.email_blind_index);

    // Retrieve and decrypt
    const decrypted = getCustomerById(db, customer.id);
    assert.equal(decrypted.name, 'Alice Johnson');
    assert.equal(decrypted.email, 'alice@example.com');
    assert.equal(decrypted.phone, '07700 900111');
    assert.equal(decrypted.postcode, 'OX1 1AA');

    // Lookup customer by email
    const results = searchCustomers(db, 'alice@example.com');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, customer.id);
  });

  test('Discount codes: percentage and fixed amount calculations', () => {
    const pctCode = createDiscountCode(db, {
      code: 'DISCOUNT20',
      discount_type: 'percent',
      discount_value: 20
    });

    const fixedCode = createDiscountCode(db, {
      code: 'FIVEPOUNDSOFF',
      discount_type: 'fixed',
      discount_value: 5
    });

    assert.equal(pctCode.code, 'DISCOUNT20');
    assert.equal(fixedCode.code, 'FIVEPOUNDSOFF');

    // Test calculations
    const calc1 = calculateDiscount(pctCode, 100);
    assert.equal(calc1.discountAmount, 20);
    assert.equal(calc1.total, 80);

    const calc2 = calculateDiscount(fixedCode, 30);
    assert.equal(calc2.discountAmount, 5);
    assert.equal(calc2.total, 25);

    // Fixed discount cannot exceed subtotal
    const calc3 = calculateDiscount(fixedCode, 3);
    assert.equal(calc3.discountAmount, 3);
    assert.equal(calc3.total, 0);

    // Track usage
    recordDiscountUsage(db, pctCode.code, 20, 80);
    const updated = getDiscountCode(db, 'DISCOUNT20');
    assert.equal(updated.times_used, 1);
    assert.equal(updated.total_savings_generated, 20);
    assert.equal(updated.total_revenue_associated, 80);
  });

  test('Booking creation, ticket issuance, and check-in flow', () => {
    const ev = createEvent(db, {
      name: 'Autumn Fireworks',
      event_date: '2026-11-05 19:00:00',
      capacity: 300
    });

    createDiscountCode(db, {
      code: 'SAVE10',
      discount_type: 'percent',
      discount_value: 10
    });

    const bookingResult = createBooking(db, {
      event_id: ev.id,
      customer: {
        name: 'Bob Smith',
        email: 'bob@example.com',
        phone: '07700 900222',
        postcode: 'OX2 2BB'
      },
      tickets: [
        { ticket_type: 'Adult', price: 10.00 },
        { ticket_type: 'Adult', price: 10.00 },
        { ticket_type: 'Child', price: 5.00 }
      ],
      discount_code: 'SAVE10',
      payment_method: 'card'
    });

    const b = bookingResult.booking;
    assert.ok(b.id);
    assert.ok(b.booking_reference.startsWith('FB-'));
    assert.equal(b.subtotal_amount, 25.00);
    assert.equal(b.discount_amount, 2.50);
    assert.equal(b.total_amount, 22.50);
    assert.equal(b.status, 'confirmed');

    // Verify tickets were created
    const tickets = bookingResult.tickets;
    assert.equal(tickets.length, 3);
    assert.ok(tickets[0].barcode);

    // Gate check-in for ticket 0
    const t0 = tickets[0];
    const checkIn1 = checkInTicket(db, t0.barcode);
    assert.equal(checkIn1.success, true);
    assert.equal(checkIn1.ticket.checked_in, 1);

    // Second check-in attempt must fail / flag already checked in
    const checkIn2 = checkInTicket(db, t0.barcode);
    assert.equal(checkIn2.success, false);
    assert.equal(checkIn2.already_checked_in, true);

    // Verify reports
    const dashboard = getDashboardSummary(db);
    assert.equal(dashboard.financials.gross_revenue, 22.50);
    assert.equal(dashboard.financials.confirmed_bookings, 1);
    assert.equal(dashboard.tickets.tickets_sold, 3);
    assert.equal(dashboard.tickets.tickets_checked_in, 1);

    const tiers = getTicketTypeBreakdown(db);
    assert.equal(tiers.length, 2); // Adult and Child

    // CSV export
    const csv = exportBookingsCsv(db);
    assert.ok(csv.includes('Booking Reference'));
    assert.ok(csv.includes(b.booking_reference));
    assert.ok(csv.includes('Bob Smith'));
  });
});
