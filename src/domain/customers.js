import { randomHex } from '../lib/bytes.js';
import { encrypt, decrypt, blindIndex } from '../crypto/encryption.js';

async function hydrate(row) {
  return {
    id: row.id,
    name: await decrypt(row.name_encrypted),
    email: await decrypt(row.email_encrypted),
    phone: await decrypt(row.phone_encrypted),
    postcode: await decrypt(row.postcode_encrypted),
    ...(row.total_bookings !== undefined && { total_bookings: row.total_bookings, total_spent: row.total_spent }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function upsertCustomer(db, data) {
  if (!data.email) throw new Error('Customer email is required');

  const emailHash = await blindIndex(data.email);
  const postcodeHash = data.postcode ? await blindIndex(data.postcode) : null;
  const now = new Date().toISOString();

  const existing = await db.prepare('SELECT id FROM customers WHERE email_blind_index = ?').get(emailHash);
  const fields = [
    await encrypt(data.name || 'Anonymous Guest'),
    await encrypt(data.email),
    await encrypt(data.phone || ''),
    await encrypt(data.postcode || ''),
    emailHash,
    emailHash,
    postcodeHash,
  ];

  if (existing) {
    await db
      .prepare(
        `UPDATE customers
         SET name_encrypted = ?, email_encrypted = ?, phone_encrypted = ?, postcode_encrypted = ?,
             email_blind_index = ?, email_hash = ?, postcode_hash = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(...fields, now, existing.id);
    return getCustomerById(db, existing.id);
  }

  const id = data.id || `cust_${randomHex(6)}`;
  await db
    .prepare(
      `INSERT INTO customers (id, name_encrypted, email_encrypted, phone_encrypted, postcode_encrypted,
                              email_blind_index, email_hash, postcode_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, ...fields, now, now);
  return getCustomerById(db, id);
}

export async function getCustomerById(db, id) {
  const row = await db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

export async function findCustomerByEmail(db, email) {
  if (!email) return null;
  const row = await db.prepare('SELECT id FROM customers WHERE email_blind_index = ?').get(await blindIndex(email));
  return row ? getCustomerById(db, row.id) : null;
}

export async function searchCustomers(db, query) {
  if (!query) return [];
  const trimmed = query.trim();
  const rows = await db.prepare('SELECT id FROM customers WHERE email_blind_index = ?').all(await blindIndex(trimmed));
  if (rows.length > 0) return Promise.all(rows.map((r) => getCustomerById(db, r.id)));
  return listCustomers(db, { search: trimmed });
}

export const createOrUpdateCustomer = upsertCustomer;

export async function listCustomers(db, options = {}) {
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const offset = options.offset ? parseInt(options.offset, 10) : 0;

  const rows = await db
    .prepare(
      `SELECT c.*, COUNT(b.id) AS total_bookings, COALESCE(SUM(b.total_price), 0) AS total_spent
       FROM customers c
       LEFT JOIN bookings b ON c.id = b.customer_id
       GROUP BY c.id
       ORDER BY c.created_at DESC`
    )
    .all();

  // PII is encrypted, so text search happens after decryption.
  let customers = await Promise.all(rows.map(hydrate));
  if (options.search) {
    const q = options.search.toLowerCase();
    customers = customers.filter(
      (c) =>
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.postcode && c.postcode.toLowerCase().includes(q))
    );
  }
  return customers.slice(offset, offset + limit);
}

export default { upsertCustomer, createOrUpdateCustomer, getCustomerById, findCustomerByEmail, listCustomers, searchCustomers };
