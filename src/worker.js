import { createApp } from './app.js';
import { wrapD1 } from './db/adapter.js';

const app = createApp((c) => wrapD1(c.env.DB));

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),

  // Daily housekeeping (see [triggers] in wrangler.toml).
  async scheduled(_event, env) {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
      env.DB.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(Date.now()),
    ]);
  },
};
