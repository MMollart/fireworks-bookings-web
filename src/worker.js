import { createApp } from './app.js';
import { wrapD1 } from './db/adapter.js';
import { initConfig } from './config.js';
import { refreshUnsettled } from './ticketsource/auto.js';
import { refreshPlan } from './ticketsource/schedule.js';

const app = createApp((c) => wrapD1(c.env.DB));

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),

  // Every 5 minutes (see [triggers] in wrangler.toml): refresh unsettled events when the interval chosen on the website
  // (shorter on the day of an event) has passed; once a day also prune expired rows.
  async scheduled(event, env) {
    const db = wrapD1(env.DB);
    const when = new Date(event.scheduledTime ?? Date.now());

    if (when.getUTCHours() === 3 && when.getUTCMinutes() < 5) {
      const now = when.toISOString();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
        env.DB.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(Date.now()),
      ]);
    }

    try {
      const cfg = initConfig(env).ticketSource;
      const plan = await refreshPlan(db, cfg, { now: when.getTime() });
      if (!plan.due) return;
      console.log('Unsettled event refresh:', JSON.stringify(await refreshUnsettled(db, cfg)));
    } catch (err) {
      console.error('Unsettled event refresh failed:', err);
      await db.prepare("INSERT OR REPLACE INTO ts_state (key, value) VALUES ('auto_refresh_result', ?)").run(JSON.stringify({ status: 'error', error: String(err.message || err) }));
      await db.prepare("INSERT OR REPLACE INTO ts_state (key, value) VALUES ('auto_refresh_at', ?)").run(new Date().toISOString());
    }
  },
};
