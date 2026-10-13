import { createEvent, updateEvent } from '../domain/events.js';
import { createBooking, getBookingById, updateBookingStatus } from '../domain/bookings.js';
import { createDiscount } from '../domain/discounts.js';
import { config } from '../config.js';

export class TicketSourceSync {
  constructor(db, options = {}) {
    this.db = db;
    this.apiKey = options.apiKey || '';
    this.apiUrl = options.apiUrl || 'https://api.ticketsource.io';
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
        limit: options.batchSize || 10,
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
    if (this.apiKey) return this.fetchLiveBatch({ limit });

    // Never fabricate bookings in production.
    if (config.isProd) {
      throw new Error('TICKETSOURCE_API_KEY is not configured; sync is unavailable');
    }

    // Simulated ingestion data (dev/demo only)
    return this.generateSimulatedBatch(cursor, limit);
  }

  /** GET against the TicketSource API (https://reference.ticketsource.io). Accepts absolute URLs from `links`. */
  async api(pathOrUrl, params = {}) {
    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || '';
      } catch {
        // non-JSON error body
      }
      throw new Error(`TicketSource API error: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ''} (${url.pathname})`);
    }
    return res.json();
  }

  /** Follows `links.next` until exhausted (or maxPages), returning every `data` item. */
  async apiList(path, params = {}, maxPages = 10) {
    const items = [];
    let next = path;
    let query = { per_page: 100, ...params };
    for (let page = 0; next && page < maxPages; page++) {
      const body = await this.api(next, query);
      items.push(...(body.data || []));
      next = body.links?.next || null;
      query = {}; // `next` is a complete URL
    }
    return items;
  }

  /**
   * Live import. TicketSource exposes bookings per performance date
   * (events -> dates -> bookings), with the customer and seats behind separate
   * links, so we walk that tree and only fetch details for bookings we have not
   * imported yet, stopping once `limit` new ones are collected. Run sync again to
   * continue (hasMore is true while there may be more).
   */
  async fetchLiveBatch({ limit }) {
    const records = [];
    let hasMore = false;
    const customers = new Map();

    const events = (await this.apiList('/events')).filter((e) => !e.attributes?.archived);

    outer: for (const ev of events) {
      const dates = await this.apiList(`/events/${ev.id}/dates`);
      for (const date of dates) {
        let next = `/dates/${date.id}/bookings`;
        let query = { per_page: 50 };

        for (let page = 0; next && page < 20; page++) {
          const body = await this.api(next, query);
          next = body.links?.next || null;
          query = {};

          const bookings = body.data || [];
          if (bookings.length === 0) continue;

          const refs = bookings.map((b) => b.attributes.ref);
          const known = await this.db
            .prepare(`SELECT id, reference, status FROM bookings WHERE reference IN (${refs.map(() => '?').join(',')})`)
            .all(...refs);
          const knownByRef = new Map(known.map((k) => [k.reference.toUpperCase(), k]));

          for (const b of bookings) {
            const status = this.bookingStatus(b);
            const existing = knownByRef.get(String(b.attributes.ref).toUpperCase());

            if (existing) {
              if (existing.status !== status) {
                await updateBookingStatus(this.db, existing.id, status);
              }
              continue;
            }

            if (records.length >= limit) {
              hasMore = true;
              break outer;
            }
            records.push(await this.transformBooking(b, ev, date, customers));
          }
        }
      }
    }

    return { records, nextCursor: new Date().toISOString(), hasMore };
  }

  /** Sums the booking's payment lines (refund lines subtract). */
  bookingTotals(booking) {
    let gross = 0;
    let discount = 0;
    let refunded = 0;
    let paid = 0;
    const notes = [];
    for (const line of booking.attributes.lines || []) {
      const amt = line.amount || {};
      const sign = line.is_refund ? -1 : 1;
      const lineGross = Number(amt.gross) || 0;
      if (line.is_refund) refunded += lineGross;
      else paid += lineGross;
      if (line.line_type === 'TICKETS') gross += sign * lineGross;
      const code = amt.discounts?.code;
      if (code && Number(code.amount) > 0) {
        discount += Number(code.amount);
        notes.push(`Discount ${code.description || 'code'}: -${Number(code.amount).toFixed(2)}`);
      }
      if (Number(amt.discounts?.automatic) > 0) discount += Number(amt.discounts.automatic);
    }
    return { gross: Math.max(0, gross), discount, refunded, paid, notes };
  }

  bookingStatus(booking) {
    const { paid, refunded } = this.bookingTotals(booking);
    return paid > 0 && refunded >= paid ? 'refunded' : 'confirmed';
  }

  async transformBooking(booking, ev, date, customerCache) {
    const totals = this.bookingTotals(booking);
    const attrs = booking.attributes;

    // Customer (separate resource, cached per run)
    let customer = { name: 'Anonymous Guest', email: `${attrs.ref}@no-email.invalid` };
    const customerLink = booking.links?.customer;
    if (customerLink) {
      if (!customerCache.has(customerLink)) {
        try {
          customerCache.set(customerLink, (await this.api(customerLink)).data?.attributes || {});
        } catch {
          customerCache.set(customerLink, {});
        }
      }
      const c = customerCache.get(customerLink);
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
      customer = {
        name: name || customer.name,
        email: c.email || customer.email,
        phone: c.telephone || c.phone || null,
        postcode: c.address?.postcode || c.address?.postal_code || c.address?.post_code || null,
      };
    }

    // Seats carry the price category (ticket type). The API exposes no per-seat price or barcode.
    const seats = (await this.apiList(`/bookings/${booking.id}/seats`)).filter((x) => !x.attributes?.is_cancelled);
    const each = seats.length > 0 ? totals.gross / seats.length : 0;
    const tickets = seats.length > 0
      ? seats.map((seat, i) => ({
          ticketType: seat.attributes?.price_category || 'Standard',
          price: Math.round(each * 100) / 100,
          barcode: `${attrs.ref}-${i + 1}`,
        }))
      : [{ ticketType: 'Standard', price: totals.gross, barcode: `${attrs.ref}-1` }];

    const dateAttrs = date.attributes || {};
    return {
      reference: attrs.ref,
      eventId: date.id,
      eventName: ev.attributes?.name || 'TicketSource event',
      eventDate: dateAttrs.start || attrs.created_at,
      bookingDate: attrs.created_at,
      status: this.bookingStatus(booking),
      customer,
      discountCode: null,
      paymentMethod: (attrs.lines || [])[0]?.payment_method ? `TicketSource ${attrs.lines[0].payment_method}` : 'TicketSource Online',
      paymentReference: booking.id,
      notes: [`TicketSource booking ${booking.id}`, ...totals.notes].join('; '),
      tickets,
    };
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
