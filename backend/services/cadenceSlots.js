// services/cadenceSlots.js — the call times the ad lead cadence offers.
//
// Rules (outreach/AD_LEADS_CADENCE_PLAN.md sections 6 and 7, same calendar
// rules as the New Lead Auto-Draft Apps Script):
// - Busy = events on vincent@storygroup.io (Vincent doesn't use the
//   wrsmedia.com calendar, 10/22; add it via CADENCE_CALENDARS). Declined
//   events are free; all-day events only block when they say OOO, out of
//   office, vacation, PTO, or holiday.
// - Today: first open 30 min at least 1 hour after the send, ending by 5pm ET.
// - Otherwise one business day (from tomorrow): first open 30 min 10am to
//   12pm ET and first open 30 min 2pm to 5pm ET, both on that day.
// - Every offered time is held in slot_holds so no other lead (or LinkedIn
//   reply offer) gets it. A window that's full or held rolls to the next
//   business day. A held time is offered again only once every open slot in
//   the next 5 business days is held, oldest hold first.

const { google } = require('googleapis');
const z = require('../lib/zoned');

const ET = 'America/New_York';
const SLOT_MIN = 30;
const LOOKAHEAD_DAYS = 5;
const CALENDARS = () => (process.env.CADENCE_CALENDARS || 'vincent@storygroup.io').split(',').map(s => s.trim()).filter(Boolean);
const OOO = /\b(OOO|out of (the )?office|vacation|PTO|holiday)\b/i;

let _cal = null;
function cal() {
  if (!_cal) _cal = google.calendar({ version: 'v3', auth: new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/calendar.readonly'] }) });
  return _cal;
}

/** Busy intervals across both calendars, plus which calendars couldn't be read. */
async function calendarBusy(timeMin, timeMax) {
  const busy = [];
  const unreadable = [];
  for (const id of CALENDARS()) {
    try {
      let pageToken;
      do {
        const r = await cal().events.list({
          calendarId: id, timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
          singleEvents: true, maxResults: 250, pageToken,
        });
        for (const e of r.data.items || []) {
          if (e.status === 'cancelled') continue;
          const me = (e.attendees || []).find(a => a.self);
          if (me && me.responseStatus === 'declined') continue;
          if (e.start && e.start.date) {
            if (!OOO.test(e.summary || '')) continue;
            const [sy, sm, sd] = e.start.date.split('-').map(Number);
            const [ey, em, ed] = e.end.date.split('-').map(Number);
            busy.push({ start: z.instant(ET, sy, sm, sd), end: z.instant(ET, ey, em, ed) });
            continue;
          }
          busy.push({ start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) });
        }
        pageToken = r.data.nextPageToken;
      } while (pageToken);
    } catch (e) {
      unreadable.push({ id, reason: e.message });
      console.warn(`[cadenceSlots] Couldn't read calendar ${id}: ${e.message}`);
    }
  }
  return { busy, unreadable };
}

const toDate = v => (v && v.toDate ? v.toDate() : new Date(v));

/** Every hold that hasn't passed: { start, end, key, created_at }. */
async function activeHolds() {
  const { db } = require('./db');
  const snap = await db.collection('slot_holds').where('end', '>', new Date()).get();
  return snap.docs.map(d => d.data()).map(h => ({
    start: toDate(h.start), end: toDate(h.end), key: h.reply_id || '', created_at: toDate(h.created_at || 0),
  }));
}

const overlaps = (s, list) => list.filter(b => s < b.end && new Date(s.getTime() + SLOT_MIN * 6e4) > b.start);

/** 30-minute starts on an ET day between two wall-clock hours. */
function candidates(day, fromHour, toHour, notBefore) {
  const out = [];
  const end = z.instant(ET, day.y, day.m, day.d, toHour);
  for (let t = z.instant(ET, day.y, day.m, day.d, fromHour); t.getTime() + SLOT_MIN * 6e4 <= end.getTime(); t = new Date(t.getTime() + SLOT_MIN * 6e4)) {
    if (!notBefore || t >= notBefore) out.push(t);
  }
  return out;
}

/**
 * Plan the times one lead is offered. Read-only: call holdOffer() to keep them.
 * Vincent's format (10/22): a call today if there's room, else ONE business
 * day with a morning time (10 to 12 ET) and an afternoon time (2 to 5 ET).
 * @param sendAt  when the message goes out
 * @param key     this lead's hold key; its own holds don't block it
 * @returns { today, day, am, pm } (Dates or null), and calendar notes
 */
async function planOffer({ sendAt = new Date(), key = '' } = {}) {
  const sendEt = z.parts(sendAt, ET);
  const today = { y: sendEt.y, m: sendEt.m, d: sendEt.d, dow: sendEt.dow };
  const bizDays = [];
  for (let x = z.addDays(today, 1); bizDays.length < LOOKAHEAD_DAYS; x = z.addDays(x, 1)) if (z.isWeekday(x)) bizDays.push(x);
  const last = bizDays[bizDays.length - 1];

  const { busy, unreadable } = await calendarBusy(z.instant(ET, today.y, today.m, today.d), z.instant(ET, last.y, last.m, last.d, 23, 59));
  const holds = (await activeHolds().catch(e => { console.warn('[cadenceSlots] holds unreadable:', e.message); return []; }))
    .filter(h => h.key !== key);
  const now = new Date();
  const open = t => t > now && !overlaps(t, busy).length;
  const unheld = t => open(t) && !overlaps(t, holds).length;
  const holdAge = t => Math.min(...overlaps(t, holds).map(h => h.created_at.getTime()));

  // Today: from 1 hour after the send (on the half hour), ending by 5pm ET.
  let todaySlot = null;
  if (z.isWeekday(today)) {
    const earliest = new Date(Math.ceil((sendAt.getTime() + 60 * 6e4) / (SLOT_MIN * 6e4)) * SLOT_MIN * 6e4);
    todaySlot = candidates(today, 9, 17, earliest).find(unheld) || null;
  }

  // First business day with an unheld morning and afternoon time. Only when
  // every one of the next 5 business days is fully held does a held time get
  // offered again, the oldest hold first.
  let pick = null;
  for (const day of bizDays) {
    const am = candidates(day, 10, 12).find(unheld);
    const pm = candidates(day, 14, 17).find(unheld);
    if (am && pm) { pick = { day, am, pm }; break; }
  }
  if (!pick) {
    const oldest = list => list.filter(open).sort((x, y) => holdAge(x) - holdAge(y))[0] || null;
    const options = bizDays.map(day => ({ day, am: oldest(candidates(day, 10, 12)), pm: oldest(candidates(day, 14, 17)) }));
    pick = options.find(o => o.am && o.pm) || options.find(o => o.am || o.pm) || null;
  }
  return {
    today: todaySlot,
    day: pick ? z.instant(ET, pick.day.y, pick.day.m, pick.day.d, 12) : null,
    am: pick ? pick.am : null, pm: pick ? pick.pm : null,
    unreadable, planned_at: now,
  };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The day OR the date, never both (Vincent, 10/22): "Friday" within the next
 * 7 days, "October 30" beyond that, "today" for today.
 */
function dayLabel(t, ref = new Date(), tz = ET) {
  if (!t) return null;
  const p = z.parts(t, tz);
  const r = z.parts(ref, tz);
  const diff = Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(r.y, r.m - 1, r.d)) / 864e5);
  if (diff === 0) return 'today';
  return diff > 0 && diff < 7 ? z.DOW[p.dow] : `${MONTHS[p.m - 1]} ${p.d}`;
}

/** "Friday at 10:00am" / "October 30 at 2:00pm" (meeting labels and such). */
function slotLabel(t, ref = new Date()) {
  if (!t) return null;
  return `${dayLabel(t, ref)} at ${z.clock(t, ET)}`;
}

/** Labels for the copy: { today, day, am, pm, time } (strings or null). */
function labels(offer, ref = new Date()) {
  const asDate = v => (v ? toDate(v) : null);
  const t = asDate(offer && offer.today);
  const am = asDate(offer && offer.am);
  const pm = asDate(offer && offer.pm);
  return {
    today: t ? z.clock(t, ET) : null,
    day: dayLabel(asDate(offer && offer.day) || am || pm, ref),
    am: am ? z.clock(am, ET) : null,
    pm: pm ? z.clock(pm, ET) : null,
    time: am ? z.clock(am, ET) : pm ? z.clock(pm, ET) : null,
  };
}

/** Hold these offered times for this lead. Adds to its holds; each lapses once passed. */
async function holdOffer(offer, { key, name = '', only = null } = {}) {
  const { db } = require('./db');
  const times = (only || [offer.today, offer.am, offer.pm]).filter(Boolean).map(toDate);
  await Promise.all(times.map(t => db.collection('slot_holds').add({
    reply_id: key, source: 'cadence', name, label: slotLabel(t),
    start: t, end: new Date(t.getTime() + SLOT_MIN * 6e4), created_at: new Date(),
  })));
  return times.length;
}

async function releaseHolds(key) {
  if (!key) return 0;
  const { db } = require('./db');
  const snap = await db.collection('slot_holds').where('reply_id', '==', key).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
  return snap.size;
}

module.exports = { planOffer, holdOffer, releaseHolds, labels, slotLabel, dayLabel, calendarBusy, CALENDARS };
