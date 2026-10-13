#!/usr/bin/env node
/**
 * CLI script to seed the database with sample Fireworks Bookings data.
 * Usage:
 *   node scripts/seed.js
 */

import { getDatabase, closeDatabase } from '../src/db/index.js';
import { createEvent, listEvents } from '../src/domain/events.js';
import { createDiscountCode, listDiscountCodes } from '../src/domain/discounts.js';
import { createBooking } from '../src/domain/bookings.js';

console.log('Seeding sample Fireworks Bookings data...');

const db = getDatabase();

try {
  // 1. Create Sample Events if none exist
  const existingEvents = listEvents(db);
  let event1Id, event2Id;

  if (existingEvents.length === 0) {
    const ev1 = createEvent(db, {
      name: 'Annual Charity Fireworks Spectacular 2026',
      description: 'Our flagship bonfire and fireworks extravaganza with food stalls, live music, and family entertainment.',
      event_date: '2026-11-07 19:30:00',
      venue: 'Scout Headquarters & Campsite Meadow',
      capacity: 1200,
      gates_open: '17:30',
      display_time: '19:45',
      status: 'active'
    });
    event1Id = ev1.id;

    const ev2 = createEvent(db, {
      name: 'Family Twilight Sparkler Night 2026',
      description: 'Quiet-friendly low-noise display tailored for younger children and sensory sensitivities.',
      event_date: '2026-11-08 17:00:00',
      venue: 'Scout Headquarters & Campsite Meadow',
      capacity: 600,
      gates_open: '16:00',
      display_time: '17:15',
      status: 'active'
    });
    event2Id = ev2.id;

    console.log('✅ Created sample events.');
  } else {
    event1Id = existingEvents[0].id;
    event2Id = existingEvents[1]?.id || existingEvents[0].id;
    console.log('ℹ️ Events already exist, using existing events.');
  }

  // 2. Create Discount Codes if none exist
  const existingDiscounts = listDiscountCodes(db);
  if (existingDiscounts.length === 0) {
    createDiscountCode(db, {
      code: 'EARLYBIRD',
      description: '15% off early ticket bookings',
      discount_type: 'percent',
      discount_value: 15,
      max_uses: 200,
      valid_until: '2026-10-31 23:59:59'
    });

    createDiscountCode(db, {
      code: 'SCOUTFAMILY',
      description: '£5.00 off group family orders',
      discount_type: 'fixed',
      discount_value: 5.00,
      max_uses: 100
    });

    createDiscountCode(db, {
      code: 'VOLUNTEER50',
      description: '50% discount for scout leaders and event volunteers',
      discount_type: 'percent',
      discount_value: 50,
      max_uses: 50
    });

    console.log('✅ Created sample discount codes.');
  }

  // 3. Create Sample Bookings with Encrypted Customer Details
  const sampleOrders = [
    {
      event_id: event1Id,
      customer: {
        name: 'Sarah Jenkins',
        email: 'sarah.jenkins@example.co.uk',
        phone: '07700 900123',
        postcode: 'OX1 2AB'
      },
      tickets: [
        { ticket_type: 'Family', price: 32.00 },
        { ticket_type: 'Adult', price: 12.00 }
      ],
      discount_code: 'EARLYBIRD',
      payment_method: 'ticketsource_card'
    },
    {
      event_id: event1Id,
      customer: {
        name: 'David Robinson',
        email: 'd.robinson@example.org',
        phone: '07700 900456',
        postcode: 'OX2 8CD'
      },
      tickets: [
        { ticket_type: 'Adult', price: 12.00 },
        { ticket_type: 'Adult', price: 12.00 },
        { ticket_type: 'Child', price: 7.00 }
      ],
      discount_code: null,
      payment_method: 'ticketsource_card'
    },
    {
      event_id: event1Id,
      customer: {
        name: 'Elena Rostova',
        email: 'elena.rostova@example.com',
        phone: '07700 900789',
        postcode: 'OX4 1EF'
      },
      tickets: [
        { ticket_type: 'VIP', price: 25.00 },
        { ticket_type: 'VIP', price: 25.00 }
      ],
      discount_code: 'SCOUTFAMILY',
      payment_method: 'ticketsource_apple_pay'
    },
    {
      event_id: event2Id,
      customer: {
        name: 'Michael & Gemma Clark',
        email: 'the.clarks@example.com',
        phone: '07700 900999',
        postcode: 'OX3 3GH'
      },
      tickets: [
        { ticket_type: 'Family', price: 28.00 },
        { ticket_type: 'Child', price: 6.00 }
      ],
      discount_code: null,
      payment_method: 'manual'
    }
  ];

  for (const order of sampleOrders) {
    const res = createBooking(db, order);
    console.log(`✅ Created booking ${res.booking.booking_reference} for customer ${order.customer.name} (£${res.booking.total_amount})`);
  }

  console.log('\n🎉 Seed data populated successfully!');
  console.log('You can now start the server with: npm start');
} catch (err) {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
} finally {
  closeDatabase();
}
