/* Demo bookings from /book.

   A booking is a lead with three extra fields: the type (online demo or
   on-site call-out), the slot it starts in, and for call-outs the address.
   The page offers the next 14 days, Monday to Friday, skipping South African
   public holidays, between 09:00 and 17:00 SAST. This file checks a slot
   against the same rules, so a hand-made request cannot book a Sunday, a
   holiday or 03:00. book.js on the site carries the same holiday rules; keep
   the two in step. */

export const TYPES = {
  online: { label: 'Online demo', minutes: 30 },
  onsite: { label: 'On-site call-out', minutes: 60 },
};

// SAST is UTC+2 all year (no daylight saving).
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_MINUTE = 9 * 60;
const CLOSE_MINUTE = 17 * 60;
// The page offers the next 14 days. One day of slack covers a page left open
// over midnight.
const MAX_DAYS_AHEAD = 15;

// Slots look like 2026-10-27T09:00+02:00, exactly as the page sends them.
const SLOT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})\+02:00$/;

// Days the President declared public holidays on top of the fixed list,
// such as election days. Add each new one here and in book.js.
const DECLARED = ['2026-11-04'];

const FIXED = ['01-01', '03-21', '04-27', '05-01', '06-16', '08-09', '09-24', '12-16', '12-25', '12-26'];

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Easter Sunday (Gregorian), by the anonymous Gregorian algorithm.
function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

/* South African public holidays in a year, as a Set of YYYY-MM-DD.
   Public Holidays Act 36 of 1994: the fixed days, Good Friday and Family Day
   (the Monday after Easter), and when a holiday falls on a Sunday the Monday
   after it is a holiday too. */
export function publicHolidays(year) {
  const days = new Set(FIXED.map((md) => `${year}-${md}`));
  const sunday = easter(year);
  days.add(new Date(sunday - 2 * DAY_MS).toISOString().slice(0, 10));
  days.add(new Date(sunday + DAY_MS).toISOString().slice(0, 10));
  for (const day of [...days]) {
    const t = Date.parse(day + 'T00:00:00Z');
    if (new Date(t).getUTCDay() === 0) days.add(new Date(t + DAY_MS).toISOString().slice(0, 10));
  }
  for (const day of DECLARED) if (day.startsWith(year + '-')) days.add(day);
  return days;
}

/* Checks a requested slot. Returns null when it can be booked, or a short
   reason when it cannot. `now` is a timestamp in ms. */
export function slotProblem(type, slot, now) {
  const kind = TYPES[type];
  if (!kind) return 'unknown_type';
  const m = SLOT.exec(slot);
  if (!m) return 'bad_format';
  const [, y, mo, d, h, mi] = m.map(Number);
  const startUtc = Date.UTC(y, mo - 1, d, h, mi) - SAST_OFFSET_MS;
  // Date.UTC rolls 2026-02-30 over into March; a real date survives a round trip.
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return 'bad_format';

  const weekday = day.getUTCDay();
  if (weekday === 0 || weekday === 6) return 'weekend';
  if (publicHolidays(y).has(iso(y, mo, d))) return 'public_holiday';

  const start = h * 60 + mi;
  // Online demos start on the hour or half hour, call-outs on the hour.
  if (mi % kind.minutes !== 0) return 'off_grid';
  if (start < OPEN_MINUTE || start + kind.minutes > CLOSE_MINUTE) return 'outside_hours';

  if (startUtc <= now) return 'in_the_past';
  if (startUtc - now > MAX_DAYS_AHEAD * DAY_MS) return 'too_far_ahead';
  return null;
}

// "Online demo (30 min), Tue 27 Oct 2026 at 09:00 SAST", for Slack.
export function describe(type, slot) {
  const kind = TYPES[type];
  const m = SLOT.exec(slot);
  if (!kind || !m) return '';
  const [, y, mo, d, h, mi] = m;
  const day = new Date(Date.UTC(+y, +mo - 1, +d));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getUTCDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mo - 1];
  return `${kind.label} (${kind.minutes} min), ${weekday} ${+d} ${month} ${y} at ${h}:${mi} SAST`;
}
