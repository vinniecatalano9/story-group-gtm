// Wall-clock helpers for a named time zone (no date library in this repo).

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** { y, m, d, h, min, dow } of `date` as seen in `tz`. */
function parts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'long',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, dow: DOW.indexOf(p.weekday) };
}

/** The instant that reads y-m-d h:min on a wall clock in `tz`. */
function instant(tz, y, m, d, h = 0, min = 0) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  // Offset at the guess, then once more in case the guess crossed a DST edge.
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(t), tz);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    t += guess - seen;
  }
  return new Date(t);
}

/** Calendar date n days after y-m-d, as { y, m, d, dow }. */
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

// Office holidays (11/23/2026, after the slot finder offered Thanksgiving):
// no sends and no offered meeting times on these. Fixed dates plus Memorial
// Day, Labor Day, and Thanksgiving with the Friday after.
function nthDow(y, m, dow, n) { // n-th (1-based) weekday `dow` of month m; n = -1 for the last
  if (n > 0) { const f = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((dow - f + 7) % 7) + (n - 1) * 7; }
  const lastD = new Date(Date.UTC(y, m, 0)).getUTCDate(); const l = new Date(Date.UTC(y, m - 1, lastD)).getUTCDay();
  return lastD - ((l - dow + 7) % 7);
}
function isHoliday(day) {
  const { y, m, d } = day;
  const md = `${m}-${d}`;
  if (['1-1', '7-4', '12-24', '12-25', '12-31'].includes(md)) return true;
  if (m === 5 && d === nthDow(y, 5, 1, -1)) return true; // Memorial Day
  if (m === 9 && d === nthDow(y, 9, 1, 1)) return true; // Labor Day
  const tg = nthDow(y, 11, 4, 4); // Thanksgiving
  if (m === 11 && (d === tg || d === tg + 1)) return true;
  return false;
}
const isWeekday = day => day.dow >= 1 && day.dow <= 5 && !isHoliday(day);
const dayKey = ({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** First weekday on or after `day`. */
function weekdayOnOrAfter(day) {
  let x = addDays(day, 0);
  while (!isWeekday(x)) x = addDays(x, 1);
  return x;
}

/** "10:00am", "2:30pm" */
function clock(date, tz) {
  const p = parts(date, tz);
  const h = p.h % 12 || 12;
  return `${h}:${String(p.min).padStart(2, '0')}${p.h < 12 ? 'am' : 'pm'}`;
}

module.exports = { DOW, parts, instant, addDays, isWeekday, isHoliday, dayKey, weekdayOnOrAfter, clock };
