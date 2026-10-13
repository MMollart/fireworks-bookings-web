/**
 * Turns one TicketSource booking (plus its customer and seats) into rows:
 * customer (PII encrypted), booking, transaction lines, tickets (attendee details encrypted).
 * Re-importing is idempotent and preserves gate check-in state.
 */
import { randomHex } from '../lib/bytes.js';
import { encrypt, blindIndex } from '../crypto/encryption.js';

const CURRENCY = 'GBP'; // the TicketSource API supplies no currency

/** A line "uses a code" when the code has a name, or carries a non-zero amount. A missing amount stays null (unknown). */
export function codeInfo(code) {
  if (!code || typeof code !== 'object') return { hasCode: false, amount: null };
  const named = typeof code.description === 'string' && code.description.trim() !== '';
  const amount = typeof code.amount === 'number' && Number.isFinite(code.amount) ? code.amount : null;
  return { hasCode: named || (amount !== null && amount !== 0), amount };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function idFromLink(link) {
  if (!link || typeof link !== 'string') return null;
  const parts = link.split('?')[0].split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

/** Money summary derived from a booking's lines (refund lines subtract). */
export function summariseLines(lines = []) {
  let paid = 0;
  let refunded = 0;
  let ticketTotal = 0;
  let discount = 0;
  const codes = [];

  for (const line of lines) {
    const amt = line.amount || {};
    const gross = Number(amt.gross) || 0;
    const sign = line.is_refund ? -1 : 1;
    if (line.is_refund) refunded += gross;
    else paid += gross;
    if (line.line_type === 'TICKETS') ticketTotal += sign * gross;
    discount += (Number(amt.discounts?.code?.amount) || 0) + (Number(amt.discounts?.automatic) || 0);
    if (amt.discounts?.code?.description && Number(amt.discounts.code.amount) > 0) codes.push(amt.discounts.code.description);
  }

  return {
    total: round2(paid - refunded),
    ticketTotal: Math.max(0, round2(ticketTotal)),
    discount: round2(discount),
    codes,
    status: paid > 0 && refunded >= paid ? 'refunded' : 'confirmed',
  };
}

export function ticketPrices(total, count) {
  if (count <= 0) return [];
  const each = round2(total / count);
  const prices = Array(count).fill(each);
  prices[0] = round2(total - each * (count - 1)); // remainder on the first so the sum is exact
  return prices;
}

/** Returns our customer id for a TicketSource customer link, fetching (1 API call) only when not cached. */
export async function resolveCustomer(db, client, link, { ttlMs, now, force }) {
  const tsId = idFromLink(link);
  if (!tsId) return null;

  if (!force) {
    const cached = await db.prepare('SELECT customer_id, fetched_at FROM ts_customer_cache WHERE ts_customer_id = ?').get(tsId);
    if (cached && now - cached.fetched_at < ttlMs) return cached.customer_id;
  }

  const c = (await client.get(link)).data?.attributes || {};
  const name = [c.title, c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Anonymous Guest';
  const email = (c.email || '').trim() || `${tsId}@no-email.invalid`;
  const address = c.address && typeof c.address === 'object' ? c.address : null;
  const postcode = address?.postcode || address?.postal_code || address?.post_code || '';
  const iso = new Date(now).toISOString();

  const emailHash = await blindIndex(email);
  const fields = [
    await encrypt(name),
    await encrypt(email),
    await encrypt(c.telephone || c.phone || ''),
    await encrypt(postcode),
    emailHash,
    emailHash,
    postcode ? await blindIndex(postcode) : null,
    address ? await encrypt(JSON.stringify(address)) : null,
  ];

  const existing = await db.prepare('SELECT id FROM customers WHERE email_blind_index = ?').get(emailHash);
  let customerId = existing?.id;
  if (customerId) {
    await db
      .prepare(
        `UPDATE customers SET name_encrypted = ?, email_encrypted = ?, phone_encrypted = ?, postcode_encrypted = ?,
           email_blind_index = ?, email_hash = ?, postcode_hash = ?, address_encrypted = ?, updated_at = ? WHERE id = ?`
      )
      .run(...fields, iso, customerId);
  } else {
    customerId = `cust_${randomHex(6)}`;
    await db
      .prepare(
        `INSERT INTO customers (id, name_encrypted, email_encrypted, phone_encrypted, postcode_encrypted,
           email_blind_index, email_hash, postcode_hash, address_encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(customerId, ...fields, iso, iso);
  }

  await db
    .prepare('INSERT OR REPLACE INTO ts_customer_cache (ts_customer_id, customer_id, fetched_at) VALUES (?, ?, ?)')
    .run(tsId, customerId, now);
  return customerId;
}

/**
 * Imports one booking. Costs up to 2 API calls (customer when not cached, seats) and one atomic D1 batch.
 * Returns the booking row id.
 */
export async function ingestBooking(db, client, booking, ctx) {
  const { date, now, force, customerTtlMs } = ctx;
  const a = booking.attributes || {};
  const iso = new Date(now).toISOString();

  const customerId = await resolveCustomer(db, client, booking.links?.customer, { ttlMs: customerTtlMs, now, force });
  if (!customerId) throw new Error(`Booking ${a.ref} has no customer`);

  const seats = (await client.list(`/bookings/${booking.id}/seats`))
    .filter((s) => !s.attributes?.is_cancelled)
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));

  const money = summariseLines(a.lines);
  const prices = ticketPrices(money.ticketTotal, seats.length);

  // Match an existing row by TicketSource id, or by reference (bookings imported by an earlier version)
  const existing = await db
    .prepare('SELECT id FROM bookings WHERE ts_booking_id = ? OR reference = ? COLLATE NOCASE')
    .get(booking.id, a.ref);
  const bookingId = existing?.id || booking.id;

  const notes = [`TicketSource ${booking.id}`, ...(money.codes.length ? [`Discount: ${money.codes.join(', ')}`] : [])].join('; ');
  const method = (a.lines || []).find((l) => l.payment_method)?.payment_method;

  const stmts = [
    db
      .prepare(
        `INSERT INTO bookings (id, reference, event_id, customer_id, booking_date, status, subtotal, discount_amount, total_price,
           payment_method, payment_reference, notes, ts_booking_id, ts_updated_at, ts_created_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET reference = excluded.reference, event_id = excluded.event_id, customer_id = excluded.customer_id,
           booking_date = excluded.booking_date, status = excluded.status, subtotal = excluded.subtotal,
           discount_amount = excluded.discount_amount, total_price = excluded.total_price, payment_method = excluded.payment_method,
           payment_reference = excluded.payment_reference, notes = excluded.notes, ts_booking_id = excluded.ts_booking_id,
           ts_updated_at = excluded.ts_updated_at, ts_created_at = excluded.ts_created_at, updated_at = excluded.updated_at`
      )
      .bind(
        bookingId, a.ref, date.id, customerId, a.created_at || iso, money.status,
        round2(money.total + money.discount), money.discount, money.total,
        method ? `TicketSource ${method}` : 'TicketSource', booking.id, notes,
        booking.id, a.updated_at || a.created_at || null, a.created_at || null, a.created_at || iso, iso
      ),
  ];

  // Transaction lines
  (a.lines || []).forEach((l, i) => {
    const amt = l.amount || {};
    stmts.push(
      db
        .prepare(
          `INSERT INTO booking_transactions (booking_id, line_index, line_type, payment_method, is_refund, gross, fee, fee_vat, net,
             discount_automatic, discount_code_description, discount_code_amount, has_code, code_amount, currency, gift_aid, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(booking_id, line_index) DO UPDATE SET line_type = excluded.line_type, payment_method = excluded.payment_method,
             is_refund = excluded.is_refund, gross = excluded.gross, fee = excluded.fee, fee_vat = excluded.fee_vat, net = excluded.net,
             discount_automatic = excluded.discount_automatic, discount_code_description = excluded.discount_code_description,
             discount_code_amount = excluded.discount_code_amount, has_code = excluded.has_code, code_amount = excluded.code_amount,
             currency = excluded.currency, gift_aid = excluded.gift_aid, updated_at = excluded.updated_at`
        )
        .bind(
          bookingId, i, l.line_type ?? null, l.payment_method ?? null, l.is_refund ? 1 : 0,
          Number(amt.gross) || 0, Number(amt.fee) || 0, Number(amt.fee_vat) || 0, Number(amt.net) || 0,
          Number(amt.discounts?.automatic) || 0, amt.discounts?.code?.description ?? null, Number(amt.discounts?.code?.amount) || 0,
          codeInfo(amt.discounts?.code).hasCode ? 1 : 0, codeInfo(amt.discounts?.code).amount, CURRENCY,
          l.donation?.gift_aid === undefined ? null : l.donation.gift_aid ? 1 : 0,
          l.created_at ?? null, l.updated_at ?? null
        )
    );
  });
  stmts.push(db.prepare('DELETE FROM booking_transactions WHERE booking_id = ? AND line_index >= ?').bind(bookingId, (a.lines || []).length));

  // Tickets: one per seat. Attendee details are personal data, so they are encrypted.
  const seatIds = seats.map((s) => s.id);
  stmts.push(
    db
      .prepare(
        `DELETE FROM tickets WHERE booking_id = ? AND is_checked_in = 0 AND id NOT IN (${seatIds.length ? seatIds.map(() => '?').join(',') : "''"})`
      )
      .bind(bookingId, ...seatIds)
  );
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    const at = s.attributes?.attendee;
    const attendee = at && Object.values(at).some(Boolean) ? await encrypt(JSON.stringify(at)) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO tickets (id, booking_id, event_id, ticket_type, price, barcode, is_checked_in, attendee_encrypted, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET booking_id = excluded.booking_id, event_id = excluded.event_id,
             ticket_type = excluded.ticket_type, price = excluded.price, barcode = excluded.barcode,
             attendee_encrypted = excluded.attendee_encrypted`
        )
        .bind(s.id, bookingId, date.id, s.attributes?.price_category || 'Standard', prices[i], `${a.ref}-${i + 1}`, attendee, s.attributes?.created_at || iso)
    );
  }

  await db.batch(stmts);
  return bookingId;
}
