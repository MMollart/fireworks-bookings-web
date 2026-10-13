-- Ticket type dictionary, customer search index, and event names carrying their year.

CREATE TABLE IF NOT EXISTS ticket_type_map (
  type_key TEXT PRIMARY KEY,                 -- lower-cased, whitespace-collapsed ticket type
  ticket_type TEXT NOT NULL,                 -- as displayed
  category TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO ticket_type_map (type_key, ticket_type, category, updated_at) VALUES
  ('early bird child ticket - 5 to 14yrs inclusive', 'Early Bird Child Ticket - 5 to 14yrs inclusive', 'Child', CURRENT_TIMESTAMP),
  ('early bird adult ticket - 15yrs and older', 'Early Bird Adult Ticket - 15yrs and older', 'Adult', CURRENT_TIMESTAMP),
  ('infant ticket - under 5yrs old', 'Infant Ticket - Under 5yrs old', 'Infant', CURRENT_TIMESTAMP),
  ('early bird family ticket - 2 adults and upto 3 children (5 - 14yrs inclusive)', 'Early Bird Family Ticket - 2 Adults and upto 3 Children (5 - 14yrs inclusive)', 'Family', CURRENT_TIMESTAMP),
  ('standard', 'Standard', 'Family (included seats)', CURRENT_TIMESTAMP),
  ('blue badge car parking', 'Blue Badge Car Parking', 'Blue Badge Parking', CURRENT_TIMESTAMP),
  ('adult ticket - 15yrs and older', 'Adult Ticket - 15yrs and older', 'Adult', CURRENT_TIMESTAMP),
  ('family ticket - 2 adults and upto 3 children (5 - 14yrs inclusive)', 'Family Ticket - 2 Adults and upto 3 Children (5 - 14yrs inclusive)', 'Family', CURRENT_TIMESTAMP),
  ('child ticket - 5 to 14yrs inclusive', 'Child Ticket - 5 to 14yrs inclusive', 'Child', CURRENT_TIMESTAMP),
  ('vip ticket', 'VIP Ticket', 'VIP', CURRENT_TIMESTAMP),
  ('early bird - adult 25% off', 'Early bird - Adult 25% off', 'Adult', CURRENT_TIMESTAMP),
  ('early bird - 5yrs - 14yrs - 25% off', 'Early Bird - 5yrs - 14yrs - 25% off', 'Child', CURRENT_TIMESTAMP),
  ('early bird - 25% off - family - 2 adults and up to 3 children', 'Early Bird - 25% off - Family - 2 Adults and up to 3 Children', 'Family', CURRENT_TIMESTAMP),
  ('adult', 'Adult', 'Adult', CURRENT_TIMESTAMP),
  ('adult - prebooked booked price', 'Adult - prebooked booked price', 'Adult', CURRENT_TIMESTAMP),
  ('family - 2 adults and up to 3 children prebooked ticket price', 'Family - 2 Adults and up to 3 Children prebooked ticket price', 'Family', CURRENT_TIMESTAMP),
  ('under 5yrs - 14yrs prebooked ticket price', 'Under 5yrs - 14yrs prebooked ticket price', 'Child', CURRENT_TIMESTAMP),
  ('15yrs and older - prebooked booked price', '15yrs and older - prebooked booked price', 'Adult', CURRENT_TIMESTAMP),
  ('5yrs - 14yrs prebooked ticket price', '5yrs - 14yrs prebooked ticket price', 'Child', CURRENT_TIMESTAMP),
  ('family - 2 adults (15yrs and over) and up to 3 children prebooked ticket price', 'Family - 2 Adults (15yrs and over) and up to 3 Children prebooked ticket price', 'Family', CURRENT_TIMESTAMP)
;

-- Customer search: keyed (HMAC) 3-character prefixes of each name word and e-mail word, so typing the start of a name or
-- address finds a handful of candidate rows without decrypting every customer.
CREATE TABLE IF NOT EXISTS customer_search (
  search_key TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  PRIMARY KEY (search_key, customer_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_customer_search_customer ON customer_search(customer_id);

ALTER TABLE customers ADD COLUMN search_indexed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_ts_dates_event ON bookings(event_id, booking_date);

-- Every event name shows the year of its performance.
UPDATE events SET name = substr(event_date, 1, 4) || ' ' || name
WHERE ts_event_id IS NOT NULL AND name NOT GLOB '[0-9][0-9][0-9][0-9] *';
