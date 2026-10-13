/**
 * Every event side by side, one bar per event year (earliest to most recent): tickets, bookings, revenue, donations.
 *
 *  - "All sales": everything booked for each event.
 *  - "Equivalent date": only bookings made at least N days before their own performance, where N is how many days the
 *    selected event's performance is away today. The same point in each year's sales cycle. If the selected event's
 *    performance has already happened there is no such point, so all sales are shown and `equivalent` is false.
 */
import { londonDay } from './time.js';
import { summariseEvent } from './compare.js';
import { isComplete, splitMoney } from './data.js';
import { eventYear } from '../lib/eventName.js';

export function equivalentCutoff(selectedPerformances, now = Date.now()) {
  const today = londonDay(now);
  const upcoming = selectedPerformances.map((p) => londonDay(p.starts_at)).filter((d) => d !== null && d >= today).sort((a, b) => a - b);
  return upcoming.length ? upcoming[0] - today : null;
}

/** events: [{ id, firstStart, data: { performances, bookings } }] */
export function yearlyTotals({ events, selectedId, mode = 'all', now = Date.now() }) {
  const selected = events.find((e) => e.id === selectedId);
  const cutoff = mode === 'equivalent' && selected ? equivalentCutoff(selected.data.performances, now) : null;

  const rows = events
    .map((e) => {
      const summary = summariseEvent(e.data, 'whole', cutoff);
      let tickets = 0;
      let bookings = 0;
      const money = {};
      for (const band of summary.bands.values()) {
        tickets += band.tickets;
        bookings += band.bookings;
        for (const [cur, v] of Object.entries(band.money)) {
          money[cur] ??= { gross: 0, net: 0, donations: 0 };
          money[cur].gross += v.gross;
          money[cur].net += v.net;
          money[cur].donations += v.donations || 0;
        }
      }
      const incomplete = e.data.performances.filter((p) => !isComplete(p)).length;
      return {
        id: e.id,
        year: eventYear(e.firstStart),
        label: e.label,
        selected: e.id === selectedId,
        tickets,
        bookings,
        ...splitMoney(money),
        incomplete,
        excluded: summary.excluded,
      };
    })
    .sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));

  const currencies = [...new Set(rows.flatMap((r) => Object.keys(r.gross)))].sort();
  return { mode, cutoff, equivalent: mode === 'equivalent' && cutoff !== null, currencies, rows };
}
