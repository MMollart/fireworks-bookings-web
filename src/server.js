/**
 * Server entry point.
 * Initializes database, runs migrations, boots Express server.
 */

import { getDatabase, closeDatabase } from './db/index.js';
import { createApp } from './app.js';
import { config } from './config.js';

async function bootstrap() {
  console.log(`Starting Fireworks Bookings Web in [${config.env}] mode...`);

  // Initialize SQLite database and run schema migrations
  const db = getDatabase();
  console.log('Database initialized and migrations applied.');

  const app = createApp(db);

  const server = app.listen(config.port, config.host, () => {
    console.log(`🎆 Fireworks Bookings Web running at http://${config.host}:${config.port}`);
    console.log(`🔒 Authentication: Username + Password (No public registration)`);
    console.log(`🛡️  Customer data encrypted at rest with AES-256-GCM`);
  });

  function shutdown(signal) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    server.close(() => {
      console.log('HTTP server closed.');
      closeDatabase();
      console.log('Database connection closed.');
      process.exit(0);
    });

    // Force exit after 5 seconds if connections hang
    setTimeout(() => {
      console.error('Forced shutdown due to timeout.');
      process.exit(1);
    }, 5000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
