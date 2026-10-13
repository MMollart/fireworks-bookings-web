-- TicketSource's own settled flag (NULL = not yet fetched)
ALTER TABLE ts_events ADD COLUMN settled INTEGER;

-- Booking creation date exactly as TicketSource reported it (NULL when missing); booking_date stays NOT NULL for the rest of the app.
ALTER TABLE bookings ADD COLUMN ts_created_at TEXT;
UPDATE bookings SET ts_created_at = booking_date WHERE ts_booking_id IS NOT NULL;

-- Discount code detail per financial line. code_amount is NULL when TicketSource supplied no amount (unknown, not zero).
-- Existing rows are unknown until the event is re-synced.
ALTER TABLE booking_transactions ADD COLUMN has_code INTEGER NOT NULL DEFAULT 0;
ALTER TABLE booking_transactions ADD COLUMN code_amount REAL;
-- TicketSource's API carries no currency; lines are recorded as GBP and analysis keeps currencies separate if that ever changes.
ALTER TABLE booking_transactions ADD COLUMN currency TEXT NOT NULL DEFAULT 'GBP';
UPDATE booking_transactions SET has_code = 1 WHERE COALESCE(TRIM(discount_code_description), '') <> '';
