import express from 'express';
import { listCustomers, getCustomerById } from '../domain/customers.js';
import { listBookings } from '../domain/bookings.js';

export function createCustomerRoutes(db) {
  const router = express.Router();

  // GET /api/customers
  router.get('/', (req, res) => {
    const { search, limit, offset } = req.query;
    const customers = listCustomers(db, { search, limit, offset });
    return res.json({ customers, count: customers.length });
  });

  // GET /api/customers/:id
  router.get('/:id', (req, res) => {
    const customer = getCustomerById(db, req.params.id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const bookings = listBookings(db, { limit: 50 }).filter((b) => b.customer_id === customer.id);
    return res.json({ customer, bookings });
  });

  return router;
}

createCustomerRoutes.createCustomerRoutes = createCustomerRoutes;
export default createCustomerRoutes;
