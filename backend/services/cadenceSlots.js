// services/cadenceSlots.js — the call times the ad lead cadence offers.
//
// Rules (outreach/AD_LEADS_CADENCE_PLAN.md sections 6 and 7, same calendar
// rules as the New Lead Auto-Draft Apps Script):
// - Busy = events on vincent@storygroup.io and vincent@wrsmedia.com. Declined
//   events are free; all-day events only block when they say OOO, out of
//   office, vacation, PTO, or holiday.
// - Today: first open 30 min at least 1 hour after the send, ending by 5pm ET.
// - Backup 1: first open 30 min, 10am to 12pm ET, next business day.
// - Backup 2: first open 30 min, 2pm to 5pm ET, the business day after backup 1.
// - Every offered time is held in slot_holds so no other lead (or LinkedIn
//   reply offer) gets it. A window that's full or held rolls to the next
//   business day. A held time is offered again only once every open slot in
//   the next 5 business days is held, oldest hold first.

const { google } = require('googleapis');
const z = require('../lib/zoned');

const ET = 'America/New_York';
const SLOT_MIN = 30;
const LOOKAHEAD_DAYS = 5;
const CALENDARS = () => (process.env.CADENCE_CALENDARS || 'vincent@storygroup.io,vincent@wrsmedia.com').split(',').map(s => s.trim()).filter(Boolean);
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
 * @param sendAt  when the message goes out
 * @param key     this lead's hold key; its own old holds don't block it
 * @returns { today, slot1, slot2 } as Dates (any can be null), and calendar notes
 */
async function planOffer({ sendAt = new Date(), key = '' } = {}) {
  const sendEt = z.parts(sendAt, ET);
  const today = { y: sendEt.y, m: sendEt.m, d: sendEt.d, dow: sendEt.dow };
  const bizDays = [];
  for (let x = z.addDays(today, 1); bizDays.length < LOOKAHEAD_DAYS + 2; x = z.addDays(x, 1)) if (z.isWeekday(x)) bizDays.push(x);
  const last = bizDays[bizDays.length - 1];

  const { busy, unreadable } = await calendarBusy(z.instant(ET, today.y, today.m, today.d), z.instant(ET, last.y, last.m, last.d, 23, 59));
  const holds = (await activeHolds().catch(e => { console.warn('[cadenceSlots] holds unreadable:', e.message); return []; }))
    .filter(h => h.key !== key);
  const now = new Date();
  const open = t => t > now && !overlaps(t, busy).length;
  const unheld = t => open(t) && !overlaps(t, holds).length;
  // All open-but-held slots: the one whose hold is oldest is the one to share.
  const oldestHeld = list => list.filter(open)
    .map(t => ({ t, age: Math.min(...overlaps(t, holds).map(h => h.created_at.getTime())) }))
    .sort((a, b) => a.age - b.age)[0];

  // Today: from 1 hour after the send (on the half hour), ending by 5pm ET.
  let todaySlot = null;
  if (z.isWeekday(today)) {
    const earliest = new Date(Math.ceil((sendAt.getTime() + 60 * 6e4) / (SLOT_MIN * 6e4)) * SLOT_MIN * 6e4);
    todaySlot = candidates(today, 9, 17, earliest).find(unheld) || null;
  }

  const taken = [];
  const pick = (days, fromH, toH) => {
    for (const day of days) {
      const t = candidates(day, fromH, toH).find(c => unheld(c) && !overlaps(c, taken).length);
      if (t) return { t, day };
    }
    const all = days.flatMap(day => candidates(day, fromH, toH).map(t => ({ t, day }))).filter(x => !overlaps(x.t, taken).length);
    const best = oldestHeld(all.map(x => x.t));
    return best ? all.find(x => x.t === best.t) : null;
  };
  const window5 = bizDays.slice(0, LOOKAHEAD_DAYS);
  const b1 = pick(window5, 10, 12);
  if (b1) taken.push({ start: b1.t, end: new Date(b1.t.getTime() + SLOT_MIN * 6e4) });
  const after = b1 ? bizDays.filter(d => z.dayKey(d) > z.dayKey(b1.day)) : window5.slice(1);
  const b2 = pick(after.slice(0, LOOKAHEAD_DAYS), 14, 17);

  return { today: todaySlot, slot1: b1 ? b1.t : null, slot2: b2 ? b2.t : null, unreadable, planned_at: now };
}

/** Same calendar week (Mon to Sun) as `ref`, in ET. */
function sameWeek(t, ref) {
  const monday = d => { const p = z.parts(d, ET); return z.dayKey(z.addDays(p, -((p.dow + 6) % 7))); };
  return monday(t) === monday(ref);
}

/** "Friday at 10:00am" this week, "Monday 10/26 at 10:00am" after. */
function slotLabel(t, ref = new Date()) {
  if (!t) return null;
  const p = z.parts(t, ET);
  return sameWeek(t, ref) ? `${z.DOW[p.dow]} at ${z.clock(t, ET)}` : `${z.DOW[p.dow]} ${p.m}/${p.d} at ${z.clock(t, ET)}`;
}

/** Labels for the copy: { today_slot, slot_1, slot_2 } (strings or null). */
function labels(offer, ref = new Date()) {
  const asDate = v => (v ? toDate(v) : null);
  const t = asDate(offer && offer.today);
  return {
    today_slot: t ? z.clock(t, ET) : null,
    slot_1: slotLabel(asDate(offer && offer.slot1), ref),
    slot_2: slotLabel(asDate(offer && offer.slot2), ref),
  };
}

/** Keep these times for this lead (replaces its older holds). */
async function holdOffer(offer, { key, name = '' }) {
  await releaseHolds(key);
  const { db } = require('./db');
  const times = [offer.today, offer.slot1, offer.slot2].filter(Boolean).map(toDate);
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

module.exports = { planOffer, holdOffer, releaseHolds, labels, slotLabel, calendarBusy, CALENDARS };
