import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryDatabase } from './helpers/db.js';
import { createOrUpdateCustomer, getCustomerById, searchCustomers } from '../src/domain/customers.js';

describe('Fireworks Domain Logic & Data Model', () => {
  let db;

  beforeEach(async () => {
    db = createInMemoryDatabase();
  });

  test('Customer storage with field-level encryption and blind indexing', async () => {
    const customer = await createOrUpdateCustomer(db, {
      name: 'Alice Johnson',
      email: 'alice@example.com',
      phone: '07700 900111',
      postcode: 'OX1 1AA'
    });

    assert.ok(customer.id);
    assert.equal(customer.name, 'Alice Johnson');
    assert.equal(customer.email, 'alice@example.com');

    // Verify in raw DB that email is encrypted, not stored in plaintext
    const rawRow = await db.prepare('SELECT email_encrypted, phone_encrypted, email_blind_index FROM customers WHERE id = ?').get(customer.id);
    assert.ok(rawRow.email_encrypted);
    assert.ok(rawRow.email_encrypted.includes(':')); // iv:tag:ciphertext
    assert.notEqual(rawRow.email_encrypted, 'alice@example.com');
    assert.ok(rawRow.email_blind_index);

    // Retrieve and decrypt
    const decrypted = await getCustomerById(db, customer.id);
    assert.equal(decrypted.name, 'Alice Johnson');
    assert.equal(decrypted.email, 'alice@example.com');
    assert.equal(decrypted.phone, '07700 900111');
    assert.equal(decrypted.postcode, 'OX1 1AA');

    // Lookup customer by email
    const results = await searchCustomers(db, 'alice@example.com');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, customer.id);
  });
});
