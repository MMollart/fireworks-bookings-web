-- TicketSource integration: local cache of the API (events, dates, customers), per-date sync
-- checkpoints, API call accounting for rate limiting, and transaction (payment line) details.

CREATE TABLE IF NOT EXISTS ts_events (
  id TEXT PRIMARY KEY,                       -- evt-...
  name TEXT,
  reference TEXT,
  activated INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  state_override TEXT CHECK (state_override IN ('settled', 'unsettled')),
  ts_created_at TEXT,
  ts_updated_at TEXT,
  fetched_at INTEGER NOT NULL,               -- ms epoch, drives cache TTL
  dates_fetched_at INTEGER                   -- ms epoch of the last dates fetch for this event
);

CREATE TABLE IF NOT EXISTS ts_dates (
  id TEXT PRIMARY KEY,                       -- dat-... (also used as events.id in this app)
  event_id TEXT NOT NULL REFERENCES ts_events(id) ON DELETE CASCADE,
  starts_at TEXT,
  ends_at TEXT,
  doors_open TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  ts_updated_at TEXT,
  fetched_at INTEGER NOT NULL,
  -- booking sync progress
  checkpoint TEXT,                           -- start time of the last completed scan; incremental syncs pull from here
  last_synced_at TEXT,
  scan_state TEXT NOT NULL DEFAULT 'idle' CHECK (scan_state IN ('idle', 'scanning', 'complete')), -- complete = done in the current run
  scan_mode TEXT,                            -- incremental | full
  scan_started_at TEXT,
  scan_next TEXT,                            -- API URL of the next bookings page to fetch
  scan_seen INTEGER NOT NULL DEFAULT 0,
  scan_imported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ts_dates_event ON ts_dates(event_id);

-- Maps a TicketSource customer to our (encrypted) customer row so it is fetched at most once per TTL.
CREATE TABLE IF NOT EXISTS ts_customer_cache (
  ts_customer_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ts_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- API calls made, in 10 second buckets, to stay under TicketSource's per-minute limit across all Worker instances.
CREATE TABLE IF NOT EXISTS ts_api_calls (
  bucket INTEGER PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE events ADD COLUMN ts_event_id TEXT;
ALTER TABLE customers ADD COLUMN address_encrypted TEXT;

ALTER TABLE bookings ADD COLUMN ts_booking_id TEXT;
ALTER TABLE bookings ADD COLUMN ts_updated_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_ts_booking ON bookings(ts_booking_id) WHERE ts_booking_id IS NOT NULL;

ALTER TABLE tickets ADD COLUMN attendee_encrypted TEXT;

-- Payment / transaction lines of a booking (TicketSource "lines").
CREATE TABLE IF NOT EXISTS booking_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  line_type TEXT,
  payment_method TEXT,
  is_refund INTEGER NOT NULL DEFAULT 0,
  gross REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  fee_vat REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  discount_automatic REAL NOT NULL DEFAULT 0,
  discount_code_description TEXT,
  discount_code_amount REAL NOT NULL DEFAULT 0,
  gift_aid INTEGER,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE (booking_id, line_index)
);
CREATE INDEX IF NOT EXISTS idx_booking_transactions_booking ON booking_transactions(booking_id);
