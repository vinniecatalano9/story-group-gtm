const { google } = require('googleapis');

const CALENDAR_ID = () => process.env.GOOGLE_CALENDAR_ID;
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

// Business hours in CST (9 AM - 5 PM)
const BIZ_START = 9;
const BIZ_END = 17;
const SLOT_MINUTES = 30;
const TIMEZONE = 'America/Chicago';

// CST offset from UTC (hours). -5 for CST, -4 for EDT.
function getCSTOffset() {
  // Check if currently EDT by seeing if a date in the range formats differently
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  // Use Intl to check
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
  const parts = formatter.formatToParts(now);
  const tzName = parts.find(p => p.type === 'timeZoneName')?.value;
  return tzName === 'CDT' ? -5 : -6;
}

/**
 * Create a Date object for a specific hour in CST/EDT.
 */
function estDate(baseDate, hour, minute = 0) {
  const offset = getCSTOffset();
  const d = new Date(baseDate);
  // Set to midnight UTC, then add hours adjusted for CST
  d.setUTCHours(hour - offset, minute, 0, 0);
  return d;
}

let _calendar = null;

function getCalendar() {
  if (_calendar) return _calendar;
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  _calendar = google.calendar({ version: 'v3', auth });
  return _calendar;
}

/**
 * Get the next N business days (skipping weekends).
 */
function getNextBusinessDays(count = 2) {
  const days = [];
  // Get "today" in CST
  const offset = getCSTOffset();
  const now = new Date();
  const estNow = new Date(now.getTime() + offset * 3600000);

  let d = new Date(Date.UTC(estNow.getUTCFullYear(), estNow.getUTCMonth(), estNow.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 1); // start from tomorrow

  while (days.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      days.push(new Date(d));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/**
 * Query Google Calendar freebusy, return one AM slot and one PM slot
 * across the next 2 business days.
 */
async function getAvailableSlots() {
  const calId = CALENDAR_ID();
  if (!calId) {
    console.log('[calendar] No GOOGLE_CALENDAR_ID configured, skipping');
    return null;
  }

  try {
    const calendar = getCalendar();
    const days = getNextBusinessDays(2);

    const timeMin = estDate(days[0], BIZ_START);
    const timeMax = estDate(days[days.length - 1], BIZ_END);

    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: TIMEZONE,
        items: [{ id: calId }],
      },
    });

    const busy = (res.data.calendars[calId]?.busy || []).map(b => ({
      start: new Date(b.start),
      end: new Date(b.end),
    }));

    let amSlot = null;
    let pmSlot = null;

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (const day of days) {
      if (amSlot && pmSlot) break;

      const dayName = dayNames[day.getUTCDay()];

      // Try AM slots (9 AM - 12 PM CST)
      if (!amSlot) {
        for (let hour = BIZ_START; hour < 12; hour++) {
          for (let min = 0; min < 60; min += SLOT_MINUTES) {
            const slotStart = estDate(day, hour, min);
            const slotEnd = new Date(slotStart.getTime() + SLOT_MINUTES * 60000);

            const conflict = busy.some(b => slotStart < b.end && slotEnd > b.start);

            if (!conflict) {
              const h = hour > 12 ? hour - 12 : hour;
              const ampm = hour >= 12 ? 'PM' : 'AM';
              const minStr = min === 0 ? '' : `:${String(min).padStart(2, '0')}`;
              amSlot = `${dayName} at ${h}${minStr} ${ampm} CST`;
              break;
            }
          }
          if (amSlot) break;
        }
      }

      // Try PM slots (1 PM - 5 PM CST) — prefer different day than AM
      if (!pmSlot && (amSlot || days.indexOf(day) > 0)) {
        for (let hour = 13; hour < BIZ_END; hour++) {
          for (let min = 0; min < 60; min += SLOT_MINUTES) {
            const slotStart = estDate(day, hour, min);
            const slotEnd = new Date(slotStart.getTime() + SLOT_MINUTES * 60000);

            const conflict = busy.some(b => slotStart < b.end && slotEnd > b.start);

            if (!conflict) {
              const h = hour > 12 ? hour - 12 : hour;
              const minStr = min === 0 ? '' : `:${String(min).padStart(2, '0')}`;
              pmSlot = `${dayName} at ${h}${minStr} PM CST`;
              break;
            }
          }
          if (pmSlot) break;
        }
      }
    }

    if (!amSlot && !pmSlot) return null;

    console.log(`[calendar] Found slots: AM=${amSlot}, PM=${pmSlot}`);
    return { amSlot, pmSlot };
  } catch (e) {
    console.error('[calendar] Error fetching availability:', e.message);
    return null;
  }
}

/**
 * List today's remaining events (ET) from the Story Group calendar,
 * with attendee emails for prospect detection.
 */
async function getTodaysEvents() {
  const calId = CALENDAR_ID();
  if (!calId) {
    console.log('[calendar] No GOOGLE_CALENDAR_ID configured, skipping');
    return [];
  }
  const calendar = getCalendar();
  const now = new Date();
  const res = await calendar.events.list({
    calendarId: calId,
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 25,
  });
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const today = dayFmt.format(now);
  return (res.data.items || [])
    .filter(e => {
      const start = e.start?.dateTime || e.start?.date;
      return start && dayFmt.format(new Date(start)) === today && e.status !== 'cancelled';
    })
    .map(e => ({
      id: e.id,
      title: e.summary || '',
      start: e.start?.dateTime || e.start?.date,
      description: e.description || '',
      attendees: (e.attendees || [])
        .map(a => ({ email: (a.email || '').toLowerCase(), name: a.displayName || '' }))
        .filter(a => a.email),
    }));
}

/**
 * List events from `daysBack` ago to `daysAhead` from now, with attendees.
 * Used to check whether a prospect ever booked.
 */
async function getEventsWindow({ daysBack = 7, daysAhead = 14 } = {}) {
  const calId = CALENDAR_ID();
  if (!calId) return [];
  const calendar = getCalendar();
  const now = Date.now();
  const res = await calendar.events.list({
    calendarId: calId,
    timeMin: new Date(now - daysBack * 86400e3).toISOString(),
    timeMax: new Date(now + daysAhead * 86400e3).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });
  return (res.data.items || []).map(e => ({
    title: e.summary || '',
    start: e.start?.dateTime || e.start?.date,
    attendees: (e.attendees || []).map(a => (a.email || '').toLowerCase()).filter(Boolean),
  }));
}

// ── Meeting slots in Vincent's format ──────────────────────────────────────
//
// His times line is "Great. Are you free [day] at [time] or [time] EST?": one
// day, a morning and an afternoon time, Eastern. Times come from Vincent's
// calendar by default. When he asks for someone else to be free too ("make
// sure me and McKenna are free"), their calendar is checked as well and only
// times when everyone is free are offered. A calendar the service account
// can't read is reported in `unreadable`, never guessed.

const ET = 'America/New_York';
const PEOPLE = () => ({
  vincent: process.env.CALENDAR_ID_VINCENT || process.env.GOOGLE_CALENDAR_ID,
  mckenna: process.env.CALENDAR_ID_MCKENNA,
  aaron: process.env.CALENDAR_ID_AARON,
});
// His most-used times, in the order he reaches for them.
const AM_TIMES = [[11, 0], [11, 30], [10, 30], [10, 0], [12, 0]];
const PM_TIMES = [[15, 0], [15, 30], [14, 0], [14, 30], [16, 0], [13, 0]];
const MEETING_MINUTES = 30;

function etParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ET, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
}

// The instant that is h:min Eastern on y-m-d, daylight time or not.
function etInstant(y, m, d, h, min) {
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(y, m - 1, d, h + off, min));
    if (etParts(t).h === h) return t;
  }
  return new Date(Date.UTC(y, m - 1, d, h + 5, min));
}

function fmtTime(h, min) {
  const hh = h > 12 ? h - 12 : h;
  return `${hh}${min ? `:${String(min).padStart(2, '0')}` : ''} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Business days starting `startInDays` calendar days out (48 hours of runway
 * by default), `count` of them, as {y, m, d, dow} in Eastern time.
 */
function etBusinessDays(now, startInDays, count) {
  const t = etParts(now);
  const out = [];
  for (let i = startInDays; out.length < count && i < startInDays + 14; i++) {
    const noon = new Date(Date.UTC(t.y, t.m - 1, t.d + i, 12));
    const dow = noon.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push({ y: noon.getUTCFullYear(), m: noon.getUTCMonth() + 1, d: noon.getUTCDate(), dow });
  }
  return out;
}

/**
 * @param {string[]} people  'vincent' (default), plus 'mckenna' or 'aaron' when he asks.
 * @returns {{day, time1, time2, people, unreadable}} day is null when nothing fits.
 */
async function findMeetingSlots({ people = ['vincent'], startInDays = 2, searchDays = 5, now = new Date() } = {}) {
  const ids = PEOPLE();
  const unreadable = [];
  const readable = [];
  for (const person of [...new Set(people)]) {
    if (ids[person]) readable.push({ person, id: ids[person] });
    else unreadable.push({ person, reason: 'no calendar id configured' });
  }
  if (!readable.length) return { day: null, time1: null, time2: null, people: [], unreadable };

  const days = etBusinessDays(now, startInDays, searchDays);
  const first = days[0];
  const last = days[days.length - 1];
  const res = await getCalendar().freebusy.query({
    requestBody: {
      timeMin: etInstant(first.y, first.m, first.d, 0, 0).toISOString(),
      timeMax: etInstant(last.y, last.m, last.d, 23, 59).toISOString(),
      timeZone: ET,
      items: readable.map(r => ({ id: r.id })),
    },
  });

  const busy = [];
  const checked = [];
  for (const r of readable) {
    const cal = res.data.calendars && res.data.calendars[r.id];
    if (!cal || (cal.errors && cal.errors.length)) {
      unreadable.push({ person: r.person, reason: (cal && cal.errors && cal.errors[0] && cal.errors[0].reason) || 'not returned' });
      continue;
    }
    checked.push(r.person);
    for (const b of cal.busy || []) busy.push({ start: new Date(b.start), end: new Date(b.end) });
  }
  if (!checked.length) return { day: null, time1: null, time2: null, people: [], unreadable };

  const free = (day, [h, min]) => {
    const start = etInstant(day.y, day.m, day.d, h, min);
    const end = new Date(start.getTime() + MEETING_MINUTES * 60000);
    return !busy.some(b => start < b.end && end > b.start);
  };
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (const day of days) {
    const am = AM_TIMES.find(t => free(day, t));
    const pm = PM_TIMES.find(t => free(day, t));
    if (am && pm) {
      // Day name plus the date ("Thursday, October 22"): Vincent wants every
      // offered day pinned to a date, never a bare weekday.
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return { day: `${dayNames[day.dow]}, ${monthNames[day.m - 1]} ${day.d}`, time1: fmtTime(...am), time2: fmtTime(...pm), people: checked, unreadable };
    }
  }
  return { day: null, time1: null, time2: null, people: checked, unreadable };
}

/** Which people a free-text note asks to be free too ("me and McKenna"). */
function peopleFromNote(note) {
  const people = ['vincent'];
  if (/\bmc ?kenna\b/i.test(note || '')) people.push('mckenna');
  if (/\baaron\b/i.test(note || '')) people.push('aaron');
  return people;
}

module.exports = { getAvailableSlots, getTodaysEvents, getEventsWindow, findMeetingSlots, peopleFromNote };
