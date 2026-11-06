# Fireworks Bookings Web

Scout Budget-style bookings app for fireworks events: admin-managed sign-in (no registration), a read-only view of
TicketSource events, bookings and customers, analysis, discount codes, reports/CSV export and a TicketSource sync. Customer PII is encrypted at
rest (AES-256-GCM, with an HMAC blind index for email lookup).

**Stack:** Cloudflare Worker ([Hono](https://hono.dev)) + static assets (`public/`) + D1 (SQLite).

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars        # local-only secrets
npm run migrate:local                 # create tables in the local D1
npm run dev                           # http://localhost:8787  (admin / value of ADMIN_INITIAL_PASSWORD)
npm test                              # node:test suite against in-memory SQLite
```

## Deploying

One-time setup:

```sh
npx wrangler d1 create fireworks_bookings_d1      # put the database_id into wrangler.toml
printf %s "$(openssl rand -hex 32)" | npx wrangler secret put ENCRYPTION_KEY   # BACK THIS UP: data is unreadable without it
npx wrangler secret put ADMIN_INITIAL_PASSWORD    # first-run admin (created only while the users table is empty)
npx wrangler secret put TICKETSOURCE_WEBHOOK_SECRET
# optional: ADMIN_INITIAL_USERNAME (default "admin"), TICKETSOURCE_API_KEY, TICKETSOURCE_API_URL
```

Each release:

```sh
npm run deploy        # applies D1 migrations to the remote DB, then wrangler deploy
```

Add or reset an admin later: `node scripts/create-admin.js <username> <password>` (`--local` for the local DB).

## Notes

- **Schema changes** go in new numbered files under `migrations/` (never edit applied ones).
- **Auth:** PBKDF2-SHA256 password hashes, sessions stored (hashed) in D1, `HttpOnly` cookie. Login is rate limited
  through D1. Roles: `admin`, `operator` (can write), `viewer` (read-only).
- **TicketSource (read-only):** the app only ever sends `GET` requests to `api.ticketsource.io`; the client refuses any other
  method, so nothing is written back. Needs the `TICKETSOURCE_API_KEY` secret (TicketSource Settings > API).
  - *Events -> Retrieve events from TicketSource* (and the TicketSource tab) lists every event as **unsettled / settled / archived**,
    using TicketSource's own `settled` and `archived` properties. Note that `GET /events` silently defaults to
    `filter[settled]=false`, hiding settled events, so the app requests `settled`/`archived` with the `any` operator and fetches
    the settled set separately. The Events page has an archive filter (all / not archived / archived only).
  - *Refresh bookings* on an event pulls its bookings, customers (encrypted), attendee details (encrypted) and transaction lines.
    Unsettled events pull only what changed since the date's last checkpoint; settled/archived events are re-read in full.
    *Full re-sync* ignores the checkpoint and caches.
  - *Rate limits:* events, dates and customers are cached in D1 (`TS_EVENTS_TTL_MINUTES`, `TS_CUSTOMER_TTL_HOURS`); a shared
    rolling-minute counter keeps calls under `TS_CALLS_PER_MINUTE` (default 200, TicketSource allows 240); a 429 pauses all syncing for
    `Retry-After`. Each request does at most `TS_STEP_CALLS` (default 40) API calls and saves its position; the UI keeps stepping
    until the event is done, so large events simply take a few minutes.
  - Imported tickets get barcodes like `<booking ref>-<n>` (TicketSource's own barcodes are not exposed by the API).
- **Analysis** and **Discount Codes** tabs are computed from the locally stored download (never live from TicketSource):
  sales over time (whole event / daily / weekly / monthly, Europe/London, weeks start Monday, attributed to the booking's original
  creation date with its *current* tickets and money), compare events (aligned on days before each booking's own performance,
  optional sales-to-date cutoff and all-events average) and discount-code usage (by performance year, distinct bookings, case/diacritic/
  whitespace-insensitive code merging, unknown amounts shown as Unknown, reversal-only codes flagged). Periods the download does not
  cover show "No data", never zero. TicketSource supplies no currency, so amounts are recorded as GBP; the analysis keeps currencies separate.
- The app only displays what comes from TicketSource: there is no way to create events or bookings, and no ticket check-in
  (tickets are scanned with the TicketSource app). Nothing is ever sent to TicketSource.
- Events are labelled by the year of the performance only ("2026"), in tables and charts alike.
- No price per ticket is assumed (TicketSource only gives booking totals), so ticket reports show counts. Donations (`DONATION` booking lines, with Gift Aid) are reported separately from ticket revenue.
- Analysis > **All years** compares every event as bars (earliest to latest), for all sales or to the equivalent date in the sales cycle. Every table sorts by clicking a column header; users can change their own password; admins can delete accounts.
- Analysis > **Sell-out forecast** predicts when an upcoming event reaches its capacity (default 10,000 tickets, editable).
  Bookings are aligned on days before their performance; each completed, fully downloaded past year gives two scenarios
  projected from the end of yesterday: *share of sales* (this year sells the same share of its final total from here as that
  year did) and *momentum* (this year's last 14 days vs that year's same 14 days, scaled forward). The forecast is their median,
  with the lowest/highest as a range and "sells out in X of Y scenarios". Past years that sold out are continued past their
  sell-out point with the other years' growth. Tickets per booking (adjusted for later bookings' size in past years) turns the
  remaining tickets into bookings still needed. With no past year it falls back to the recent daily pace.
  - **Sales switched off early:** a past year whose last booking was before 18:30 on the performance day (or 30 minutes before an
    earlier start), or on an earlier day, is treated as switched off (sales are usually turned off around 9,500). This year, on
    the day, sales count as switched off once 90% of capacity is sold and there has been no booking for an hour. The forecast always runs to full
    capacity: on the performance day that year is carried on at the rate it was selling in the two hours before closing (and the
    table shows when it would have reached capacity); switched off on an earlier day, it is continued with the other years' growth.
  - **Today so far:** projections start from the end of yesterday, then today's sales up to the last download are added in:
    past years show what share of the same day's sales was in by this time of day, so today's sales so far estimate the whole
    day, trusted fully once half the day's sales are typically in, and the difference carries forward.
  - **Pace:** the last 7 days are compared with past years' same 7 days before their performance ("+10% on past years"), and the
    forecast gives the expected pace from now for the next 7 days and the final 3 days, comparable with the pace needed to sell
    out, so the late surge each year has is expected, not read as falling behind. The chart can show tickets per day (actual,
    then forecast with a range) as well as the running total.
  - **Time of day:** when the sell-out falls on the performance day, each past year's performance-day sales by clock time
    (15-minute steps, Europe/London) are scaled to this year to estimate the time capacity is reached, with a range and a
    performance-day chart. On the day it uses today's sales so far (and, if sales have been switched off, when 10,000 would have
    been reached at that pace). Bookings are downloaded on the refresh schedule (every 10 minutes on the day by default), so "so far" can be up to that old (`src/analysis/forecast.js`).
- The **Overview** shows one event's figures and defaults to the latest event.
- **Customer search** (name or email address, at least 3 letters) uses a keyed prefix index (`customer_search`) so only a handful of
  customers are decrypted per search. New customers are indexed as they are downloaded; **Configuration > Build customer search
  index** catches up after a bulk import. D1 allows 100 bound parameters per statement, so id lists are sent in groups.
- **Configuration** (admins): the ticket type dictionary maps each TicketSource ticket type to a reporting category (e.g. "Early Bird
  Adult Ticket" and "Adult Ticket" are both "Adult"). Reports > Ticket Tier Distribution uses it; unmapped types appear under their own name.
  TicketSource marks the extra seats of a Family ticket as "Standard"; they are seeded as "Family (included seats)".
- **Automatic refresh** (`src/ticketsource/auto.js`, `src/ticketsource/schedule.js`) re-reads the event list and incrementally syncs every
  unsettled event (settled and archived events are left alone). How often is chosen on the **TicketSource** tab by admins: a normal
  interval (default every 30 minutes) and an **event-day** interval (default every 10 minutes) used all day, Europe/London, whenever an
  unsettled event has a performance today. Either can be switched off. The cron in `wrangler.toml` ticks every 5 minutes and only runs a
  refresh once the chosen interval has passed since the last one started (a manual "run now" counts). Once a day it also prunes expired
  sessions and rate-limit rows.
- General API rate limiting is not built in; use a Cloudflare WAF rate-limiting rule if you need it.
