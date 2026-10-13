import { listBookings } from './bookings.js';
import { listDiscounts } from './discounts.js';
import { listEvents } from './events.js';

export function getDashboardSummary(db) {
  // Aggregate financial metrics
  const stats = db.prepare(`
    SELECT 
      COALESCE(SUM(CASE WHEN status = 'confirmed' THEN total_price ELSE 0 END), 0) AS gross_revenue,
      COALESCE(SUM(CASE WHEN status = 'confirmed' THEN discount_amount ELSE 0 END), 0) AS total_discounts,
      COUNT(id) AS total_bookings_all,
      SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_bookings,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_bookings,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_bookings,
      SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded_bookings
    FROM bookings
  `).get();

  // Tickets aggregate
  const ticketStats = db.prepare(`
    SELECT 
      COUNT(t.id) AS total_tickets_sold,
      SUM(CASE WHEN t.is_checked_in = 1 THEN 1 ELSE 0 END) AS checked_in_count
    FROM tickets t
    JOIN bookings b ON t.booking_id = b.id
    WHERE b.status = 'confirmed'
  `).get();

  // Customer count
  const customerCount = db.prepare('SELECT COUNT(*) AS count FROM customers').get().count;

  // Average Order Value
  const confirmed = stats.confirmed_bookings || 0;
  const aov = confirmed > 0 ? parseFloat((stats.gross_revenue / confirmed).toFixed(2)) : 0;

  // Recent 5 bookings
  const recentBookings = listBookings(db, { limit: 5 });

  // Events summary
  const events = listEvents(db);

  return {
    financials: {
      gross_revenue: stats.gross_revenue,
      total_discounts: stats.total_discounts,
      net_revenue: parseFloat((stats.gross_revenue - stats.total_discounts).toFixed(2)),
      confirmed_bookings: stats.confirmed_bookings || 0,
      aov,
    },
    revenue: {
      gross: stats.gross_revenue,
      discounts: stats.total_discounts,
      net: parseFloat((stats.gross_revenue - stats.total_discounts).toFixed(2)),
      aov,
    },
    bookings: {
      total: stats.total_bookings_all || 0,
      confirmed: stats.confirmed_bookings || 0,
      pending: stats.pending_bookings || 0,
      cancelled: stats.cancelled_bookings || 0,
      refunded: stats.refunded_bookings || 0,
    },
    tickets: {
      totalSold: ticketStats.total_tickets_sold || 0,
      checkedIn: ticketStats.checked_in_count || 0,
      tickets_sold: ticketStats.total_tickets_sold || 0,
      tickets_checked_in: ticketStats.checked_in_count || 0,
      checkInRate: ticketStats.total_tickets_sold > 0
        ? Math.round(((ticketStats.checked_in_count || 0) / ticketStats.total_tickets_sold) * 100)
        : 0,
    },
    customers: {
      total: customerCount,
    },
    recentBookings,
    events,
  };
}

export function getDailySalesVelocity(db, options = {}) {
  let sql = `
    SELECT 
      SUBSTR(b.booking_date, 1, 10) AS date,
      COUNT(DISTINCT b.id) AS bookings_count,
      COUNT(t.id) AS tickets_sold,
      COALESCE(SUM(b.total_price), 0) AS revenue
    FROM bookings b
    LEFT JOIN tickets t ON b.id = t.booking_id
    WHERE b.status = 'confirmed'
  `;
  const params = [];

  if (options.eventId) {
    sql += ' AND b.event_id = ?';
    params.push(options.eventId);
  }

  sql += ' GROUP BY SUBSTR(b.booking_date, 1, 10) ORDER BY date ASC';

  if (options.days) {
    const daysLimit = parseInt(options.days, 10);
    sql += ` LIMIT ${daysLimit}`;
  }

  return db.prepare(sql).all(...params);
}

export function getDiscountCodeReport(db) {
  return listDiscounts(db);
}

export function getTicketTypeBreakdown(db, eventId = null) {
  let sql = `
    SELECT 
      t.ticket_type,
      COUNT(t.id) AS count,
      COALESCE(SUM(t.price), 0) AS total_revenue,
      SUM(CASE WHEN t.is_checked_in = 1 THEN 1 ELSE 0 END) AS checked_in_count
    FROM tickets t
    JOIN bookings b ON t.booking_id = b.id
    WHERE b.status = 'confirmed'
  `;
  const params = [];

  if (eventId) {
    sql += ' AND t.event_id = ?';
    params.push(eventId);
  }

  sql += ' GROUP BY t.ticket_type ORDER BY count DESC';

  return db.prepare(sql).all(...params);
}

export function exportBookingsCsv(db, options = {}) {
  const bookings = listBookings(db, {
    eventId: options.eventId,
    status: options.status,
    limit: 10000,
  });

  const headers = [
    'Booking Reference',
    'Event',
    'Booking Date',
    'Status',
    'Customer Name',
    'Customer Email',
    'Customer Phone',
    'Customer Postcode',
    'Tickets Count',
    'Subtotal',
    'Discount Code',
    'Discount Amount',
    'Total Price',
    'Payment Method',
  ];

  function escapeCsv(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const rows = [headers.join(',')];
  for (const b of bookings) {
    rows.push(
      [
        escapeCsv(b.reference),
        escapeCsv(b.event_name),
        escapeCsv(b.booking_date),
        escapeCsv(b.status),
        escapeCsv(b.customer_name),
        escapeCsv(b.customer_email),
        escapeCsv(b.customer_phone),
        escapeCsv(b.customer_postcode),
        escapeCsv(b.ticket_count),
        escapeCsv(b.subtotal.toFixed(2)),
        escapeCsv(b.discount_code || ''),
        escapeCsv(b.discount_amount.toFixed(2)),
        escapeCsv(b.total_price.toFixed(2)),
        escapeCsv(b.payment_method || ''),
      ].join(',')
    );
  }

  return rows.join('\r\n');
}

export default {
  getDashboardSummary,
  getDailySalesVelocity,
  getDiscountCodeReport,
  getTicketTypeBreakdown,
  exportBookingsCsv,
};
