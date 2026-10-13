-- Fireworks Bookings Database Schema
-- Compatible with SQLite and Cloudflare D1

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer', 'operator')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  venue TEXT,
  event_date TEXT NOT NULL,
  gates_open TEXT,
  display_time TEXT,
  capacity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold_out', 'completed', 'cancelled')),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name_encrypted TEXT NOT NULL,
  email_encrypted TEXT NOT NULL,
  phone_encrypted TEXT,
  postcode_encrypted TEXT,
  email_hash TEXT NOT NULL,
  postcode_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_email_hash ON customers(email_hash);

CREATE TABLE IF NOT EXISTS discount_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL COLLATE NOCASE,
  description TEXT,
  discount_type TEXT NOT NULL DEFAULT 'fixed' CHECK (discount_type IN ('fixed', 'percent')),
  discount_value REAL NOT NULL DEFAULT 0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  total_discount_amount REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL COLLATE NOCASE,
  event_id TEXT NOT NULL REFERENCES events(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  booking_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending', 'cancelled', 'refunded')),
  subtotal REAL NOT NULL DEFAULT 0,
  discount_code_id TEXT REFERENCES discount_codes(id),
  discount_amount REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  payment_method TEXT,
  payment_reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_event ON bookings(event_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_reference ON bookings(reference);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id),
  ticket_type TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  barcode TEXT UNIQUE,
  is_checked_in INTEGER NOT NULL DEFAULT 0,
  checked_in_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_booking ON tickets(booking_id);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_barcode ON tickets(barcode);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'ticketsource',
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'in_progress', 'completed', 'failed')),
  records_imported INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_id INTEGER REFERENCES sync_checkpoints(id),
  action TEXT NOT NULL,
  reference TEXT,
  message TEXT,
  created_at TEXT NOT NULL
);
