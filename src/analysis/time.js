/**
 * Calendar maths in Europe/London. Dates are handled as integer "day numbers" (days since 1970-01-01 of the London
 * calendar date), so grouping never drifts across BST/GMT changes.
 */
const TZ = 'Europe/London';
const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY = 86_400_000;
const HOUR = 3_600_000;

// Intl formatting is slow, and London's UTC offset only changes on the hour, so the day is cached per UTC hour.
const dayByHour = new Map();

/** London calendar day number for an ISO timestamp / date string / epoch ms; null when missing or invalid. */
export function londonDay(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const hour = Math.floor(ms / HOUR);
  let day = dayByHour.get(hour);
  if (day === undefined) {
    const p = Object.fromEntries(parts.formatToParts(new Date(hour * HOUR)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    day = Date.UTC(p.year, p.month - 1, p.day) / DAY;
    dayByHour.set(hour, day);
  }
  return day;
}

export const dayToIso = (n) => new Date(n * DAY).toISOString().slice(0, 10);
export const dayYear = (n) => new Date(n * DAY).getUTCFullYear();

/** Monday of the week containing the day. */
export const weekStart = (n) => n - ((new Date(n * DAY).getUTCDay() + 6) % 7);

export function monthStart(n) {
  const d = new Date(n * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY;
}

export function monthEnd(n) {
  const d = new Date(n * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY - 1;
}

const fmtDay = (n) => new Date(n * DAY).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

/** The calendar period (start/end day numbers, label) containing a day, for daily | weekly | monthly. */
export function periodOf(group, n) {
  if (group === 'daily') return { start: n, end: n, label: fmtDay(n) };
  if (group === 'weekly') {
    const s = weekStart(n);
    return { start: s, end: s + 6, label: `Week of ${fmtDay(s)}` };
  }
  const s = monthStart(n);
  return { start: s, end: monthEnd(n), label: new Date(s * DAY).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }) };
}

/** All consecutive periods covering [fromDay, toDay]. */
export function periodsBetween(group, fromDay, toDay) {
  const out = [];
  let cursor = fromDay;
  while (cursor <= toDay) {
    const p = periodOf(group, cursor);
    out.push(p);
    cursor = p.end + 1;
  }
  return out;
}

export { DAY };
