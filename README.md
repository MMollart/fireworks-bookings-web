# Fireworks Bookings Web

Scout Budget-style bookings app for fireworks events: admin-managed sign-in (no registration), events, bookings,
tickets and gate check-in, discount codes, reports/CSV export and a TicketSource sync. Customer PII is encrypted at
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
- **TicketSource webhook:** `POST /api/sync/webhook` with header `x-webhook-secret: <TICKETSOURCE_WEBHOOK_SECRET>`.
  Manual sync needs `TICKETSOURCE_API_KEY` (from TicketSource Settings > API) and talks to `api.ticketsource.io`: each run imports up to 10 new bookings (events -> dates -> bookings), so click *Run Sync* again while it reports more remain. Each TicketSource date becomes one event here; ticket types come from seat price categories, prices are the booking total split evenly, and barcodes are `<booking ref>-<n>` because the API does not expose TicketSource's own; without it, production refuses to sync (simulated data is dev-only).
- A daily cron (`wrangler.toml`) prunes expired sessions and rate-limit rows.
- General API rate limiting is not built in; use a Cloudflare WAF rate-limiting rule if you need it.
