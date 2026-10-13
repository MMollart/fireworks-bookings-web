/**
 * Resumable, budgeted sync of one TicketSource event's bookings.
 *
 * `syncEventStep` does as much work as one Worker invocation's API budget allows and saves its
 * position in ts_dates (scan_next = next bookings page). The caller keeps calling it until
 * `done` is true, waiting `retryAfterMs` when told to. Progress is idempotent: bookings whose
 * TicketSource `updated_at` we already hold are skipped without further API calls.
 *
 *   unsettled event -> incremental: only bookings changed since the date's last checkpoint
 *   settled/archived -> full scan (still skips unchanged bookings unless mode = 'force')
 */
import { StepLimit, getState, setState } from './client.js';
import { refreshDates, eventState } from './events.js';
import { ingestBooking } from './ingest.js';
import { randomHex } from '../lib/bytes.js';

const CHECKPOINT_SAFETY_MS = 60_000; // re-check anything updated around scan start (clock skew / in-flight edits)

function bookingsUrl(date, mode) {
  const base = `/dates/${date.id}/bookings`;
  return { path: base, params: { per_page: 100 }, incremental: mode === 'incremental' && Boolean(date.checkpoint) };
}

function dayBefore(iso) {
  const d = new Date(Date.parse(iso) - 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function startScan(db, date, mode, now) {
  const scanId = randomHex(8);
  await db
    .prepare(
      `UPDATE ts_dates SET scan_state = 'scanning', scan_mode = ?, scan_started_at = ?, scan_id = ?, scan_next = NULL, scan_seen = 0, scan_imported = 0 WHERE id = ?`
    )
    .run(mode, new Date(now).toISOString(), scanId, date.id);
  return { ...date, scan_state: 'scanning', scan_mode: mode, scan_started_at: new Date(now).toISOString(), scan_id: scanId, scan_next: null, scan_seen: 0, scan_imported: 0 };
}

async function finishScan(db, date, now) {
  const checkpoint = new Date(Math.min(now, Date.parse(date.scan_started_at) || now) - CHECKPOINT_SAFETY_MS).toISOString();
  await db
    .prepare(
      `UPDATE ts_dates SET scan_state = 'complete', scan_next = NULL, checkpoint = ?, last_synced_at = ? WHERE id = ?`
    )
    .run(checkpoint, new Date(now).toISOString(), date.id);
}

/** First request of a scan; incremental scans ask the API only for bookings changed since the checkpoint. */
async function fetchFirstPage(db, client, date, mode) {
  const { path, params, incremental } = bookingsUrl(date, mode);
  if (incremental && (await getState(db, 'filter_after')) !== 'unsupported') {
    try {
      return await client.get(path, {
        ...params,
        'filter[updated_at][operator]': 'after',
        // The API compares whole dates (2019-01-01), so go back a day to include same-day changes; local comparison dedupes.
        'filter[updated_at][value]': dayBefore(date.checkpoint),
      });
    } catch (err) {
      if (err.status === 400 || err.status === 422) {
        await setState(db, 'filter_after', 'unsupported'); // fall back to a full list + local comparison
      } else {
        throw err;
      }
    }
  }
  return client.get(path, params);
}

export async function syncEventStep(db, client, tsEventId, opts, cfg) {
  const now = opts.now ?? Date.now();
  const event = await db.prepare('SELECT * FROM ts_events WHERE id = ?').get(tsEventId);
  if (!event) throw Object.assign(new Error('Event not found - refresh the events list first'), { status: 404 });

  const summary = { calls: 0, seen: 0, imported: 0, skipped: 0 };
  const result = (extra) => ({ ...summary, calls: client.callsMade, ...extra });

  try {
    await client.begin();
  } catch (err) {
    if (err instanceof StepLimit) return result({ done: false, waiting: err.reason, retryAfterMs: err.retryAfterMs, message: err.message });
    throw err;
  }

  try {
    let dates = await db.prepare('SELECT * FROM ts_dates WHERE event_id = ? ORDER BY starts_at').all(tsEventId);
    if (event.dates_fetched_at === null || dates.length === 0 || opts.refreshDates) {
      await refreshDates(db, client, event, now);
      dates = await db.prepare('SELECT * FROM ts_dates WHERE event_id = ? ORDER BY starts_at').all(tsEventId);
    }

    const state = eventState(event, dates, cfg.settlementDays, now);
    const requested = opts.mode;
    const mode = requested === 'full' || requested === 'force' ? requested : state === 'unsettled' ? 'incremental' : 'full';
    const force = mode === 'force';
    summary.mode = mode;
    summary.state = state;

    // A new run (start) re-opens dates finished by the previous run; restart also abandons half-done scans.
    if (opts.start || opts.restart) {
      await db
        .prepare(`UPDATE ts_dates SET scan_state = 'idle' WHERE event_id = ? AND (scan_state = 'complete' OR ?)`)
        .run(tsEventId, opts.restart ? 1 : 0);
      dates = dates.map((d) => (d.scan_state === 'complete' || opts.restart ? { ...d, scan_state: 'idle' } : d));
    }

    for (let date of dates) {
      if (date.scan_state === 'idle') date = await startScan(db, date, mode, now);
      if (date.scan_state !== 'scanning') continue; // complete in this run

      // Resume the mode the scan began with
      const scanMode = date.scan_mode || mode;
      const scanForce = scanMode === 'force';

      while (true) {
        const page = date.scan_next
          ? await client.get(date.scan_next)
          : await fetchFirstPage(db, client, date, scanMode);

        const bookings = page.data || [];
        const importedBefore = summary.imported;
        const known = new Map();
        if (bookings.length) {
          const ids = bookings.map((b) => b.id);
          const rows = await db
            .prepare(`SELECT ts_booking_id, ts_updated_at, ts_scan_id FROM bookings WHERE ts_booking_id IN (${ids.map(() => '?').join(',')})`)
            .all(...ids);
          for (const r of rows) known.set(r.ts_booking_id, r);
        }

        for (const b of bookings) {
          const have = known.get(b.id);
          const unchanged = Boolean(have) && have.ts_updated_at === (b.attributes?.updated_at || b.attributes?.created_at || null);
          // A forced scan re-reads everything, so "already done" means written by THIS scan (resumes must not start the page over).
          const doneThisScan = Boolean(have) && Boolean(date.scan_id) && have.ts_scan_id === date.scan_id;
          summary.seen++;
          if (scanForce ? doneThisScan : unchanged) {
            summary.skipped++;
            continue;
          }
          await ingestBooking(db, client, b, { date, now, force: scanForce, scanId: date.scan_id, customerTtlMs: cfg.customerTtlHours * 3_600_000 });
          summary.imported++;
        }

        // Page fully processed: persist position so a later step resumes after it.
        const next = page.links?.next || null;
        date.scan_seen += bookings.length;
        date.scan_imported += summary.imported - importedBefore;
        if (next) {
          date.scan_next = next;
          await db.prepare('UPDATE ts_dates SET scan_next = ?, scan_seen = ?, scan_imported = ? WHERE id = ?').run(next, date.scan_seen, date.scan_imported, date.id);
        } else {
          await finishScan(db, date, now);
          break;
        }
      }
    }

    return result({ done: true });
  } catch (err) {
    if (err instanceof StepLimit) return result({ done: false, waiting: err.reason, retryAfterMs: err.retryAfterMs, message: err.message });
    throw err;
  } finally {
    await client.end();
  }
}
