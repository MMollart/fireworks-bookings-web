import { randomHex } from '../lib/bytes.js';
import { encrypt, decrypt, blindIndex } from '../crypto/encryption.js';

const SQL_PARAM_LIMIT = 90; // D1 allows at most 100 bound parameters per statement
const MIN_SEARCH_CHARS = 3;
const MAX_CANDIDATES = 600;

function chunk(list, size = SQL_PARAM_LIMIT) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const words = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Search words of a customer: name words and the words of the e-mail address before the @ (the domain would match everyone). */
export function searchWords(name, email) {
  const local = String(email ?? '').split('@')[0];
  return [...new Set([...words(name), ...words(local)])];
}

const wordKey = async (w) => (await blindIndex(`s:${w.slice(0, MIN_SEARCH_CHARS)}`)).slice(0, 20);

/** Statements that (re)build one customer's search keys. INSERT OR IGNORE: stale keys only add harmless candidates. */
export async function searchIndexStatements(db, customerId, name, email, { mark = true } = {}) {
  const keys = [...new Set(await Promise.all(searchWords(name, email).filter((w) => w.length >= 1).map(wordKey)))];
  const stmts = [];
  for (const part of chunk(keys, 40)) {
    stmts.push(
      db
        .prepare(`INSERT OR IGNORE INTO customer_search (search_key, customer_id) VALUES ${part.map(() => '(?, ?)').join(', ')}`)
        .bind(...part.flatMap((k) => [k, customerId]))
    );
  }
  if (mark) stmts.push(db.prepare('UPDATE customers SET search_indexed = 1 WHERE id = ?').bind(customerId));
  return stmts;
}

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
    await db.batch(await searchIndexStatements(db, existing.id, data.name || 'Anonymous Guest', data.email));
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
  await db.batch(await searchIndexStatements(db, id, data.name || 'Anonymous Guest', data.email));
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

/** Totals per customer for a page of customers (one query, not one per row). */
async function withTotals(db, rows) {
  const totals = new Map();
  for (const ids of chunk(rows.map((r) => r.id))) {
    const found = await db
      .prepare(
        `SELECT customer_id, COUNT(*) AS total_bookings, COALESCE(SUM(total_price), 0) AS total_spent
         FROM bookings WHERE customer_id IN (${ids.map(() => '?').join(',')}) GROUP BY customer_id`
      )
      .all(...ids);
    for (const t of found) totals.set(t.customer_id, t);
  }
  return Promise.all(
    rows.map((r) => hydrate({ ...r, total_bookings: totals.get(r.id)?.total_bookings ?? 0, total_spent: totals.get(r.id)?.total_spent ?? 0 }))
  );
}

/**
 * Candidate customer ids for a search: those whose name/e-mail words start with every typed word (via the keyed prefix
 * index), plus any customer not indexed yet. Callers decrypt the candidates and confirm the match.
 */
async function candidateIds(db, query) {
  const typed = words(String(query).split('@')[0]).filter((w) => w.length >= MIN_SEARCH_CHARS);
  if (!typed.length) return null;

  const keys = [...new Set(await Promise.all(typed.map(wordKey)))];
  const ids = new Set();
  const found = await db
    .prepare(
      `SELECT customer_id FROM customer_search WHERE search_key IN (${keys.map(() => '?').join(',')})
       GROUP BY customer_id HAVING COUNT(DISTINCT search_key) = ? LIMIT ${MAX_CANDIDATES}`
    )
    .all(...keys, keys.length);
  for (const r of found) ids.add(r.customer_id);

  const unindexed = await db.prepare('SELECT id FROM customers WHERE search_indexed = 0 LIMIT 2000').all();
  for (const r of unindexed) ids.add(r.id);

  const exact = await db.prepare('SELECT id FROM customers WHERE email_blind_index = ?').all(await blindIndex(query));
  for (const r of exact) ids.add(r.id);
  return [...ids];
}

/** Customers matching a name or e-mail search, decrypted and confirmed. Needs at least 3 characters in a word. */
export async function searchCustomerRows(db, query, { limit = 100, offset = 0 } = {}) {
  const q = fold(query).trim();
  if (!q) return { rows: [], tooShort: false };
  const ids = await candidateIds(db, q);
  if (ids === null) return { rows: [], tooShort: true };

  const needles = q.split(/\s+/).filter(Boolean);
  const matches = [];
  for (const part of chunk(ids)) {
    const rows = await db.prepare(`SELECT * FROM customers WHERE id IN (${part.map(() => '?').join(',')})`).all(...part);
    for (const row of rows) {
      const hay = fold(`${await decrypt(row.name_encrypted)} ${await decrypt(row.email_encrypted)}`);
      if (needles.every((n) => hay.includes(n))) matches.push(row);
    }
  }
  matches.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { rows: matches.slice(offset, offset + limit), tooShort: false };
}

export async function searchCustomers(db, query) {
  const { rows } = await searchCustomerRows(db, query);
  return Promise.all(rows.map(hydrate));
}

/** Ids of customers matching a search, for filtering other lists (bookings). null = search too short to use. */
export async function matchingCustomerIds(db, query) {
  const { rows, tooShort } = await searchCustomerRows(db, query, { limit: 500 });
  return tooShort ? null : rows.map((r) => r.id);
}

export const createOrUpdateCustomer = upsertCustomer;

export async function listCustomers(db, options = {}) {
  const limit = Math.min(500, options.limit ? parseInt(options.limit, 10) || 100 : 100);
  const offset = options.offset ? parseInt(options.offset, 10) || 0 : 0;

  if (options.search && options.search.trim()) {
    const { rows, tooShort } = await searchCustomerRows(db, options.search, { limit, offset });
    const customers = await withTotals(db, rows);
    return Object.assign(customers, { tooShort });
  }

  const rows = await db.prepare('SELECT * FROM customers ORDER BY created_at DESC, id LIMIT ? OFFSET ?').all(limit, offset);
  return withTotals(db, rows);
}

/** Indexes the next batch of customers that have no search keys yet (after a bulk import). */
export async function reindexCustomers(db, batch = 40) {
  const rows = await db.prepare('SELECT id, name_encrypted, email_encrypted FROM customers WHERE search_indexed = 0 LIMIT ?').all(batch);
  const stmts = [];
  for (const r of rows) stmts.push(...(await searchIndexStatements(db, r.id, await decrypt(r.name_encrypted), await decrypt(r.email_encrypted))));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM customers WHERE search_indexed = 0').get();
  return { indexed: rows.length, remaining: n };
}

export default { upsertCustomer, createOrUpdateCustomer, getCustomerById, findCustomerByEmail, listCustomers, searchCustomers, reindexCustomers };
