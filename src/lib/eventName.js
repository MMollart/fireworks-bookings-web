/**
 * The same event is run every year under the same name, so anywhere an event name is shown it is prefixed with the
 * year of its (first) performance: "2026 Lydiard Fireworks & Bonfire Spectacular". Years are Europe/London.
 */
import { londonDay, dayYear } from '../analysis/time.js';

export function eventYear(startsAt) {
  const day = londonDay(startsAt);
  return day === null ? null : dayYear(day);
}

export function withYear(name, startsAt) {
  const base = String(name ?? '').trim() || 'TicketSource event';
  if (/^\d{4}\s/.test(base)) return base; // already carries a year
  const year = eventYear(startsAt);
  return year === null ? base : `${year} ${base}`;
}
