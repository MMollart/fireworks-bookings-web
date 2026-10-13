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
- Event names are always shown with the year of the performance ("2026 Lydiard Fireworks & Bonfire Spectacular").
- The **Overview** shows one event's figures and defaults to the latest event.
- **Customer search** (name or email address, at least 3 letters) uses a keyed prefix index (`customer_search`) so only a handful of
  customers are decrypted per search. New customers are indexed as they are downloaded; **Configuration > Build customer search
  index** catches up after a bulk import. D1 allows 100 bound parameters per statement, so id lists are sent in groups.
- **Configuration** (admins): the ticket type dictionary maps each TicketSource ticket type to a reporting category (e.g. "Early Bird
  Adult Ticket" and "Adult Ticket" are both "Adult"). Reports > Ticket Tier Distribution uses it; unmapped types appear under their own name.
  TicketSource marks the extra seats of a Family ticket as "Standard"; they are seeded as "Family (included seats)".
- A cron every 30 minutes (`wrangler.toml`, `src/ticketsource/auto.js`) re-reads the event list and incrementally syncs every unsettled
  event (settled and archived events are left alone); once a day it also prunes expired sessions and rate-limit rows.
- General API rate limiting is not built in; use a Cloudflare WAF rate-limiting rule if you need it.
