import crypto from 'node:crypto';
import { encrypt, decrypt, blindIndex } from '../crypto/encryption.js';

export function upsertCustomer(db, data) {
  if (!data.email) {
    throw new Error('Customer email is required');
  }

  const emailHash = blindIndex(data.email);
  const postcodeHash = data.postcode ? blindIndex(data.postcode) : null;
  const now = new Date().toISOString();

  // Check if customer already exists by blind index
  const existing = db.prepare('SELECT id FROM customers WHERE email_blind_index = ? OR email_hash = ?').get(emailHash, emailHash);

  if (existing) {
    const updateStmt = db.prepare(`
      UPDATE customers
      SET name_encrypted = ?, email_encrypted = ?, phone_encrypted = ?, postcode_encrypted = ?,
          email_blind_index = ?, email_hash = ?, postcode_hash = ?, updated_at = ?
      WHERE id = ?
    `);

    updateStmt.run(
      encrypt(data.name || 'Anonymous Guest'),
      encrypt(data.email),
      encrypt(data.phone || ''),
      encrypt(data.postcode || ''),
      emailHash,
      emailHash,
      postcodeHash,
      now,
      existing.id
    );

    return getCustomerById(db, existing.id);
  }

  // Create new customer
  const id = data.id || `cust_${crypto.randomBytes(6).toString('hex')}`;
  const insertStmt = db.prepare(`
    INSERT INTO customers (id, name_encrypted, email_encrypted, phone_encrypted, postcode_encrypted, email_blind_index, email_hash, postcode_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(
    id,
    encrypt(data.name || 'Anonymous Guest'),
    encrypt(data.email),
    encrypt(data.phone || ''),
    encrypt(data.postcode || ''),
    emailHash,
    emailHash,
    postcodeHash,
    now,
    now
  );

  return getCustomerById(db, id);
}

export function getCustomerById(db, id) {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) return null;

  return {
    id: row.id,
    name: decrypt(row.name_encrypted),
    email: decrypt(row.email_encrypted),
    phone: decrypt(row.phone_encrypted),
    postcode: decrypt(row.postcode_encrypted),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function findCustomerByEmail(db, email) {
  if (!email) return null;
  const emailHash = blindIndex(email);
  const row = db.prepare('SELECT id FROM customers WHERE email_blind_index = ? OR email_hash = ?').get(emailHash, emailHash);
  if (!row) return null;
  return getCustomerById(db, row.id);
}

export function searchCustomers(db, query) {
  if (!query) return [];
  const trimmed = query.trim();
  const bIndex = blindIndex(trimmed);
  const byIndex = db.prepare('SELECT id FROM customers WHERE email_blind_index = ? OR email_hash = ?').all(bIndex, bIndex);
  if (byIndex.length > 0) {
    return byIndex.map((row) => getCustomerById(db, row.id));
  }
  return listCustomers(db, { search: trimmed });
}

export const createOrUpdateCustomer = upsertCustomer;

export function listCustomers(db, options = {}) {
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const offset = options.offset ? parseInt(options.offset, 10) : 0;

  const rows = db.prepare(`
    SELECT c.*, 
      COUNT(b.id) AS total_bookings,
      COALESCE(SUM(b.total_price), 0) AS total_spent
    FROM customers c
    LEFT JOIN bookings b ON c.id = b.customer_id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();

  // Decrypt in memory for authorized operator view
  let customers = rows.map((row) => ({
    id: row.id,
    name: decrypt(row.name_encrypted),
    email: decrypt(row.email_encrypted),
    phone: decrypt(row.phone_encrypted),
    postcode: decrypt(row.postcode_encrypted),
    total_bookings: row.total_bookings,
    total_spent: row.total_spent,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

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

export default {
  upsertCustomer,
  createOrUpdateCustomer,
  getCustomerById,
  findCustomerByEmail,
  listCustomers,
  searchCustomers,
};
