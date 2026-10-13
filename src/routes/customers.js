import { Hono } from 'hono';
import { listCustomers, getCustomerById } from '../domain/customers.js';
import { listBookings } from '../domain/bookings.js';

export function customerRoutes() {
  const r = new Hono();

  r.get('/', async (c) => {
    const { search, limit, offset } = c.req.query();
    const customers = await listCustomers(c.get('db'), { search, limit, offset });
    return c.json({ customers, count: customers.length });
  });

  r.get('/:id', async (c) => {
    const db = c.get('db');
    const customer = await getCustomerById(db, c.req.param('id'));
    if (!customer) return c.json({ error: 'Customer not found' }, 404);
    const bookings = await listBookings(db, { customerId: customer.id, limit: 50 });
    return c.json({ customer, bookings });
  });

  return r;
}
