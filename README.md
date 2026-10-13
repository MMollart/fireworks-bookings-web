# 🎆 Fireworks Bookings Web

A modern browser-based recreation of the Fireworks Bookings application, styled and architected in the spirit of [`scout-budget`](https://github.com/MMollart/scout-budget), preserving the complete domain rules, security architecture, and reporting features of the Fireworks Bookings product.

## 🎯 Architectural Overview & Source-of-Truth Split

- **Conventions & Runtime Structure ([`MMollart/scout-budget`](https://github.com/MMollart/scout-budget)):**
  - Node.js native ES modules application with clean layered separation (HTTP routing, domain services, storage, auth, background sync, and static web UI).
  - Robust security headers (strict CSP, HSTS, X-Frame-Options, X-Content-Type-Options) and rate-limiting middleware (anti-brute-force login limiter and API limiter).
  - Secure, `httpOnly`, `SameSite=Lax` cookie-based session management.
  - Scout Budget-inspired dashboard shell: responsive navigation, cards, tables, modals, toast alerts, typography, and clean contrast palette.

- **Domain Rules & Data Model (`MMollart/Fireworks-Bookings-App`):**
  - **Events & Capacity:** Multi-tier ticket types, real-time sold count, capacity tracking, and revenue aggregates.
  - **Bookings & Gate Check-in:** Order reference tracking, multi-ticket issuance with unique scan barcodes, fast gate check-in with duplicate detection (409 Conflict).
  - **Customer Privacy & Field-Level Encryption:** Personal Identifiable Information (name, email, phone, postcode, address) is encrypted at rest using AES-256-GCM. Fast search is enabled via deterministic HMAC-SHA256 blind indexing without leaking plaintext.
  - **Discount Codes:** Percentage and fixed-amount calculations with comprehensive usage, total savings, and associated revenue reporting.
  - **Resumable Sync:** Resilient TicketSource ingestion with persistent cursor checkpoints, idempotent replay protection, simulated batches, and real-time webhook endpoints.

---

## 🔒 Security & Authentication Principles

1. **Strictly Closed Registration:** There is **no public sign-up or registration flow**. All accounts are created and managed by administrators.
2. **Salted scrypt Password Hashing:** Passwords are never stored in plaintext or reversible encryption. They are hashed using `crypto.scrypt` with a unique cryptographically random 16-byte salt per user and 64-byte derived key.
3. **Admin Account Management:** Dedicated administrator UI and REST endpoints to list accounts, provision new operators, toggle user activation (with immediate session invalidation), and perform administrative password resets.
4. **Data at Rest Protection:** Customer PII fields (`email`, `phone`, `name`, `address_line1`, `postcode`) are encrypted before database insertion using AES-256-GCM with unique 12-byte initialization vectors and 16-byte authentication tags.
5. **Session Security:** Random 256-bit entropy session tokens stored with metadata (IP address, User Agent, expiration timestamp). Inactive or expired sessions are automatically purged.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v20.x or v22.x+ (with built-in `node:sqlite` support)
- **npm**: v9+

### Installation

```bash
git clone https://github.com/MMollart/fireworks-bookings-web.git
cd fireworks-bookings-web
npm install
```

### Environment Configuration

Copy `.env.example` to `.env` and configure your keys:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port to listen on | `3000` |
| `HOST` | Interface bind address | `0.0.0.0` |
| `NODE_ENV` | Environment mode (`development` / `production`) | `development` |
| `SESSION_SECRET` | 32+ character key used to sign session cookies | *Required in production* |
| `ENCRYPTION_KEY` | 64-char hex string (32 bytes) for AES-256-GCM customer encryption | *Required in production* |
| `ADMIN_INITIAL_USERNAME` | Seed administrator username | `admin` |
| `ADMIN_INITIAL_PASSWORD` | Seed administrator password | `ChangeMeNow123!` |
| `TICKETSOURCE_API_KEY` | (Optional) TicketSource API key for live syncing | `""` |

---

## 💻 Running the Application

### 1. Initialize Database & Create Initial Admin

```bash
npm run db:init
```

Or run the interactive CLI helper:
```bash
node scripts/create-admin.js --username=sysadmin --role=admin
```

### 2. Start Server

```bash
# Production mode
npm start

# Development mode (auto-restart with node --watch)
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) in your web browser.

---

## 🧪 Running Tests

The test suite runs using Node.js built-in test runner (`node:test`) and covers:
- **HTTP API & Auth:** Security headers, login/logout, route protection, admin account management, check-in, reports.
- **Domain Logic:** Event creation, customer storage, discount calculations, booking flows.
- **Cryptography:** AES-256-GCM encryption/decryption, tampering detection, blind indexes, phone/email masking.
- **Passwords:** scrypt hashing, unique salting, verification, policy enforcement.
- **Sessions:** Token generation, lifecycle, user invalidation, expiry cleanup.
- **Sync:** Resumable checkpoints, idempotent order ingestion, webhook processing.

```bash
npm test
```

---

## 📁 Project Structure

```
fireworks-bookings-web/
├── public/                 # Static frontend assets
│   ├── index.html          # Scout Budget-style dashboard shell
│   ├── login.html          # Minimalist secure sign-in view
│   ├── css/
│   │   └── style.css       # Scout Budget design system styling
│   └── js/
│       ├── app.js          # Client-side UI router & views
│       └── login.js        # Sign-in handling
├── src/
│   ├── app.js              # Express app factory with middleware stack
│   ├── server.js           # Server entry point & graceful shutdown
│   ├── config.js           # Environment & configuration loader
│   ├── auth/
│   │   ├── middleware.js   # Route guards & authentication middleware
│   │   ├── passwords.js    # scrypt hashing, salting & verification
│   │   └── sessions.js     # SQLite-backed session manager
│   ├── crypto/
│   │   └── encryption.js   # AES-256-GCM & HMAC blind indexing
│   ├── db/
│   │   ├── index.js        # SQLite initialization & connection pool
│   │   └── schema.sql      # Database tables, indexes & schema definition
│   ├── domain/
│   │   ├── events.js       # Event & capacity management
│   │   ├── bookings.js     # Bookings & ticket issuance
│   │   ├── tickets.js      # Barcode lookup & gate check-in
│   │   ├── customers.js    # Encrypted customer records & search
│   │   ├── discounts.js    # Discount codes & usage analytics
│   │   └── reports.js      # Dashboard metrics & CSV report generation
│   ├── middleware/
│   │   ├── rateLimit.js    # General & login rate limiters
│   │   └── security.js    # CSP, HSTS, frameguard headers
│   ├── routes/
│   │   ├── auth.js         # /api/auth (login, logout, me)
│   │   ├── admin.js        # /api/admin (user management)
│   │   ├── events.js       # /api/events
│   │   ├── bookings.js     # /api/bookings
│   │   ├── tickets.js      # /api/tickets
│   │   ├── customers.js    # /api/customers
│   │   ├── reports.js      # /api/reports & CSV export
│   │   └── sync.js         # /api/sync & webhooks
│   └── sync/
│       └── ticketsource.js # TicketSource sync & webhook ingester
├── test/                   # Test suites (node:test)
├── scripts/
│   ├── create-admin.js     # Admin user provisioning CLI
│   └── seed-data.js        # Development mock data seeder
└── package.json
```

---

## 🚢 Deployment Model

Following the `scout-budget` deployment philosophy:

### Standalone Node.js / VPS / Docker
1. Ensure `ENCRYPTION_KEY` and `SESSION_SECRET` are securely provisioned via environment secrets.
2. Mount a persistent volume for the SQLite database (`/data/fireworks.db`).
3. Run behind a reverse proxy (e.g., Caddy, Nginx, or Cloudflare Tunnel) with HTTPS termination.
4. Run process management via `systemd` or Docker container restarts.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
```

---

## 📜 License

ISC © MMollart
