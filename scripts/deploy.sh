#!/usr/bin/env bash
# Fireworks Bookings - Cloudflare / Node Deployment Script
# Modeled after scout-budget deployment pattern

set -euo pipefail

echo "=================================================="
echo "🎆 Fireworks Bookings Web Deployment"
echo "=================================================="

# Check for node
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is required but not installed."
  exit 1
fi

echo "📦 Installing production dependencies..."
npm ci --omit=dev

echo "🗄️ Running local migrations..."
node scripts/migrate.js

if command -v wrangler >/dev/null 2>&1; then
  echo "☁️ Wrangler found. Checking D1 deployment..."
  if [ -n "${CLOUDFLARE_D1_NAME:-}" ]; then
    echo "Applying migrations to remote Cloudflare D1: $CLOUDFLARE_D1_NAME"
    wrangler d1 execute "$CLOUDFLARE_D1_NAME" --file=./src/db/schema.sql
  fi
  echo "🚀 Deploying worker..."
  wrangler deploy
else
  echo "ℹ️ Wrangler CLI not installed locally. Run 'npm install -g wrangler' or run locally with 'npm start'."
fi

echo "✅ Deployment procedure finished."
