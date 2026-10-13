/**
 * Scheduled refresh of unsettled events (every 30 minutes, see [triggers] in wrangler.toml).
 *
 * Re-reads the event list and dates, then runs an incremental booking sync for every event that is unsettled
 * (including one that was unsettled when the run began and has just been settled, so its last changes are captured).
 * Settled and archived events are left alone. Read-only, like everything that talks to TicketSource.
 */
import { TicketSourceClient, StepLimit, getState, setState } from './client.js';
import { refreshEvents, listEventSummaries } from './events.js';
import { syncEventStep } from './engine.js';

const LOCK_MS = 14 * 60_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function refreshUnsettled(db, cfg, { budgetMs = 10 * 60_000, now = () => Date.now(), sleep = defaultSleep, clientOptions } = {}) {
  if (!cfg.apiKey) return { status: 'skipped', reason: 'TicketSource is not configured' };

  const started = now();
  const lock = Number(await getState(db, 'auto_refresh_lock')) || 0;
  if (lock && started - lock < LOCK_MS) return { status: 'skipped', reason: 'a refresh is already running' };
  await setState(db, 'auto_refresh_lock', started);

  const deadline = started + budgetMs;
  const summary = { status: 'ok', events: 0, imported: 0, seen: 0, calls: 0, error: null };
  const newClient = () => new TicketSourceClient(db, cfg, clientOptions);

  /** Runs a step, waiting out rate limits until the deadline. Returns false if it ran out of time. */
  const withWaits = async (step) => {
    while (true) {
      const result = await step();
      if (!result || result.done !== false) return true;
      if (now() + (result.retryAfterMs || 1000) >= deadline) return false;
      await sleep(Math.max(250, result.retryAfterMs || 1000));
    }
  };

  try {
    const before = await listEventSummaries(db, { settlementDays: cfg.settlementDays, now: now() });
    const targets = new Set(before.filter((e) => e.state === 'unsettled').map((e) => e.id));

    const refreshed = await withWaits(async () => {
      const client = newClient();
      try {
        await client.begin();
        await refreshEvents(db, client, { force: true, ttlMs: 0, now: now() });
        summary.calls += client.callsMade;
        return { done: true };
      } catch (err) {
        if (err instanceof StepLimit) return { done: false, retryAfterMs: err.retryAfterMs };
        throw err;
      } finally {
        await client.end();
      }
    });
    if (!refreshed) throw new Error('Timed out refreshing the event list');

    const after = await listEventSummaries(db, { settlementDays: cfg.settlementDays, now: now() });
    for (const e of after) if (e.state === 'unsettled') targets.add(e.id);
    const known = new Set(after.map((e) => e.id));

    for (const id of targets) {
      if (!known.has(id)) continue;
      // A new run re-opens the dates finished by the previous one (what `start` does for the manual sync).
      await db.prepare("UPDATE ts_dates SET scan_state = 'idle' WHERE event_id = ? AND scan_state = 'complete'").run(id);
      const finished = await withWaits(async () => {
        const r = await syncEventStep(db, newClient(), id, {}, cfg);
        summary.calls += r.calls || 0;
        summary.imported += r.imported || 0;
        summary.seen += r.seen || 0;
        return r;
      });
      summary.events++;
      if (!finished) {
        summary.status = 'incomplete';
        summary.error = 'Ran out of time; it will continue at the next run';
        break;
      }
    }
  } catch (err) {
    summary.status = 'error';
    summary.error = err.message;
  } finally {
    await setState(db, 'auto_refresh_lock', 0);
    await setState(db, 'auto_refresh_at', new Date(now()).toISOString());
    await setState(db, 'auto_refresh_result', JSON.stringify(summary));
  }
  return summary;
}
