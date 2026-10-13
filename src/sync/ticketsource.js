import { createEvent, updateEvent } from '../domain/events.js';
import { createBooking, getBookingById, updateBookingStatus } from '../domain/bookings.js';
import { createDiscount } from '../domain/discounts.js';
import { config } from '../config.js';

export class TicketSourceSync {
  constructor(db, options = {}) {
    this.db = db;
    this.apiKey = options.apiKey || '';
    this.apiUrl = options.apiUrl || 'https://api.ticketsource.co.uk';
  }

  async getLatestCheckpoint() {
    return this.db.prepare(`
      SELECT * FROM sync_checkpoints
      ORDER BY id DESC
      LIMIT 1
    `).get();
  }

  async createCheckpoint(cursor = null) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sync_checkpoints (source, cursor, status, records_imported, started_at)
      VALUES ('ticketsource', ?, 'in_progress', 0, ?)
    `);
    const result = await stmt.run(cursor, now);
    return this.db.prepare('SELECT * FROM sync_checkpoints WHERE id = ?').get(result.lastInsertRowid);
  }

  async updateCheckpoint(id, updates) {
    const fields = [];
    const params = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      params.push(updates.status);
    }
    if (updates.cursor !== undefined) {
      fields.push('cursor = ?');
      params.push(updates.cursor);
    }
    if (updates.records_imported !== undefined) {
      fields.push('records_imported = ?');
      params.push(updates.records_imported);
    }
    if (updates.error_message !== undefined) {
      fields.push('error_message = ?');
      params.push(updates.error_message);
    }
    if (updates.completed_at !== undefined) {
      fields.push('completed_at = ?');
      params.push(updates.completed_at);
    }

    if (fields.length === 0) return;

    params.push(id);
    await this.db.prepare(`UPDATE sync_checkpoints SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  async logSyncAction(checkpointId, action, reference, message) {
    const now = new Date().toISOString();
    await this.db.prepare(`
      INSERT INTO sync_logs (checkpoint_id, action, reference, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(checkpointId, action, reference || null, message || null, now);
  }

  async getRecentLogs(limit = 50) {
    return this.db.prepare(`
      SELECT l.*, c.status AS checkpoint_status
      FROM sync_logs l
      LEFT JOIN sync_checkpoints c ON l.checkpoint_id = c.id
      ORDER BY l.id DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Ingests a single standardized TicketSource order/booking object.
   * Handles idempotency (does not duplicate bookings with identical reference).
   */
  async ingestBooking(orderData, checkpointId = null) {
    const existing = await this.db.prepare('SELECT id, status FROM bookings WHERE reference = ?').get(orderData.reference);
    if (existing) {
      // If status changed, update it
      if (orderData.status && orderData.status !== existing.status) {
        await updateBookingStatus(this.db, existing.id, orderData.status);
        if (checkpointId) {
          await this.logSyncAction(checkpointId, 'update_booking', orderData.reference, `Updated status to ${orderData.status}`);
        }
      }
      return await getBookingById(this.db, existing.id);
    }

    // Ensure event exists
    let event = await this.db.prepare('SELECT id FROM events WHERE id = ?').get(orderData.eventId);
    if (!event) {
      event = await createEvent(this.db, {
        id: orderData.eventId,
        name: orderData.eventName || 'Fireworks Night Event',
        venue: orderData.eventVenue || 'Scout Activity Centre',
        event_date: orderData.eventDate || new Date().toISOString(),
        capacity: orderData.eventCapacity || 1000,
      });
      if (checkpointId) {
        await this.logSyncAction(checkpointId, 'import_event', event.id, `Created event ${event.name}`);
      }
    }

    // Ensure discount code exists if given
    if (orderData.discountCode) {
      const discount = await this.db.prepare('SELECT id FROM discount_codes WHERE UPPER(code) = ?').get(orderData.discountCode.toUpperCase());
      if (!discount) {
        await createDiscount(this.db, {
          code: orderData.discountCode,
          description: `Imported TicketSource Promo ${orderData.discountCode}`,
          discount_type: orderData.discountType || 'fixed',
          discount_value: orderData.discountValue || 5.0,
        });
      }
    }

    const booking = await createBooking(this.db, {
      reference: orderData.reference,
      eventId: orderData.eventId,
      bookingDate: orderData.bookingDate,
      status: orderData.status || 'confirmed',
      customer: orderData.customer,
      tickets: orderData.tickets,
      discountCode: orderData.discountCode,
      paymentMethod: orderData.paymentMethod || 'TicketSource Online',
      paymentReference: orderData.paymentReference,
      notes: orderData.notes,
    });

    if (checkpointId) {
      await this.logSyncAction(
        checkpointId,
        'import_booking',
        booking.reference,
        `Imported booking for ${orderData.tickets.length} tickets (${booking.total_price})`
      );
    }

    return booking;
  }

  /**
   * Resumable sync orchestrator.
   * Continues from previous checkpoint cursor if available.
   */
  async runSync(options = {}) {
    const lastCheckpoint = await this.getLatestCheckpoint();
    const resumeCursor = options.cursor || (lastCheckpoint && lastCheckpoint.status === 'completed' ? lastCheckpoint.cursor : null);

    const checkpoint = await this.createCheckpoint(resumeCursor);
    let importedCount = 0;

    try {
      // Fetch batches from TicketSource or simulated provider
      const batch = await this.fetchBatch({
        cursor: resumeCursor,
        limit: options.batchSize || 50,
      });

      for (const order of batch.records) {
        await this.ingestBooking(order, checkpoint.id);
        importedCount++;
      }

      const nextCursor = batch.nextCursor || new Date().toISOString();
      const completedAt = new Date().toISOString();

      await this.updateCheckpoint(checkpoint.id, {
        status: 'completed',
        cursor: nextCursor,
        records_imported: importedCount,
        completed_at: completedAt,
      });

      await this.logSyncAction(
        checkpoint.id,
        'sync_completed',
        `Cursor: ${nextCursor}`,
        `Successfully synced ${importedCount} records`
      );

      return {
        success: true,
        checkpointId: checkpoint.id,
        importedCount,
        nextCursor,
        hasMore: Boolean(batch.hasMore),
      };
    } catch (err) {
      await this.updateCheckpoint(checkpoint.id, {
        status: 'failed',
        error_message: err.message,
        records_imported: importedCount,
        completed_at: new Date().toISOString(),
      });

      await this.logSyncAction(checkpoint.id, 'error', null, `Sync failed: ${err.message}`);

      return {
        success: false,
        checkpointId: checkpoint.id,
        error: err.message,
        importedCount,
      };
    }
  }

  /**
   * Fetch batch implementation:
   * If real API key is configured, connects to TicketSource REST API.
   * Otherwise, provides realistic simulated Fireworks booking records for testing/demo.
   */
  async fetchBatch({ cursor, limit = 10 }) {
    if (this.apiKey) {
      // Live TicketSource API integration
      // TicketSource REST API: GET /api/v1/orders
      const url = new URL(`${this.apiUrl}/api/v1/orders`);
      url.searchParams.set('limit', String(limit));
      if (cursor) {
        url.searchParams.set('since', cursor);
      }

      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': 'Bearer ' + this.apiKey,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`TicketSource API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return this.transformTicketSourceApiResponse(data);
    }

    // Never fabricate bookings in production.
    if (config.isProd) {
      throw new Error('TICKETSOURCE_API_KEY is not configured; sync is unavailable');
    }

    // Simulated ingestion data (dev/demo only)
    return this.generateSimulatedBatch(cursor, limit);
  }

  generateSimulatedBatch(cursor, limit) {
    const baseNumber = cursor ? parseInt(cursor.replace(/[^0-9]/g, '') || '100', 10) : 100;
    const records = [];

    const ticketTypes = [
      { name: 'Adult (16+)', price: 12.0 },
      { name: 'Child (5-15)', price: 7.0 },
      { name: 'Family (2 Adults, 2 Children)', price: 32.0 },
      { name: 'Under 5 (Free)', price: 0.0 },
      { name: 'VIP Viewing Deck', price: 25.0 },
    ];

    const sampleNames = [
      { name: 'Sarah Jenkins', email: 'sarah.j@example.co.uk', phone: '07700900123', postcode: 'OX1 2AB' },
      { name: 'David Thompson', email: 'd.thompson@example.com', phone: '07700900456', postcode: 'OX2 8RT' },
      { name: 'Emma Watson', email: 'emma.w@example.org', phone: '07700900789', postcode: 'OX4 1XZ' },
      { name: 'James Miller', email: 'j.miller@example.co.uk', phone: '07700900321', postcode: 'OX3 5QW' },
      { name: 'Claire Davies', email: 'claire.d@example.com', phone: '07700900654', postcode: 'OX5 2LK' },
    ];

    const sampleCount = Math.min(limit, 5);
    for (let i = 0; i < sampleCount; i++) {
      const idx = (baseNumber + i) % sampleNames.length;
      const person = sampleNames[idx];
      const orderRef = `TS-${baseNumber + i + 1000}`;
      const tt = ticketTypes[i % ticketTypes.length];

      records.push({
        reference: orderRef,
        eventId: 'evt_fireworks_2026',
        eventName: 'Annual Scouts Fireworks Spectacular 2026',
        eventVenue: 'Meadow Activity Centre & Campsite',
        eventDate: '2026-11-07T18:00:00Z',
        eventCapacity: 1500,
        bookingDate: new Date(Date.now() - (sampleCount - i) * 3600000).toISOString(),
        status: 'confirmed',
        customer: {
          name: person.name,
          email: `${person.email.split('@')[0]}+${baseNumber + i}@${person.email.split('@')[1]}`,
          phone: person.phone,
          postcode: person.postcode,
        },
        discountCode: i % 3 === 0 ? 'EARLYBIRD' : null,
        discountType: 'fixed',
        discountValue: 2.0,
        paymentMethod: 'TicketSource Stripe',
        paymentReference: `ch_${orderRef}`,
        tickets: [
          {
            ticketType: tt.name,
            price: tt.price,
            barcode: `BC-${orderRef}-1`,
          },
        ],
      });
    }

    const nextCursor = `ts_cursor_${baseNumber + sampleCount}`;
    return {
      records,
      nextCursor,
      hasMore: false,
    };
  }

  transformTicketSourceApiResponse(data) {
    const records = (data.orders || data.data || []).map((order) => {
      const tickets = (order.tickets || []).map((t) => ({
        ticketType: t.ticket_type || t.name || 'Standard',
        price: parseFloat(t.price || 0),
        barcode: t.barcode || t.ref,
      }));

      return {
        reference: order.reference || order.id,
        eventId: order.event_id || 'evt_default',
        eventName: order.event_name,
        eventVenue: order.venue,
        eventDate: order.event_date,
        bookingDate: order.created_at || new Date().toISOString(),
        status: order.status === 'refunded' ? 'refunded' : order.status === 'cancelled' ? 'cancelled' : 'confirmed',
        customer: {
          name: order.customer_name || `${order.first_name || ''} ${order.last_name || ''}`.trim(),
          email: order.customer_email || order.email,
          phone: order.customer_phone || order.phone,
          postcode: order.postcode,
        },
        discountCode: order.discount_code,
        discountAmount: parseFloat(order.discount_amount || 0),
        paymentMethod: order.payment_method || 'TicketSource Online',
        paymentReference: order.payment_ref,
        tickets,
      };
    });

    return {
      records,
      nextCursor: data.next_cursor || data.pagination?.next_cursor,
      hasMore: Boolean(data.next_cursor || data.pagination?.has_more),
    };
  }
}

export function generateSimulatedBatch(limit = 5) {
  const records = [];
  const sampleNames = [
    { name: 'Sarah Jenkins', email: 'sarah.j@example.co.uk', phone: '07700 900123', postcode: 'OX1 2AB' },
    { name: 'David Thompson', email: 'd.thompson@example.com', phone: '07700 900456', postcode: 'OX2 8RT' },
    { name: 'Emma Watson', email: 'emma.w@example.org', phone: '07700 900789', postcode: 'OX4 1XZ' },
    { name: 'James Miller', email: 'j.miller@example.co.uk', phone: '07700 900321', postcode: 'OX3 5QW' },
    { name: 'Claire Davies', email: 'claire.d@example.com', phone: '07700 900654', postcode: 'OX5 2LK' },
  ];

  for (let i = 0; i < limit; i++) {
    const person = sampleNames[i % sampleNames.length];
    const orderRef = `TS-SIM-${1000 + i}`;
    records.push({
      reference: orderRef,
      customer: {
        name: person.name,
        email: `${person.email.split('@')[0]}+${i}@${person.email.split('@')[1]}`,
        phone: person.phone,
        postcode: person.postcode,
      },
      tickets: [
        { type: 'Standard', ticket_type: 'Standard', price: 10.00 },
        { type: 'Child', ticket_type: 'Child', price: 5.00 },
      ],
      subtotal: 15.00,
      discount: 0,
      total: 15.00,
      status: 'confirmed',
      payment_method: 'ticketsource_online',
    });
  }
  return records;
}

export async function getSyncStatus(db) {
  const row = await db.prepare('SELECT * FROM sync_checkpoints ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    return { checkpoint: null, status: 'idle' };
  }
  return {
    status: row.status,
    checkpoint: {
      ...row,
      last_sync_cursor: row.last_sync_cursor || row.cursor,
    },
  };
}

export async function runSync(db, options = {}) {
  const batch = options.customBatch || generateSimulatedBatch(options.batchSize || 10);
  const now = new Date().toISOString();

  // Create checkpoint
  const insertStmt = db.prepare(`
    INSERT INTO sync_checkpoints (source, cursor, last_sync_cursor, status, records_imported, started_at)
    VALUES ('ticketsource', NULL, NULL, 'in_progress', 0, ?)
  `);
  const res = await insertStmt.run(now);
  const checkpointId = res.lastInsertRowid;

  // Find or create default event
  let event = await db.prepare('SELECT id FROM events LIMIT 1').get();
  if (!event) {
    event = await createEvent(db, {
      name: 'Default Fireworks Night',
      event_date: '2026-11-05 19:30:00',
      capacity: 1000,
    });
  }

  let imported = 0;
  for (const order of batch) {
    const existing = await db.prepare('SELECT id FROM bookings WHERE reference = ?').get(order.reference);
    if (!existing) {
      await createBooking(db, {
        event_id: order.eventId || order.event_id || event.id,
        reference: order.reference,
        customer: order.customer,
        tickets: (order.tickets || []).map((t) => ({
          ticket_type: t.ticket_type || t.type || t.ticketType || 'Standard',
          price: t.price || 0,
        })),
        payment_method: order.payment_method || 'ticketsource',
        status: order.status || 'confirmed',
      });
    }
    imported++;
  }

  const cursor = `ts_cursor_${Date.now()}`;
  const completedAt = new Date().toISOString();
  await db.prepare(`
    UPDATE sync_checkpoints
    SET status = 'completed', records_imported = ?, cursor = ?, last_sync_cursor = ?, completed_at = ?
    WHERE id = ?
  `).run(imported, cursor, cursor, completedAt, checkpointId);

  return {
    success: true,
    imported,
    errors: 0,
    checkpointId,
  };
}

export async function ingestWebhookEvent(db, webhookPayload) {
  const data = webhookPayload?.data || webhookPayload?.order || webhookPayload;
  if (!data || !data.reference) {
    throw new Error('Invalid webhook payload: reference required');
  }

  const existing = await db.prepare('SELECT id FROM bookings WHERE reference = ?').get(data.reference);
  if (existing) {
    return {
      status: 'already_processed',
      reference: data.reference,
    };
  }

  let event = await db.prepare('SELECT id FROM events LIMIT 1').get();
  if (!event) {
    event = await createEvent(db, {
      name: 'Default Fireworks Night',
      event_date: '2026-11-05 19:30:00',
      capacity: 1000,
    });
  }

  const booking = await createBooking(db, {
    event_id: data.eventId || data.event_id || event.id,
    reference: data.reference,
    customer: data.customer,
    tickets: (data.tickets || []).map((t) => ({
      ticket_type: t.ticket_type || t.type || t.ticketType || 'Standard',
      price: t.price || 0,
    })),
    payment_method: data.payment_method,
    status: data.status || 'confirmed',
  });

  return {
    status: 'created',
    reference: data.reference,
    booking,
  };
}

export default {
  TicketSourceSync,
  generateSimulatedBatch,
  getSyncStatus,
  runSync,
  ingestWebhookEvent,
};
