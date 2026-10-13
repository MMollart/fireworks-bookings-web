/**
 * The same event is run every year under the same name, so wherever an event is shown it is labelled by the year of its
 * performance ("2026"), Europe/London. If the performance date is unknown the TicketSource name is used instead.
 */
import { londonDay, dayYear } from '../analysis/time.js';

export function eventYear(startsAt) {
  const day = londonDay(startsAt);
  return day === null ? null : dayYear(day);
}

export function eventLabel(name, startsAt) {
  const year = eventYear(startsAt);
  return year === null ? String(name ?? '').trim() || 'TicketSource event' : String(year);
}
