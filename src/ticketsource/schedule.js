/**
 * How often the automatic TicketSource refresh runs, chosen on the website (TicketSource tab, admins).
 *
 * The Worker's cron fires every 5 minutes (wrangler.toml); each tick decides whether a refresh is due. There are two
 * intervals: the normal one, and a shorter one used on the day of an event (any unsettled event with a performance
 * on today's Europe/London date). 0 switches the automatic refresh off.
 */
import { getState, setState } from './client.js';
import { listEventSummaries } from './events.js';
import { londonDay } from '../analysis/time.js';

export const CRON_STEP_MINUTES = 5;
export const INTERVAL_OPTIONS = [0, 5, 10, 15, 20, 30, 60, 120, 240, 360, 720, 1440];
export const DEFAULT_SCHEDULE = { normalMinutes: 30, eventDayMinutes: 10 };

// A tick may fire a little early or late; within this slack of the interval it still counts as due.
const SLACK_MS = 60_000;

const valid = (n) => INTERVAL_OPTIONS.includes(n);

export async function getSchedule(db) {
  const read = async (key, fallback) => {
    const raw = await getState(db, key);
    return raw !== null && valid(Number(raw)) ? Number(raw) : fallback;
  };
  return {
    normalMinutes: await read('auto_refresh_minutes', DEFAULT_SCHEDULE.normalMinutes),
    eventDayMinutes: await read('auto_refresh_event_day_minutes', DEFAULT_SCHEDULE.eventDayMinutes),
  };
}

/** Saves the intervals; throws a message suitable for the user if either is not one of INTERVAL_OPTIONS. */
export async function setSchedule(db, { normalMinutes, eventDayMinutes }) {
  const normal = Number(normalMinutes);
  const eventDay = Number(eventDayMinutes);
  if (!valid(normal) || !valid(eventDay)) {
    throw new Error(`Intervals must be one of ${INTERVAL_OPTIONS.join(', ')} minutes (0 = off)`);
  }
  await setState(db, 'auto_refresh_minutes', normal);
  await setState(db, 'auto_refresh_event_day_minutes', eventDay);
  return { normalMinutes: normal, eventDayMinutes: eventDay };
}

/** Unsettled events with a (not cancelled) performance on today's London date. */
export async function eventsToday(db, { settlementDays, now = Date.now() } = {}) {
  const today = londonDay(now);
  const events = await listEventSummaries(db, { settlementDays, now, state: 'unsettled' });
  return events.filter((e) => e.dates.some((d) => !d.cancelled && londonDay(d.starts_at) === today));
}

/**
 * The interval in force now and whether a refresh is due.
 * `lastStartedAt` is when the previous refresh (scheduled or run by hand) started.
 */
export async function refreshPlan(db, cfg, { now = Date.now() } = {}) {
  const schedule = await getSchedule(db);
  const today = await eventsToday(db, { settlementDays: cfg.settlementDays, now });
  const eventDay = today.length > 0;
  const minutes = eventDay ? schedule.eventDayMinutes : schedule.normalMinutes;
  const lastStartedAt = Number(await getState(db, 'auto_refresh_started_at')) || 0;

  let nextRunAt = null;
  if (minutes > 0) {
    const earliest = lastStartedAt ? lastStartedAt + minutes * 60_000 - SLACK_MS : now;
    const step = CRON_STEP_MINUTES * 60_000;
    nextRunAt = Math.max(Math.ceil(earliest / step) * step, Math.ceil(now / step) * step);
  }
  return {
    ...schedule,
    eventDay,
    eventsToday: today.map((e) => e.name),
    everyMinutes: minutes,
    lastStartedAt: lastStartedAt || null,
    due: minutes > 0 && (!lastStartedAt || now - lastStartedAt >= minutes * 60_000 - SLACK_MS),
    nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
  };
}
