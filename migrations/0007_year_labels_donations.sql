-- Events are labelled by the year of their performance only.
UPDATE events SET name = substr(event_date, 1, 4) WHERE ts_event_id IS NOT NULL;

-- The app no longer assumes a price per ticket (TicketSource only gives booking totals): clear the old equal-split values.
UPDATE tickets SET price = 0 WHERE price <> 0;
