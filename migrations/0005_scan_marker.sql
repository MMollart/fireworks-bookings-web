-- Lets a resumed forced re-sync skip bookings already re-read by the SAME scan (instead of restarting the page).
ALTER TABLE ts_dates ADD COLUMN scan_id TEXT;
ALTER TABLE bookings ADD COLUMN ts_scan_id TEXT;
