// services/cadence.js — the ad lead cadence (email + RingCentral text).
//
// Spec: story-group-gtm-engine/outreach/AD_LEADS_CADENCE_PLAN.md (10/22/2026).
// Vincent tags a lead on the dashboard's Ad Leads page; from then on the steps
// in lib/cadenceCopy.js go out in the lead's send window (weekdays 9:30am to
// 6pm in their time zone, from the area code). Any reply by email or text
// pauses the lead and pings Vincent; a STOP text ends it for good. Vincent
// then sets an outcome (Hit once, Talked yes, Meeting yes, Not interested),
// which picks the next track.
//
// CADENCE_MODE (.env):
//   approval (default) every send becomes a Telegram card (Reply Bot); it goes
//                      out only when Vincent taps Send on the card's page.
//   live               sends go out on their own.
//   off                nothing runs.
//
// Firestore: ad_leads/{email} holds each lead's state and timeline;
// cadence_approvals holds the cards; slot_holds keeps offered times unique
// (services/cadenceSlots.js); cadence_copy/{step id} holds Vincent's copy
// for the steps after Email 1 and Text 1; cadence_meta holds shared state.

const crypto = require('crypto');
const { execFile } = require('child_process');
const path = require('path');
const copy = require('../lib/cadenceCopy');
const z = require('../lib/zoned');
const { tzForPhone } = require('../lib/areaCodes');
const slots = require('./cadenceSlots');

const MODE = () => String(process.env.CADENCE_MODE || 'approval').toLowerCase();
const PUBLIC_URL = () => (process.env.CADENCE_PUBLIC_URL || new URL(process.env.REPLY_PANEL_URL || 'https://gtm-api.srv1364275.hstgr.cloud/api/approve/panel').origin).replace(/\/$/, '');
const DASHBOARD_URL = () => process.env.CADENCE_DASHBOARD_URL || 'https://story-group-gtm.web.app/ad-leads';
const WINDOW = { startH: 9, startMin: 30, endH: 18 };
// First emails go a random 8 to 13 minutes apart so they don't look batched (Vincent, 10/22).
const EMAIL1_GAP_MIN = [8, 13];
const randomGapMs = () => (EMAIL1_GAP_MIN[0] + Math.random() * (EMAIL1_GAP_MIN[1] - EMAIL1_GAP_MIN[0])) * 6e4;
const RESTART_DAYS = 7;

function db() { return require('./db').db; }

// A lead is keyed by its email. Leads with a phone and no valid email (Vincent,
// 10/22) are keyed "phone:+1XXXXXXXXXX" and that key also sits in `email`, so
// anything that addresses mail must go through realEmail().
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const realEmail = l => (l && EMAIL_RE.test(String(l.email || '')) ? l.email : null);
const emailDead = l => !realEmail(l) || !!l.email_bounced || !!l.email_bad;
// Clearout said catch-all / unknown: emails wait for Vincent's OK; texts go on.
const emailHeld = l => !emailDead(l) && !!l.email_hold && l.email_override !== 'send';
const canEmail = l => !emailDead(l) && !emailHeld(l);
const canText = l => !!l.phone && !l.email_only && !l.sms_failed && l.state !== 'opted_out';
const leadsCol = () => db().collection('ad_leads');
const approvalsCol = () => db().collection('cadence_approvals');
const metaDoc = id => db().collection('cadence_meta').doc(id);
const toDate = v => (v ? (v.toDate ? v.toDate() : new Date(v)) : null);
const holdKey = email => `cadence:${email}`;
const fullName = l => [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Time ─────────────────────────────────────────────────────────────────────

function inWindow(t, tz) {
  const p = z.parts(t, tz);
  if (p.dow === 0 || p.dow === 6) return false;
  const mins = p.h * 60 + p.min;
  return mins >= WINDOW.startH * 60 + WINDOW.startMin && mins < WINDOW.endH * 60;
}

/** `t` if it's inside the lead's window, else the next time the window opens. */
function intoWindow(t, tz) {
  if (inWindow(t, tz)) return t;
  let p = z.parts(t, tz);
  let day = { y: p.y, m: p.m, d: p.d, dow: p.dow };
  const mins = p.h * 60 + p.min;
  if (!z.isWeekday(day) || mins >= WINDOW.endH * 60) day = z.addDays(day, 1);
  day = z.weekdayOnOrAfter(day);
  return z.instant(tz, day.y, day.m, day.d, WINDOW.startH, WINDOW.startMin);
}

const shortDate = (t, tz) => { const p = z.parts(t, tz); return `${p.m}/${p.d}`; };

// ── Leads ────────────────────────────────────────────────────────────────────

async function getLead(email) {
  const doc = await leadsCol().doc(String(email).toLowerCase()).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function listLeads() {
  const snap = await leadsCol().get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// update(), not set(merge): dotted keys like "steps_done.email1" must be paths.
async function saveLead(email, data) {
  await leadsCol().doc(email).update({ ...data, updated_at: new Date() });
}

function timelineEntry(kind, extra = {}) {
  return { at: new Date(), kind, ...extra };
}

async function addTimeline(email, entry) {
  const { FieldValue } = require('firebase-admin').firestore;
  await leadsCol().doc(email).update({ timeline: FieldValue.arrayUnion(entry), updated_at: new Date() });
}

/**
 * Upsert sheet rows into ad_leads. Never touches a lead's cadence state.
 * Phones that can't take a text (none, fake 555 numbers) make the lead email only.
 */
async function importLeads(rows) {
  const { toE164 } = require('./ringcentral');
  const out = { added: 0, updated: 0, skipped: [] };
  for (const r of rows) {
    const given = String(r.email || '').trim().toLowerCase();
    if (r.rep && !String(r.rep).toLowerCase().includes((process.env.AD_LEADS_REP || 'Vincent').toLowerCase())) { out.skipped.push({ email: given, reason: `assigned to ${r.rep}` }); continue; }
    const phone = toE164(r.phone);
    const hasEmail = EMAIL_RE.test(given);
    if (!hasEmail && !phone) {
      // Neither channel: not imported, never tagged; Vincent hears once per row.
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || `row ${r.sheet_row || '?'}`;
      out.skipped.push({ email: given, reason: 'no valid email or textable phone' });
      const key = `nochannel_${r.sheet_row || name}`.replace(/[^\w-]/g, '_');
      const seen = await metaDoc('no_channel').get().then(d => (d.exists ? d.data() : {})).catch(() => ({}));
      if (!seen[key]) {
        await ping(`⚠️ Ad lead <b>${esc(name)}</b>${r.sheet_row ? ` (sheet row ${r.sheet_row})` : ''} has no valid email and no textable phone, so it can't go in the cadence.`);
        await metaDoc('no_channel').set({ [key]: new Date() }, { merge: true });
      }
      continue;
    }
    const email = hasEmail ? given : `phone:${phone}`;
    const existing = await getLead(email);
    const base = {
      email,
      first_name: r.first_name || '', last_name: r.last_name || '',
      phone_raw: r.phone || '', phone: phone || null,
      role: r.role || '', frustration: r.frustration || '', company: r.company || '',
      source: r.source || '', sheet_row: r.sheet_row || null, rep: r.rep || '', notes: r.notes || '',
      tz: tzForPhone(phone),
      // Sheet note says the email is someone else's (Ada / Harvey): greet "Hello," (Vincent, 10/22).
      name_doubt: /belongs to|someone else|not (his|her|their) email/i.test(r.notes || ''),
    };
    if (existing) {
      await saveLead(email, base);
      out.updated++;
    } else {
      await leadsCol().doc(email).set({
        ...base,
        state: 'imported', running: false, track: null,
        email_only: !phone, text_only: !hasEmail,
        hold_reason: '',
        steps_done: {}, timeline: [timelineEntry('note', { text: `Imported from the sheet${!phone ? ' (email only: no textable phone)' : !hasEmail ? ' (texts only: no valid email)' : ''}` })],
        seen_email_ids: [], seen_sms_ids: [],
        sheet_dirty: true,
        created_at: new Date(), updated_at: new Date(),
      });
      out.added++;
    }
    // Clearout on import (Vincent, 10/22): never a guess, never twice in 30 days.
    const now = await getLead(email);
    const c = now.email_check;
    if (realEmail(now) && !emailDead(now) && (!c || Date.now() - toDate(c.at) > RECHECK_DAYS * 864e5)) {
      try { await verifyLeadEmail(email); out.verified = (out.verified || 0) + 1; } catch (e) {
        await saveLead(email, { email_check_error: e.message });
        out.verify_failed = (out.verify_failed || 0) + 1;
      }
    }
  }
  return out;
}

/** Dashboard edits: greeting name, phone, email-only, hold reason. */
async function updateLead(email, patch) {
  const { toE164 } = require('./ringcentral');
  const allowed = {};
  if ('greet_name' in patch) allowed.greet_name = String(patch.greet_name || '').trim();
  if ('sms_name' in patch) allowed.sms_name = String(patch.sms_name || '').trim();
  if ('hold_reason' in patch) allowed.hold_reason = String(patch.hold_reason || '').trim();
  if ('email_only' in patch) allowed.email_only = !!patch.email_only;
  if ('phone' in patch) {
    allowed.phone = toE164(patch.phone);
    allowed.phone_raw = patch.phone || '';
    allowed.tz = tzForPhone(allowed.phone);
    if (!allowed.phone) allowed.email_only = true;
  }
  await saveLead(email, allowed);
  return getLead(email);
}

/** Vincent marks a no-show: the no-show text is due now. */
async function markNoShow(email) {
  const lead = await getLead(email);
  if (!lead || lead.track !== 'meeting') throw new Error('Only for a booked meeting');
  await saveLead(lead.email, { no_show_marked: true });
  await addTimeline(lead.email, timelineEntry('outcome', { outcome: 'no_show', text: 'Marked no-show' }));
  return refreshNext(lead.email);
}

/** Tag: start the intro track. */
async function startLead(email) {
  const lead = await getLead(email);
  if (!lead) throw new Error('Lead not found');
  if (/@storygroup\.io$/i.test(lead.email)) throw new Error('Story Group test lead: skipped');
  if (['opted_out'].includes(lead.state)) throw new Error('This lead texted STOP');
  if (lead.running) throw new Error('Already in a cadence');
  if (realEmail(lead) && !emailDead(lead) && !lead.email_check) {
    try { await verifyLeadEmail(lead.email); } catch (e) { await saveLead(lead.email, { email_check_error: e.message }); }
    Object.assign(lead, await getLead(lead.email));
  }
  if (!canEmail(lead) && !canText(lead) && !emailHeld(lead)) throw new Error('No working channel: no deliverable email and no textable phone');
  const last = toDate(lead.email1_sent_at);
  if (last && Date.now() - last.getTime() < RESTART_DAYS * 864e5) throw new Error(`Email 1 already went out ${shortDate(last, lead.tz)}; one first email per lead per ${RESTART_DAYS} days`);
  await saveLead(lead.email, {
    state: 'active', running: true, track: 'intro', track_started_at: new Date(), tagged_at: new Date(),
    day1: null, steps_done: {}, thread: null, offer: null, blocked_reason: null, pending_approval: null, sheet_dirty: true,
  });
  await addTimeline(lead.email, timelineEntry('outcome', { text: 'Tagged: cadence started' }));
  await logToNutshell(lead, `${today(lead.tz)} Ad lead cadence started ("Become Impossible to Ignore" form lead).`);
  return refreshNext(lead.email);
}

const OUTCOMES = {
  hit_once: { state: 'hit_once', track: 'nurture', label: 'Hit once (talked, no meeting yet)' },
  talked_yes: { state: 'talked_yes', track: 'booking', label: 'Talked yes (wants a meeting)' },
  meeting: { state: 'meeting', track: 'meeting', label: 'Meeting yes (booked)' },
  not_interested: { state: 'not_interested', track: null, label: 'Not interested' },
  stop: { state: 'stopped', track: null, label: 'Stopped by Vincent' },
};

async function setOutcome(email, outcome, { meeting_at, source = '', note = '' } = {}) {
  const base = OUTCOMES[outcome];
  if (!base) throw new Error(`Unknown outcome ${outcome}`);
  // After-contact tracks are off (Vincent, 10/22): the outcome's effects still
  // run (sheet, Nutshell, Telegram) but nothing sends; Vincent takes it by hand.
  const manual = base.track && copy.DISABLED_TRACKS.includes(base.track);
  const o = manual ? { ...base, track: null } : base;
  const lead = await getLead(email);
  if (!lead) throw new Error('Lead not found');
  if (lead.state === 'opted_out' && o.track) throw new Error('This lead texted STOP: no more automated touches');
  await cancelPending(lead.email, `Outcome set: ${o.label}`);
  const meetingAt = meeting_at ? new Date(meeting_at) : null;
  if (outcome === 'meeting' && (!meetingAt || isNaN(meetingAt))) throw new Error('Meeting yes needs the meeting date and time');
  const patch = {
    state: o.state, running: !!o.track, track: o.track, outcome, outcome_at: new Date(),
    track_started_at: new Date(), day1: o.track ? z.dayKey(z.parts(new Date(), lead.tz)) : null,
    blocked_reason: null, pending_approval: null, sheet_dirty: true, manual: !!manual,
    next_step: null, next_due_at: null, next_touch_label: manual ? 'Manual (Vincent)' : '',
    no_show_marked: false, meeting_at: meetingAt, meeting_label: meetingAt ? slots.slotLabel(meetingAt) + ' ET' : null,
  };
  // The intro steps stay in steps_done; a new track's steps are fresh.
  if (o.track) {
    const done = { ...(lead.steps_done || {}) };
    for (const s of copy.TRACKS[o.track]) delete done[s.id];
    patch.steps_done = done;
  }
  await saveLead(lead.email, patch);
  // Booked, a no, or stopped: their held times go back in the pool.
  if (['meeting', 'not_interested', 'stop'].includes(outcome)) await slots.releaseHolds(holdKey(lead.email));
  await addTimeline(lead.email, timelineEntry('outcome', { outcome, text: o.label + (meetingAt ? `, meeting ${patch.meeting_label}` : '') + (source ? ` (${source})` : '') }));
  await logToNutshell(lead, `${today(lead.tz)} Outcome: ${o.label}${meetingAt ? `, meeting ${patch.meeting_label}` : ''}.${source ? ` (${source})` : ''}${note ? `\n\n${note}` : ''}`, { outcome });
  return refreshNext(lead.email);
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** The next step and when it's due, or null when the track is finished. */
function nextStep(lead) {
  if (!lead.running || !lead.track) return null;
  const steps = copy.TRACKS[lead.track];
  const done = lead.steps_done || {};
  const tz = lead.tz || 'America/New_York';
  for (const step of steps) {
    if (done[step.id]) continue;
    if (step.channel === 'sms' && !canText(lead)) return { step, skip: lead.sms_failed ? 'texts failed' : 'email only' };
    if (step.channel === 'email' && emailHeld(lead)) continue; // held, not skipped: goes once Vincent says send
    if (step.channel === 'email' && !canEmail(lead)) return { step, skip: lead.email_bounced ? 'email bounced' : lead.email_bad ? 'email invalid' : 'no email' };
    // Text intro replaces Text 1 when there's no email to refer back to.
    if (step.onlyWithoutEmail && canEmail(lead)) return { step, skip: 'has email' };
    if (step.skipWithoutEmail && !canEmail(lead)) return { step, skip: lead.email_bounced ? 'email bounced' : lead.email_bad ? 'email invalid' : emailHeld(lead) ? 'email held' : 'no email' };
    let due;
    if (step.beforeMeetingMinutes) {
      due = new Date(toDate(lead.meeting_at).getTime() - step.beforeMeetingMinutes * 6e4);
      if (due.getTime() < Date.now() - 30 * 6e4) return { step, skip: 'meeting reminder time passed' };
      return { step, due, ignoreWindow: true };
    }
    if (step.afterMeetingMinutes) {
      if (!lead.meeting_at) return { step, skip: 'no meeting time' };
      if (lead.no_show_marked) return { step, due: new Date(), ignoreWindow: true };
      due = new Date(toDate(lead.meeting_at).getTime() + step.afterMeetingMinutes * 6e4);
      if (due.getTime() < Date.now() - 2 * 36e5) return { step, skip: 'no-show window passed' };
      return { step, due, ignoreWindow: true };
    }
    if (step.id === 'email1' || step.immediate) return { step, due: intoWindow(new Date(), tz) };
    if (step.afterMinutes) {
      const prev = step.after ? copy.stepById(step.after) : steps[steps.indexOf(step) - 1];
      const prevAt = toDate(done[prev.id] && done[prev.id].at) || new Date();
      return { step, due: intoWindow(new Date(prevAt.getTime() + step.afterMinutes * 6e4), tz) };
    }
    // Day N: N-1 calendar days after day 1, moved to a weekday, never the same
    // day as the last touch, at the time of day Email 1 went out (or 10am).
    const [y, m, d] = (lead.day1 || z.dayKey(z.parts(new Date(), tz))).split('-').map(Number);
    let day = z.weekdayOnOrAfter(z.addDays({ y, m, d }, step.day - 1));
    const lastAt = Object.values(done).map(x => toDate(x.at)).filter(Boolean).sort((a, b) => b - a)[0];
    if (lastAt) {
      const lp = z.parts(lastAt, tz);
      if (z.dayKey(day) <= z.dayKey(lp)) day = z.weekdayOnOrAfter(z.addDays(lp, 1));
    }
    const sent1 = toDate(lead.email1_sent_at || lead.first_touch_at);
    const hm = sent1 ? z.parts(sent1, tz) : { h: 10, min: 0 };
    due = intoWindow(z.instant(tz, day.y, day.m, day.d, hm.h, hm.min), tz);
    return { step, due };
  }
  return null;
}

/** Recompute next step / due / sheet labels; finish the track when nothing's left. */
async function refreshNext(email) {
  let lead = await getLead(email);
  for (let guard = 0; guard < 12; guard++) {
    const n = nextStep(lead);
    if (n && n.skip) {
      await saveLead(email, { [`steps_done.${n.step.id}`]: { status: 'skipped', reason: n.skip, at: null } });
      lead = await getLead(email);
      continue;
    }
    if (!n) {
      if (lead.running) {
        await saveLead(email, { running: false, state: lead.track === 'intro' ? 'done' : lead.state, next_step: null, next_due_at: null, next_touch_label: '', sheet_dirty: true });
        if (lead.track === 'intro') await addTimeline(email, timelineEntry('note', { text: 'Cadence finished' }));
      }
      return getLead(email);
    }
    const label = `${shortDate(n.due, lead.tz)} ${n.step.label}`;
    const same = lead.next_step === n.step.id && lead.next_touch_label === label
      && Math.abs((toDate(lead.next_due_at) || 0) - n.due) < 6e4;
    if (same) return lead;
    await saveLead(email, { next_step: n.step.id, next_due_at: n.due, next_touch_label: label, sheet_dirty: true });
    return getLead(email);
  }
  return lead;
}

// ── Copy ─────────────────────────────────────────────────────────────────────

/**
 * The copy a step sends: Vincent's saved version (Firestore) first, else the
 * approved copy in lib/cadenceCopy.js. A draft he hasn't approved returns null.
 */
async function stepCopy(step) {
  const doc = await db().collection('cadence_copy').doc(step.id).get();
  const c = doc.exists ? doc.data() : null;
  if (c && String(c.body || '').trim()) return { template: c.body, subject: c.subject || '', source: 'saved' };
  return step.approved ? { template: step.template, subject: step.subject || '', source: 'approved' } : null;
}

async function listCopy() {
  const snap = await db().collection('cadence_copy').get();
  const saved = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
  return copy.ALL_STEPS.map(s => {
    const sv = saved[s.id] && String(saved[s.id].body || '').trim() ? saved[s.id] : null;
    return {
      id: s.id, label: s.label, channel: s.channel, day: s.day || null,
      default_template: s.template, default_approved: !!s.approved,
      body: sv ? sv.body : '', subject: sv ? sv.subject || '' : '',
      status: s.disabled ? 'off (after-contact plays paused)' : sv ? 'saved by Vincent' : s.approved ? 'approved' : 'draft: blocked until approved',
    };
  });
}

/** Save (and so approve) a step's copy. Blank body = back to the copy in code. */
async function saveCopy(stepId, { body, subject }) {
  if (!copy.stepById(stepId)) throw new Error('Not a step');
  const ref = db().collection('cadence_copy').doc(stepId);
  if (!String(body || '').trim()) { await ref.delete(); return; }
  await ref.set({ body: String(body), subject: String(subject || ''), approved_at: new Date(), updated_at: new Date() });
}

let _sig = null;
/** Vincent's Gmail signature HTML, from his newest hand-sent email (cached a day). */
async function signature() {
  if (process.env.CADENCE_SIGNATURE_HTML) return process.env.CADENCE_SIGNATURE_HTML;
  if (_sig && Date.now() - _sig.at < 864e5) return _sig.html;
  const cached = await metaDoc('signature').get().then(d => (d.exists ? d.data() : null)).catch(() => null);
  if (cached && Date.now() - toDate(cached.fetched_at).getTime() < 864e5) { _sig = { html: cached.html, at: Date.now() }; return cached.html; }
  const r = await gmailInbox({ op: 'signature' }).catch(e => ({ ok: false, error: e.message }));
  const html = r.ok ? r.html : (cached && cached.html) || '';
  if (r.ok) await metaDoc('signature').set({ html, fetched_at: new Date() }).catch(() => {});
  _sig = { html, at: Date.now() };
  return html;
}

function gmailInbox(req) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [path.join(__dirname, '..', 'scripts', 'gmail_inbox.py')], { timeout: 180000, maxBuffer: 8 << 20 }, (err, stdout) => {
      let out = null;
      try { out = JSON.parse(String(stdout).trim()); } catch { /* fall through */ }
      if (out) return resolve(out);
      reject(new Error((err && err.message) || 'gmail_inbox.py gave no output'));
    });
    child.stdin.end(JSON.stringify(req));
  });
}

async function emailHtml(text) {
  const sig = await signature();
  return esc(text).replace(/\n/g, '<br>') + (sig ? `<br><br>${sig}` : '');
}

/** Times from a stored offer still worth offering: today's only if over an hour away. */
function liveTimes(offer, now = new Date()) {
  if (!offer) return {};
  const keep = (v, lead) => { const t = toDate(v); return t && t.getTime() > now.getTime() + lead * 6e4 ? t : null; };
  return slots.labels({ today: keep(offer.today, 60), day: offer.day, am: keep(offer.am, 0), pm: keep(offer.pm, 0) }, now);
}

/** "last week" if `t` is in the calendar week (Mon to Sun) before `ref`, else "on October 22". */
function whenLabel(t, ref, tz = 'America/New_York') {
  if (!t) return null;
  const monday = d => { const p = z.parts(d, tz); return z.dayKey(z.addDays(p, -((p.dow + 6) % 7))); };
  const r = z.parts(ref, tz);
  const lastMonday = z.dayKey(z.addDays(z.addDays(r, -((r.dow + 6) % 7)), -7));
  if (monday(t) === lastMonday) return 'last week';
  const p = z.parts(t, tz);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `on ${MONTHS[p.m - 1]} ${p.d}`;
}

/** "Re: <the subject Email 1 went out with>", so follow-ups stay in that thread. */
const threadReply = lead => `Re: ${(lead.thread && lead.thread.subject) || copy.SUBJECT}`;

/** Which planned times a template actually offers (only those get held). */
function offeredTimes(template, offer) {
  const out = [];
  if (/\{(times_question|times_question_text|today|noshow_times)\}/.test(template) && offer.today) out.push(offer.today);
  if (/\{(times_question|times_question_text|am|pm|noshow_times)\}/.test(template)) out.push(offer.am, offer.pm);
  else if (/\{(day|time)\}/.test(template)) out.push(offer.am || offer.pm);
  return out.filter(Boolean);
}

/**
 * Build what this step would send. Returns { subject, text, offer, times } or
 * { blocked }. A step whose copy offers times plans fresh ones and holds them
 * (unless dryRun); Text 1 reuses Email 1's.
 */
async function buildMessage(lead, step, { sendAt = new Date(), dryRun = false } = {}) {
  if (step.id === 'email1' && lead.hold_reason) return { blocked: `On hold: ${lead.hold_reason}` };
  const c = await stepCopy(step);
  if (!c) return { blocked: `${step.label} is a draft waiting for your OK (Ad Leads page > Step copy)` };
  let offer = null;
  let times = {};
  if (step.reuseOffer) {
    times = liveTimes(lead.offer, sendAt);
  } else if (copy.usesTimes(c.template)) {
    offer = await slots.planOffer({ sendAt, key: holdKey(lead.email) });
    times = slots.labels(offer, sendAt);
  }
  const m = toDate(lead.meeting_at);
  const meeting = m ? { day: slots.dayLabel(m, sendAt), time: z.clock(m, 'America/New_York') } : {};
  meeting.when = whenLabel(toDate(lead.email1_sent_at), sendAt, lead.tz);
  const text = copy.render(step, c.template, lead, times, meeting);
  if (text == null) return { blocked: `${step.label}: no open time to offer in the next 5 business days` };
  if (offer && !dryRun) await slots.holdOffer(offer, { key: holdKey(lead.email), name: fullName(lead), only: offeredTimes(c.template, offer) });
  const subject = step.channel === 'email'
    ? (c.subject ? copy.render(step, c.subject, lead, times, meeting) || c.subject : (step.id === 'email1' ? copy.SUBJECT : threadReply(lead)))
    : null;
  return { subject, text, offer, times };
}

// ── Sending ──────────────────────────────────────────────────────────────────

async function tg(method, body) {
  const { tg: send } = require('./replyApprovals');
  return send(method, body);
}
const CHAT = () => process.env.FEED_TELEGRAM_CHAT || '1027800577';

async function ping(text, extra = {}) {
  try {
    return await tg('sendMessage', { chat_id: CHAT(), text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  } catch (e) {
    console.warn('[cadence] Telegram ping failed:', e.message);
    return null;
  }
}

/** Queue one step: a Telegram card in approval mode, straight out in live mode. */
async function queueStep(lead, step, msg) {
  const token = crypto.randomBytes(18).toString('base64url');
  const ref = approvalsCol().doc();
  const a = {
    email: lead.email, name: fullName(lead), step: step.id, step_label: step.label, channel: step.channel,
    to: step.channel === 'email' ? lead.email : lead.phone,
    subject: msg.subject || null, text: msg.text,
    offer: msg.offer ? { today: msg.offer.today, day: msg.offer.day, am: msg.offer.am, pm: msg.offer.pm } : null,
    status: MODE() === 'live' && !step.alwaysApprove ? 'approved' : 'pending', token, created_at: new Date(),
  };
  await ref.set(a);
  await saveLead(lead.email, { pending_approval: ref.id, pending_approved: a.status === 'approved', sheet_dirty: true, ...(msg.offer ? { offer: a.offer } : {}) });
  await addTimeline(lead.email, timelineEntry('queued', { step: step.id, channel: step.channel, text: msg.text, subject: msg.subject || null, approval: ref.id }));
  if (a.status === 'pending') {
    const url = `${PUBLIC_URL()}/api/cadence/approval/${ref.id}?t=${token}`;
    const t = msg.times || {};
    const times = [t.today && `today ${t.today}`, t.day && `${t.day} ${[t.am, t.pm].filter(Boolean).join(' or ')}`].filter(Boolean).join(', ');
    const card = [
      `<b>Ad lead cadence: ${esc(step.label)}</b> to ${esc(fullName(lead))}`,
      `${step.channel === 'email' ? 'Email' : 'Text'} to ${esc(a.to)}${lead.company ? ` (${esc(lead.company)})` : ''}`,
      step.channel === 'email' && lead.email_check ? `Clearout: ${esc(lead.email_check.status)}${lead.email_check.desc ? ` (${esc(lead.email_check.desc)})` : ''}, ${shortDate(toDate(lead.email_check.at), lead.tz)}${lead.email_override === 'send' ? ', sending anyway per you' : ''}` : '',
      msg.note ? `⚠️ ${esc(msg.note)}` : '',
      a.subject ? `\nSubject: ${esc(a.subject)}` : '',
      `\n${esc(a.text)}`,
      times && msg.offer ? `\nHeld times: ${esc(times)} ET` : '',
      '\nNothing goes out until you tap Send.',
    ].filter(Boolean).join('\n');
    const m = await ping(card, { reply_markup: { inline_keyboard: [[{ text: 'Review and send', url }]] } });
    if (m) await ref.update({ tg_message_id: m.message_id, tg_text: card });
  }
  return { id: ref.id, ...a };
}

async function markCard(a, label) {
  if (!a.tg_message_id) return;
  await tg('editMessageText', {
    chat_id: CHAT(), message_id: a.tg_message_id, parse_mode: 'HTML', disable_web_page_preview: true,
    text: `${a.tg_text || ''}\n\n<b>${esc(label)}</b>`,
  }).catch(e => console.warn('[cadence] card update failed:', e.message));
}

async function cancelPending(email, why, { channel = null } = {}) {
  const snap = await approvalsCol().where('email', '==', email).get();
  for (const d of snap.docs) {
    const a = d.data();
    if (!['pending', 'approved'].includes(a.status)) continue;
    if (channel && a.channel !== channel) continue;
    await d.ref.update({ status: 'cancelled', cancel_reason: why, updated_at: new Date() });
    await markCard(a, `Cancelled: ${why}`);
  }
  await saveLead(email, { pending_approval: null });
}

/**
 * Replace every pending card for a step with a fresh one (new copy, new
 * times). Old cards read "Replaced, new card below"; their holds go back in
 * the pool. Sends nothing. Leads outside their window get a card next run.
 */
async function rebuildPending(stepId) {
  const snap = await approvalsCol().where('status', '==', 'pending').get();
  const out = [];
  const docs = snap.docs.filter(x => x.data().step === stepId);
  // Release every old card's holds before planning any new times, so the
  // first leads rebuilt aren't pushed out by holds about to be freed.
  for (const d of docs) {
    const a = d.data();
    await d.ref.update({ status: 'cancelled', cancel_reason: 'replaced', updated_at: new Date() });
    await markCard(a, 'Replaced, new card below');
    if (stepId === 'email1') await slots.releaseHolds(holdKey(a.email));
    await saveLead(a.email, { pending_approval: null });
  }
  for (const d of docs) {
    const a = d.data();
    const lead = await getLead(a.email);
    const step = copy.stepById(stepId);
    if (!lead.running || !inWindow(new Date(), lead.tz)) { out.push({ email: a.email, status: 'next run' }); continue; }
    const msg = await buildMessage(lead, step);
    if (msg.blocked) { out.push({ email: a.email, blocked: msg.blocked }); continue; }
    const q = await queueStep(lead, step, msg);
    out.push({ email: a.email, id: q.id, subject: q.subject, text: q.text, times: msg.times });
  }
  return out;
}

// ── Approve all ──────────────────────────────────────────────────────────────
// Vincent (10/22): "if there's a bunch of emails set up, I can just click
// send." With 2+ cards pending, one Telegram summary lists them with an
// "Approve all (N)" button. Its page shows every message in full and one Send
// all button. Approving queues them in card order; the Email 1 gaps, windows
// and stale re-plan still apply.

async function pendingCards() {
  const snap = await approvalsCol().where('status', '==', 'pending').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => toDate(a.created_at) - toDate(b.created_at));
}

const cardTimes = a => {
  const t = slots.labels(a.offer || {});
  return [t.today && `today ${t.today}`, t.day && `${t.day} ${[t.am, t.pm].filter(Boolean).join(' or ')}`].filter(Boolean).join(', ');
};

async function batchToken() {
  const ref = metaDoc('batch');
  const b = (await ref.get()).data() || {};
  if (b.token) return { ref, b };
  b.token = crypto.randomBytes(18).toString('base64url');
  await ref.set({ token: b.token }, { merge: true });
  return { ref, b };
}

async function checkBatchToken(t) {
  const { b } = await batchToken();
  return !!t && t.length === b.token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(b.token));
}

/** Keep the one Telegram summary in step with what's pending (edits only on change). */
async function refreshBatchCard() {
  const cards = await pendingCards();
  const { ref, b } = await batchToken();
  if (cards.length < 2) {
    if (b.tg_message_id) {
      await tg('deleteMessage', { chat_id: CHAT(), message_id: b.tg_message_id }).catch(() => {});
      await ref.update({ tg_message_id: null, tg_text: null });
    }
    return;
  }
  const text = [
    `<b>${cards.length} ad lead messages waiting</b>`,
    ...cards.map((a, i) => `${i + 1}. ${esc(a.name)}: ${esc(a.step_label)}${cardTimes(a) ? ` (${esc(cardTimes(a))} ET)` : ''}`),
    '\nApprove all opens every message in full before anything sends.',
  ].join('\n');
  if (b.tg_message_id && b.tg_text === text) return;
  const markup = { inline_keyboard: [[{ text: `Approve all (${cards.length})`, url: `${PUBLIC_URL()}/api/cadence/approve-all?t=${b.token}` }]] };
  if (b.tg_message_id) {
    const ok = await tg('editMessageText', { chat_id: CHAT(), message_id: b.tg_message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup }).then(() => true).catch(() => false);
    if (ok) { await ref.update({ tg_text: text }); return; }
  }
  const m = await ping(text, { reply_markup: markup });
  if (m) await ref.update({ tg_message_id: m.message_id, tg_text: text });
}

/**
 * Approve exactly these cards (the ones Vincent saw), in card order. Any that
 * were approved, skipped or cancelled meanwhile drop out.
 */
async function approveMany(ids) {
  const cards = (await pendingCards()).filter(a => ids.includes(a.id));
  const base = Date.now();
  for (const [i, a] of cards.entries()) {
    await approvalsCol().doc(a.id).update({ status: 'approved', approved_at: new Date(base + i), approved_in_batch: true });
    await saveLead(a.email, { pending_approved: true, sheet_dirty: true });
  }
  const r = await dispatchApproved();
  await refreshBatchCard().catch(e => console.warn('[cadence] batch card:', e.message));
  return { approved: cards.length, sent: Object.values((r && r.results) || {}).filter(x => x.status === 'sent').length };
}

// ── Email verification (Clearout) ────────────────────────────────────────────
// Vincent (10/22, after a bounce): no cadence email goes to an address that
// hasn't passed Clearout. Checked on import and tag; re-checked before a later
// email only when the last check is over 30 days old. Valid: send. Invalid:
// like a bounce (texts only). Catch-all / unknown: emails wait for his OK on
// Telegram, texts go on. Clearout down or out of credits: the email blocks.

const RECHECK_DAYS = 30;

/** Run Clearout for this lead and apply the result. Returns the check, or throws. */
async function verifyLeadEmail(email) {
  const lead = await getLead(email);
  if (!lead || !realEmail(lead)) return null;
  const check = await require('./clearout').verifyEmail(realEmail(lead));
  await saveLead(lead.email, { email_check: check, email_check_error: null, sheet_dirty: true });
  await addTimeline(lead.email, timelineEntry('note', { text: `Clearout: ${check.status}${check.desc ? ` (${check.desc})` : ''}` }));
  if (check.status === 'invalid') {
    await markChannelDead(lead.email, 'email', `Clearout: invalid${check.desc ? ` (${check.desc})` : ''}`, { invalid: true });
  } else if (check.status !== 'valid' && lead.email_override !== 'send') {
    if (!lead.email_hold) await askEmailDecision(await getLead(lead.email), check);
  } else if (check.status === 'valid' && lead.email_hold) {
    await saveLead(lead.email, { email_hold: false });
  }
  return check;
}

/** Catch-all / unknown: hold emails and ask Vincent once. */
async function askEmailDecision(lead, check) {
  const token = lead.decision_token || crypto.randomBytes(18).toString('base64url');
  const patch = { email_hold: true, decision_token: token, sheet_dirty: true };
  // No email for now: the text intro (no "just sent you an email") can go first.
  const done = lead.steps_done || {};
  if (!(done.text1 && done.text1.status === 'sent') && done.text_intro && done.text_intro.status === 'skipped') {
    patch['steps_done.text_intro'] = require('firebase-admin').firestore.FieldValue.delete();
  }
  await saveLead(lead.email, patch);
  await cancelPending(lead.email, 'email held: Clearout not sure', { channel: 'email' });
  const url = d => `${PUBLIC_URL()}/api/cadence/email-decision/${encodeURIComponent(lead.email)}?t=${token}&d=${d}`;
  await ping(`❓ <b>${esc(fullName(lead))}</b> (${esc(lead.email)}): Clearout says <b>${esc(check.status)}</b>${check.desc ? ` (${esc(check.desc)})` : ''}. Emails are on hold; texts keep going. Send emails anyway?`,
    { reply_markup: { inline_keyboard: [[{ text: 'Send anyway', url: url('send') }, { text: 'No emails', url: url('no') }]] } });
}

/** Vincent's answer on a held email: 'send' or 'no'. */
async function setEmailDecision(email, decision) {
  const lead = await getLead(email);
  if (!lead) throw new Error('Lead not found');
  if (decision === 'send') {
    await saveLead(lead.email, { email_override: 'send', email_hold: false, sheet_dirty: true });
    await addTimeline(lead.email, timelineEntry('note', { text: 'Vincent: send emails anyway' }));
    return lead.running ? refreshNext(lead.email) : getLead(lead.email);
  }
  await markChannelDead(lead.email, 'email', 'Vincent: no emails to this address', { invalid: true });
  return getLead(lead.email);
}

/**
 * Before any email is queued or sent. Returns { ok } or { stop } (channel dead
 * or held: don't send) or { block: reason } (couldn't verify: try again later).
 */
async function emailGate(email) {
  let lead = await getLead(email);
  if (emailDead(lead)) return { stop: 'email dead' };
  const c = lead.email_check;
  const age = c && c.at ? Date.now() - toDate(c.at) : Infinity;
  if (!c || age > RECHECK_DAYS * 864e5) {
    try {
      await verifyLeadEmail(lead.email);
    } catch (e) {
      await saveLead(lead.email, { email_check_error: e.message });
      return { block: `Email not verified (${e.credits ? 'Clearout is out of credits' : e.message}), so it won't send` };
    }
    lead = await getLead(email);
  }
  if (emailDead(lead)) return { stop: 'email invalid' };
  if (emailHeld(lead)) return { stop: 'email held' };
  if (!lead.email_check || (lead.email_check.status !== 'valid' && lead.email_override !== 'send')) return { stop: 'email not valid' };
  return { ok: true };
}

/**
 * A channel stopped working for this lead (Vincent, 10/22): an email bounced,
 * or a text was undeliverable. That channel is done for good; the other keeps
 * its schedule. With no channel left, the cadence ends.
 */
async function markChannelDead(email, channel, reason, { invalid = false } = {}) {
  const lead = await getLead(email);
  if (!lead) return;
  const isEmail = channel === 'email';
  if (isEmail ? (lead.email_bounced || lead.email_bad) : lead.sms_failed) return;
  const { FieldValue } = require('firebase-admin').firestore;
  const patch = isEmail
    ? invalid
      ? { email_bad: true, email_bad_reason: String(reason).slice(0, 500), email_bad_at: new Date(), email_hold: false, sheet_dirty: true }
      : { email_bounced: true, email_bounce_reason: String(reason).slice(0, 500), email_bounced_at: new Date(), sheet_dirty: true }
    : { sms_failed: true, sms_fail_reason: String(reason).slice(0, 500), sms_failed_at: new Date(), sheet_dirty: true };
  // Email gone before Text 1: the text intro (no "just sent you an email") takes its place.
  const done = lead.steps_done || {};
  if (isEmail && !(done.text1 && done.text1.status === 'sent') && done.text_intro && done.text_intro.status === 'skipped') {
    patch['steps_done.text_intro'] = FieldValue.delete();
  }
  await saveLead(lead.email, patch);
  const what = isEmail ? (invalid ? 'Email invalid' : 'Email bounced') : 'Text undeliverable';
  await cancelPending(lead.email, isEmail ? (invalid ? 'email invalid' : 'email bounced') : 'texts failed', { channel });
  await addTimeline(lead.email, timelineEntry('note', { text: `${what}: ${String(reason).slice(0, 300)}` }));
  const fresh = await getLead(lead.email);
  const left = canEmail(fresh) || canText(fresh) || emailHeld(fresh);
  const line = isEmail ? `${what}, texts only` : 'Texts failed, email only';
  await logToNutshell(fresh, `${today(fresh.tz)} ${what}. ${left ? line : 'No working channel left; cadence ended'}.\n\n${String(reason).slice(0, 500)}`);
  if (!left) {
    await saveLead(lead.email, { running: false, state: 'dead', next_step: null, next_due_at: null, next_touch_label: '', sheet_dirty: true });
    await slots.releaseHolds(holdKey(lead.email));
    await ping(`❌ <b>${esc(fullName(fresh))}</b>: ${what.toLowerCase()} and there's no other way to reach them. Cadence ended.\n${esc(String(reason).slice(0, 300))}`);
  } else {
    await ping(`⚠️ <b>${esc(fullName(fresh))}</b>: ${what.toLowerCase()}. ${line}.\n${esc(String(reason).slice(0, 300))}`);
    if (fresh.running) await refreshNext(lead.email);
  }
}

/** Approve (with optional edits) from the card's page. Sends now if it can. */
async function approve(id, { text, subject } = {}) {
  const ref = approvalsCol().doc(id);
  const a = (await ref.get()).data();
  if (!a || a.status !== 'pending') throw new Error(`This card is ${a ? a.status : 'gone'}`);
  const patch = { status: 'approved', approved_at: new Date() };
  await saveLead(a.email, { pending_approved: true, sheet_dirty: true });
  if (text && text.trim() && text.trim() !== a.text) { patch.text = text.trim(); patch.edited = true; }
  if (subject && subject.trim() && a.channel === 'email') patch.subject = subject.trim();
  await ref.update(patch);
  // Through the guarded dispatcher, so two quick approvals can't both pass the
  // Email 1 gap check. If a run is going, the per-minute dispatcher sends it.
  await lockFree(20000); // a short dispatcher or intake run: wait, so the tap sends now
  const r = await dispatchApproved();
  if (r.skipped) return { status: 'waiting: goes out within a minute or two' };
  return r.results[id] || { status: 'waiting' };
}

async function skip(id, { stopLead = false } = {}) {
  const ref = approvalsCol().doc(id);
  const a = (await ref.get()).data();
  if (!a || !['pending', 'approved'].includes(a.status)) throw new Error(`This card is ${a ? a.status : 'gone'}`);
  await ref.update({ status: 'skipped', updated_at: new Date() });
  await markCard(a, stopLead ? 'Skipped, lead stopped' : 'Skipped');
  if (stopLead) return setOutcome(a.email, 'stop');
  await saveLead(a.email, { pending_approval: null, [`steps_done.${a.step}`]: { status: 'skipped', reason: 'skipped by Vincent', at: new Date() } });
  // A skipped Email 1 gives its times back.
  if (a.step === 'email1') await slots.releaseHolds(holdKey(a.email));
  await addTimeline(a.email, timelineEntry('skipped', { step: a.step, channel: a.channel }));
  return refreshNext(a.email);
}

/**
 * Send an approved card if the lead is still in play and it's their window.
 * Returns { status } (sent | waiting:... | cancelled | stale | failed).
 */
async function dispatch(id) {
  const ref = approvalsCol().doc(id);
  const a = (await ref.get()).data();
  if (!a || a.status !== 'approved') return { status: a ? a.status : 'gone' };
  const lead = await getLead(a.email);
  if (!lead || !lead.running) {
    await ref.update({ status: 'cancelled', cancel_reason: 'lead no longer in a cadence' });
    await markCard(a, 'Cancelled: lead no longer in a cadence');
    return { status: 'cancelled' };
  }
  const step = copy.stepById(a.step);
  const now = new Date();
  if (!step.beforeMeetingMinutes && !step.afterMeetingMinutes && !inWindow(now, lead.tz)) return { status: `waiting: outside ${lead.first_name}'s send window, goes out ${shortDate(intoWindow(now, lead.tz), lead.tz)} after 9:30am their time` };

  // Times that went stale while the card waited: re-plan on a fresh card.
  const off = a.offer || {};
  const stale = (off.today && toDate(off.today).getTime() < now.getTime() + 45 * 6e4)
    || [off.am, off.pm].some(t => t && toDate(t).getTime() < now.getTime() + 30 * 6e4);
  if (stale) {
    await ref.update({ status: 'stale' });
    await markCard(a, 'Times went stale: a fresh card with new times is coming');
    await saveLead(lead.email, { pending_approval: null });
    return { status: 'stale' };
  }
  if (a.step === 'email1') {
    const meta = (await metaDoc('state').get()).data() || {};
    const last = toDate(meta.last_email1_at);
    const next = toDate(meta.next_email1_after) || (last ? new Date(last.getTime() + EMAIL1_GAP_MIN[0] * 6e4) : null);
    // Spacing only when another Email 1 went out in the last 8 minutes (Vincent, 10/22):
    // a card approved later sends at once; one approved inside that 8 still waits its full random gap.
    const soon = last && Math.min(now, toDate(a.approved_at) || now) - last < EMAIL1_GAP_MIN[0] * 6e4;
    if (soon && next && now < next) return { status: `waiting: next first email goes after ${z.clock(next, 'America/Chicago')} CT (random 8 to 13 min gaps)` };
  }
  if (a.step === 'text1' && (lead.state === 'replied')) {
    await ref.update({ status: 'cancelled', cancel_reason: 'already replied' });
    return { status: 'cancelled' };
  }

  if (a.channel === 'email') {
    const g = await emailGate(lead.email);
    if (g.block) { await block(lead, g.block); return { status: `waiting: ${g.block}` }; }
    if (g.stop) {
      const cur = (await ref.get()).data();
      if (cur.status === 'approved') {
        await ref.update({ status: 'cancelled', cancel_reason: g.stop });
        await markCard(a, `Not sent: ${g.stop}`);
        await saveLead(lead.email, { pending_approval: null, pending_approved: false });
      }
      return { status: 'cancelled', error: g.stop };
    }
  }

  try {
    let sentId = null;
    if (a.channel === 'email') {
      const mailer = require('./mailer');
      const thread = lead.thread || null;
      const r = await mailer.sendAsVincent({
        to: a.to,
        subject: a.subject || threadReply(lead),
        text: a.text,
        html: await emailHtml(a.text),
        inReplyTo: thread ? thread.first_message_id : undefined,
        references: thread ? thread.references : undefined,
        headers: { 'X-Cadence': a.step },
      });
      if (!r) throw new Error('SMTP not configured');
      if (r.rejected && r.rejected.length) throw Object.assign(new Error(`Gmail refused the address: ${r.rejected.join(', ')}`), { deadChannel: 'email' });
      sentId = r.messageId;
      await saveLead(lead.email, {
        thread: thread
          ? { ...thread, references: [...(thread.references || []), r.messageId] }
          : { first_message_id: r.messageId, references: [r.messageId], subject: a.subject },
      });
    } else {
      const meta = (await metaDoc('state').get()).data() || {};
      if (meta.sms_read_ok !== true) throw new Error("Can't read inbound texts yet (RingCentral Read Messages scope), so texts stay off: a STOP would go unseen");
      const rc = require('./ringcentral');
      const r = await rc.sendSms(a.to, a.text).catch(e => { if (rc.isNumberFailure(e)) e.deadChannel = 'sms'; throw e; });
      if (!r) throw new Error('RingCentral SMS not set up (SMS scope missing)');
      if (rc.FAILED_STATUSES.includes(r.messageStatus)) throw Object.assign(new Error(`RingCentral: text ${r.messageStatus}`), { deadChannel: 'sms' });
      sentId = String(r.id);
    }
    await ref.update({ status: 'sent', sent_at: now, sent_id: sentId });
    const patch = {
      pending_approval: null, blocked_reason: null, state: lead.state === 'blocked' ? 'active' : lead.state,
      [`steps_done.${a.step}`]: { status: 'sent', at: now, approval: id, channel: a.channel, sent_id: sentId },
      last_touch_at: now, last_touch_label: `${shortDate(now, lead.tz)} ${step.label}`, sheet_dirty: true,
    };
    if (!lead.first_touch_at) patch.first_touch_at = now;
    if (step.id === 'text_intro' && !lead.day1) patch.day1 = z.dayKey(z.parts(now, lead.tz));
    if (a.step === 'email1') {
      patch.email1_sent_at = now;
      patch.email1_text = a.text; // Text 1 matches this email's wording
      patch.day1 = z.dayKey(z.parts(now, lead.tz));
      await metaDoc('state').set({ last_email1_at: now, next_email1_after: new Date(now.getTime() + randomGapMs()) }, { merge: true });
    }
    await saveLead(lead.email, patch);
    await addTimeline(lead.email, timelineEntry('sent', { step: a.step, channel: a.channel, text: a.text, subject: a.subject || null, edited: !!a.edited }));
    await logToNutshell(lead, `${shortDate(now, lead.tz)} ${step.label} sent (${a.channel === 'email' ? 'email' : 'text'})\n\n${a.subject ? `Subject: ${a.subject}\n\n` : ''}${a.text}`);
    await markCard(a, `Sent ${z.clock(now, 'America/Chicago')} CT`);
    await refreshNext(lead.email);
    return { status: 'sent' };
  } catch (e) {
    console.error('[cadence] send failed:', e.message);
    // A hard rejection (Gmail 5xx, a refused address, a number that can't take
    // texts) kills that channel for this lead instead of retrying.
    const dead = e.deadChannel || (a.channel === 'email' && e.responseCode >= 500 ? 'email' : null);
    if (dead) {
      await ref.update({ status: 'failed', last_error: e.message, last_error_at: now });
      await markCard(a, dead === 'email' ? 'Bounced: email not sent' : 'Text failed: not sent');
      await saveLead(lead.email, { pending_approval: null, pending_approved: false });
      await markChannelDead(lead.email, dead, e.message);
      return { status: 'failed', error: e.message };
    }
    await ref.update({ status: 'approved', last_error: e.message, last_error_at: now });
    await block(lead, `Send failed: ${e.message}`);
    return { status: 'failed', error: e.message };
  }
}

/** Mark a lead blocked and ping Vincent once per new reason. */
async function block(lead, reason) {
  if (lead.blocked_reason === reason) return;
  await saveLead(lead.email, { blocked_reason: reason, state: lead.state === 'active' ? 'blocked' : lead.state, sheet_dirty: true });
  await addTimeline(lead.email, timelineEntry('note', { text: `Blocked: ${reason}` }));
  await ping(`⏸ <b>${esc(fullName(lead))}</b>: ${esc(reason)}\n${DASHBOARD_URL()}`);
}

// ── Replies ──────────────────────────────────────────────────────────────────

async function onReply(lead, channel, text, at) {
  const stop = channel === 'sms' && require('./ringcentral').isStop(text);
  await cancelPending(lead.email, stop ? 'texted STOP' : `replied by ${channel}`);
  if (stop) {
    await saveLead(lead.email, { state: 'opted_out', running: false, track: null, next_step: null, next_due_at: null, next_touch_label: '', sheet_dirty: true, opted_out_at: new Date() });
    await slots.releaseHolds(holdKey(lead.email));
  } else {
    await saveLead(lead.email, { state: 'replied', running: false, next_step: null, next_due_at: null, next_touch_label: '', replied_at: toDate(at) || new Date(), sheet_dirty: true });
  }
  await addTimeline(lead.email, timelineEntry('reply', { channel, text: String(text).slice(0, 1500), reply_at: toDate(at) || null }));
  await logToNutshell(lead, `${shortDate(toDate(at) || new Date(), lead.tz)} ${stop ? 'Texted STOP (opted out of texts)' : `Replied by ${channel === 'sms' ? 'text' : 'email'}`}\n\n${String(text).slice(0, 1500)}`);
  // A clean yes to an offered time books the call (or puts a Book button on this card).
  const booking = stop ? null : await require('./autoBook').handleReply(lead, text);
  await ping([
    stop ? `🛑 <b>${esc(fullName(lead))}</b> texted STOP. Cadence ended for good.` : `💬 <b>${esc(fullName(lead))}</b> replied by ${channel === 'sms' ? 'text' : 'email'}. Cadence paused.`,
    `\n${esc(String(text).slice(0, 1200))}`,
    booking ? `\n${booking.line}` : '',
    stop || (booking && /Booked/.test(booking.line)) ? '' : `\nSet the outcome on the Ad Leads page: ${DASHBOARD_URL()}`,
  ].filter(Boolean).join('\n'), booking && booking.button ? { reply_markup: { inline_keyboard: [[booking.button]] } } : {});
}

/** Look for email and text replies from every lead that's had a touch. */
async function checkReplies() {
  const all = await listLeads();
  const touched = all.filter(l => l.running || l.state === 'replied');
  const out = { email: 0, sms: 0, sms_readable: null };

  // Email: anything from their address since the cadence started, not an auto-reply.
  const emailLeads = touched.filter(l => l.email1_sent_at && realEmail(l));
  if (emailLeads.length) {
    const since = new Date(Math.min(...emailLeads.map(l => toDate(l.email1_sent_at).getTime())));
    const r = await gmailInbox({ op: 'replies', emails: emailLeads.map(l => l.email), since: since.toISOString().slice(0, 10) })
      .catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) console.warn('[cadence] IMAP reply check failed:', r.error);
    for (const m of (r.ok ? r.messages : [])) {
      const lead = emailLeads.find(l => l.email === m.from);
      const id = (m.message_id || '').trim() || `${m.from}|${m.date}|${m.subject}`;
      if (!lead || (lead.seen_email_ids || []).includes(id)) continue;
      if (m.date && new Date(m.date) < toDate(lead.email1_sent_at)) continue;
      const { FieldValue } = require('firebase-admin').firestore;
      await leadsCol().doc(lead.email).update({ seen_email_ids: FieldValue.arrayUnion(id) });
      if (m.auto) { await addTimeline(lead.email, timelineEntry('note', { text: `Auto-reply (not counted): ${m.subject}` })); continue; }
      if (lead.running) { await onReply(lead, 'email', m.snippet || m.subject, m.date); out.email++; }
    }
  }

  // Bounces: any delivery failure naming a lead we've emailed (Vincent, 10/22).
  const mailed = all.filter(l => l.email1_sent_at && realEmail(l) && !l.email_bounced);
  if (mailed.length) {
    const since = new Date(Math.min(...mailed.map(l => toDate(l.email1_sent_at).getTime())));
    const r = await gmailInbox({
      op: 'bounces', emails: mailed.map(l => l.email), since: since.toISOString().slice(0, 10),
      message_ids: mailed.flatMap(l => (l.thread && l.thread.references) || []),
    }).catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) console.warn('[cadence] IMAP bounce check failed:', r.error);
    for (const b of (r.ok ? r.bounces : [])) {
      const lead = mailed.find(l => l.email === b.lead);
      if (!lead || (lead.seen_bounce_ids || []).includes(b.message_id)) continue;
      if (b.date && new Date(b.date) < toDate(lead.email1_sent_at)) continue;
      const { FieldValue } = require('firebase-admin').firestore;
      await leadsCol().doc(lead.email).update({ seen_bounce_ids: FieldValue.arrayUnion(b.message_id || b.date || 'bounce') });
      await markChannelDead(lead.email, 'email', `${b.subject}: ${b.snippet.slice(0, 300)}`);
      out.bounces = (out.bounces || 0) + 1;
    }
  }

  // Texts: every inbound text since the oldest running lead was tagged.
  const smsLeads = all.filter(l => l.phone && (l.running || l.state === 'replied'));
  const rc = require('./ringcentral');
  if (rc.isConfigured()) {
    const since = smsLeads.length ? new Date(Math.min(...smsLeads.map(l => toDate(l.tagged_at || l.track_started_at || new Date()).getTime()))) : new Date(Date.now() - 864e5);
    const texts = await rc.getInboundSms(since.toISOString()).catch(e => { console.warn('[cadence] inbound SMS check failed:', e.message); return null; });
    out.sms_readable = !!texts;
    await metaDoc('state').set({ sms_read_ok: !!texts, sms_checked_at: new Date() }, { merge: true });
    for (const t of texts || []) {
      const lead = smsLeads.find(l => l.phone === rc.toE164(t.from));
      if (!lead || (lead.seen_sms_ids || []).includes(t.id)) continue;
      const { FieldValue } = require('firebase-admin').firestore;
      await leadsCol().doc(lead.email).update({ seen_sms_ids: FieldValue.arrayUnion(t.id) });
      // A STOP always ends it, even after a pause.
      if (lead.running || rc.isStop(t.text)) { await onReply(lead, 'sms', t.text, t.at); out.sms++; }
    }
    // Delivery: texts sent in the last 3 days that RingCentral marks failed.
    for (const lead of all.filter(l => l.phone && !l.sms_failed)) {
      for (const [stepId, x] of Object.entries(lead.steps_done || {})) {
        if (x.channel !== 'sms' || x.status !== 'sent' || !x.sent_id || x.delivery) continue;
        if (Date.now() - toDate(x.at) > 3 * 864e5) continue;
        const m = await rc.getMessage(x.sent_id).catch(() => null);
        if (!m || !m.messageStatus) continue;
        if (rc.FAILED_STATUSES.includes(m.messageStatus)) {
          await saveLead(lead.email, { [`steps_done.${stepId}.delivery`]: m.messageStatus });
          await markChannelDead(lead.email, 'sms', `RingCentral: ${m.messageStatus}${m.smsDeliveryTime ? '' : ''}${m.errorCode ? ` (${m.errorCode})` : ''}`);
          out.sms_failed = (out.sms_failed || 0) + 1;
          break;
        }
        if (m.messageStatus === 'Delivered') await saveLead(lead.email, { [`steps_done.${stepId}.delivery`]: 'Delivered' });
      }
    }
  } else {
    await metaDoc('state').set({ sms_read_ok: false }, { merge: true });
  }
  return out;
}

// ── Nutshell ─────────────────────────────────────────────────────────────────
// Every touch that actually went out, every reply and every outcome becomes a
// note on the lead's Nutshell contact (found or created by email on tag).
// Nutshell takes ~8s a call, so sends only queue a row in nutshell_queue; the
// cron drains it afterwards and retries failures next run.
//
// The ad form leads already sit in Nutshell as leads named after the person
// (Kickstart / Diagnostic Pipeline, created by Annette, no contact attached).
// Notes go on that lead when there's exactly one open lead with the name,
// else on the contact. Outcome stages (Vincent approved 10/22): Talked yes =
// Qualified for Kickstart, Meeting yes = Kickstart Call Scheduled, only in
// that pipeline and only forward. Not interested = Lost, but the API can't
// close a lead, so Vincent gets a Telegram line to click Lost himself.

const nutshellQueue = () => db().collection('nutshell_queue');
const REP = () => (process.env.AD_LEADS_REP || 'Vincent').toLowerCase();

async function logToNutshell(lead, text, { outcome = null } = {}) {
  if (lead.rep && !String(lead.rep).toLowerCase().includes(REP())) return;
  try {
    await nutshellQueue().add({ email: lead.email, text: text || null, outcome, status: 'pending', attempts: 0, created_at: new Date() });
  } catch (e) {
    console.warn('[cadence] Nutshell queue write failed:', e.message);
  }
}

let _draining = false;
async function drainNutshell({ max = 20 } = {}) {
  const nutshell = require('./nutshell');
  if (_draining || !nutshell.isConfigured()) return { skipped: true };
  _draining = true;
  let done = 0, failed = 0;
  try {
    const snap = await nutshellQueue().where('status', '==', 'pending').get();
    const rows = snap.docs.sort((a, b) => toDate(a.data().created_at) - toDate(b.data().created_at)).slice(0, max);
    for (const d of rows) {
      const job = d.data();
      try {
        const lead = await getLead(job.email);
        if (!lead) { await d.ref.update({ status: 'dropped' }); continue; }
        let contactId = lead.nutshell_contact_id;
        if (!contactId) {
          const c = await nutshell.findOrCreateContact({ name: fullName(lead), email: realEmail(lead) });
          contactId = c.id;
          await saveLead(lead.email, { nutshell_contact_id: contactId });
          await addTimeline(lead.email, timelineEntry('note', { text: `Nutshell contact ${c.created ? 'created' : 'found'} (${contactId})` }));
        }
        let leadId = await nutshellLeadFor(await getLead(job.email));
        if (!leadId && CREATE_FOR.includes(job.outcome)) leadId = await ensureNutshellLead(lead, contactId);
        if (job.text) {
          const entity = leadId ? { entityType: 'Leads', id: leadId } : { entityType: 'Contacts', id: contactId };
          if (!job.note_done) {
            await nutshell.call('newNote', { entity, note: job.text });
            await d.ref.update({ note_done: true });
          }
        }
        if (job.outcome) {
          const line = leadId ? await applyStage(lead, leadId, job.outcome)
            : 'No single open Nutshell lead with this name: stage not set';
          if (line) {
            await addTimeline(lead.email, timelineEntry('note', { text: line }));
            if (!leadId) await ping(`Nutshell: no single open lead named <b>${esc(fullName(lead))}</b>, so the ${esc(job.outcome)} stage wasn't set. The note is on the contact.`);
          }
        }
        await d.ref.update({ status: 'done', done_at: new Date(), contact_id: contactId, lead_id: leadId || null });
        done++;
      } catch (e) {
        failed++;
        console.warn('[cadence] Nutshell log failed (retries next run):', e.message);
        await d.ref.update({ attempts: (job.attempts || 0) + 1, last_error: e.message, last_error_at: new Date() }).catch(() => {});
      }
    }
  } finally {
    _draining = false;
  }
  return { done, failed };
}

const today = tz => shortDate(new Date(), tz || 'America/Chicago');

const KICKSTART_STAGESET = 5;
const STAGE_FOR = { talked_yes: 115, meeting: 116 }; // Qualified for Kickstart, Kickstart Call Scheduled
const normName = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Open Nutshell leads named exactly after this person. */
async function openLeadsNamed(lead) {
  const hits = await require('./nutshell').call('searchLeads', { string: fullName(lead), limit: 10 });
  return (hits || []).filter(l => l.status === 0 && normName(l.description) === normName(fullName(lead)));
}

/** The one open Nutshell lead named after this person, or null. Cached on the lead. */
async function nutshellLeadFor(lead) {
  if (lead.nutshell_lead_id) return lead.nutshell_lead_id;
  if (lead.nutshell_lead_checked_at && Date.now() - toDate(lead.nutshell_lead_checked_at) < 864e5) return null;
  const mine = await openLeadsNamed(lead);
  const id = mine.length === 1 ? mine[0].id : null;
  await saveLead(lead.email, id ? { nutshell_lead_id: id } : { nutshell_lead_checked_at: new Date() });
  return id;
}

// A call outcome needs a Nutshell lead to move (Vincent, 10/22: "moving the
// lead where it needs to be"). With no open lead by that name, make one in the
// Kickstart pipeline like Annette's (Paid Social, Vincent's), contact attached.
// Two or more open leads with the name: none made, Vincent is pinged.
const CREATE_FOR = ['hit_once', 'talked_yes', 'meeting'];
async function ensureNutshellLead(lead, contactId) {
  const mine = await openLeadsNamed(lead); // fresh: Annette may have added it since the cached check
  if (mine.length > 1) return null;
  let id = mine.length ? mine[0].id : null, line = `Nutshell lead found (${id})`;
  if (!id) {
    const made = await require('./nutshell').newPipelineLead({
      description: fullName(lead), contactId, stagesetId: KICKSTART_STAGESET, milestoneId: 114, sourceId: 14, assigneeId: 3,
    });
    id = made.id;
    line = `Nutshell lead created (${id})${made.stage ? `, in Kickstart at ${made.stage}` : ': not in the Kickstart pipeline, set it by hand'}`;
    if (!made.stage) await ping(`Nutshell: made a lead for <b>${esc(fullName(lead))}</b> but couldn't put it in the Kickstart pipeline. Set it here: https://app.nutshell.com/lead/${id}`);
  }
  await saveLead(lead.email, { nutshell_lead_id: id });
  await addTimeline(lead.email, timelineEntry('note', { text: line }));
  return id;
}

/** Move the lead forward to the outcome's stage. Returns a line for the timeline. */
async function applyStage(lead, leadId, outcome) {
  const nutshell = require('./nutshell');
  if (outcome === 'not_interested') {
    await ping(`Nutshell: mark <b>${esc(fullName(lead))}</b> as Lost (Not interested). The API can't close leads: https://app.nutshell.com/lead/${leadId}`);
    return 'Asked Vincent to mark Lost in Nutshell';
  }
  const target = STAGE_FOR[outcome];
  if (!target) return null;
  const l = await nutshell.call('getLead', { leadId });
  if (!l.stageset || l.stageset.id !== KICKSTART_STAGESET) return `Nutshell stage not changed: lead is in ${l.stageset ? l.stageset.name : 'no pipeline'}`;
  const ms = await nutshell.call('findMilestones', {});
  const pos = id => (ms.find(m => m.id === id) || {}).position || 0;
  if (l.milestone && pos(l.milestone.id) >= pos(target)) return `Nutshell stage left at ${l.milestone.name} (already there or past it)`;
  // editLead takes milestoneId; a { milestone: { id } } stub makes Nutshell 500.
  await nutshell.call('editLead', { leadId, rev: l.rev, lead: { milestoneId: target } }, { attempts: 1 });
  return `Nutshell stage set to ${(ms.find(m => m.id === target) || {}).name}`;
}

/**
 * Column M "Touches So Far": what really happened, in order. Sent steps,
 * replies, calls (services/cadenceCalls.js) and outcomes; skipped, queued or unapproved steps don't count.
 */
const OUTCOME_SHORT = { hit_once: 'Hit once', talked_yes: 'Talked yes', meeting: 'Meeting yes', not_interested: 'Not interested', stop: 'Stopped', no_show: 'No-show' };
function touchesSoFar(lead) {
  const rc = require('./ringcentral');
  return [...(lead.timeline || [])]
    .sort((a, b) => toDate(a.at) - toDate(b.at))
    .map(t => {
      if (t.kind === 'sent') {
        const st = copy.stepById(t.step);
        const d = (lead.steps_done || {})[t.step] || {};
        const failed = rc.FAILED_STATUSES.includes(d.delivery);
        return (st ? st.label : t.step).replace(/ \(.*\)$/, '') + (failed ? ' (failed)' : '');
      }
      if (t.kind === 'reply') return t.channel === 'sms' && rc.isStop(t.text) ? 'Texted STOP' : `Replied (${t.channel === 'sms' ? 'text' : 'email'})`;
      if (t.kind === 'call') return 'Call';
      if (t.kind === 'outcome' && t.outcome) return OUTCOME_SHORT[t.outcome] || null;
      return null;
    })
    .filter(Boolean)
    .join(', ');
}

// ── Sheet ────────────────────────────────────────────────────────────────────

async function syncSheet({ all = false } = {}) {
  // Untagged leads keep whatever the team typed in J:M.
  const leads = (await listLeads()).filter(l => l.tagged_at && (all || l.sheet_dirty));
  if (!leads.length) return 0;
  const n = await require('./adLeadsSheet').writeBack(leads.map(l => ({
    email: realEmail(l), phone: l.phone, touches: touchesSoFar(l),
    status: l.state === 'dead' ? 'dead' : l.running && l.email_bad && realEmail(l) ? 'email_invalid' : l.running && l.email_bounced && realEmail(l) ? 'email_bounced' : l.running && l.sms_failed && l.phone ? 'sms_failed' : l.state,
    last_touch: l.last_touch_label || '',
    next_touch: l.running ? (l.pending_approval ? `${l.next_touch_label || ''} (${l.pending_approved ? 'approved, sending soon' : 'waiting on Vincent'})` : l.next_touch_label || '')
      : l.state === 'done' ? 'Done: no reply' : l.state === 'opted_out' ? 'Texted STOP' : l.manual ? 'Manual (Vincent)' : '',
  })));
  if (n !== null) await Promise.all(leads.map(l => leadsCol().doc(l.email).update({ sheet_dirty: false })));
  return n;
}

// ── The 10-minute run ────────────────────────────────────────────────────────

let _running = false;

/** Resolves once no run holds the guard, or after ms. */
async function lockFree(ms) {
  for (const end = Date.now() + ms; _running && Date.now() < end;) await new Promise(r => setTimeout(r, 500));
}

/** Send every approved card that can go now, oldest approval first. Caller holds _running. */
async function sendApproved() {
  const snap = await approvalsCol().where('status', '==', 'approved').get();
  const docs = snap.docs.sort((a, b) => (toDate(a.data().approved_at) || 0) - (toDate(b.data().approved_at) || 0));
  const results = {};
  for (const d of docs) {
    const r = await dispatch(d.id);
    results[d.id] = { ...r, email: d.data().email, step: d.data().step };
  }
  return results;
}

/**
 * The every-minute dispatcher: approved cards only, not the full tick, so the
 * random Email 1 gaps land on time. Shares the tick's guard so they never overlap.
 */
async function dispatchApproved() {
  if (MODE() === 'off') return { skipped: 'CADENCE_MODE=off' };
  if (_running) return { skipped: 'a run is going' };
  _running = true;
  try {
    const results = await sendApproved();
    // Vincent watches the sheet: write changed rows within a minute of a send.
    await syncSheet().catch(e => console.warn('[cadence] sheet sync:', e.message));
    return { results };
  } finally {
    _running = false;
    refreshBatchCard().catch(e => console.warn('[cadence] batch card:', e.message));
  }
}

/**
 * Queue (or in live mode send) this lead's next step if it's due and in its
 * window. Used by the tick for every running lead, and by the New Lead
 * intake right after tagging, so a new lead's first card doesn't wait for the tick.
 * Caller holds _running.
 */
async function queueDue(email, out = { queued: [], sent: [], blocked: [] }) {
  const lead = await getLead(email);
  if (!lead || !lead.running || lead.pending_approval) return out;
  const fresh = await refreshNext(lead.email);
  const n = nextStep(fresh);
  if (!n || n.skip || n.due > new Date()) return out;
  if (!n.ignoreWindow && !inWindow(new Date(), fresh.tz)) return out;
  if (n.step.channel === 'sms') {
    const meta = (await metaDoc('state').get()).data() || {};
    if (meta.sms_read_ok !== true) { await block(fresh, "Texts are off until RingCentral can read inbound texts (add the SMS and Read Messages scopes)"); out.blocked.push(fresh.email); return out; }
  }
  let note = null;
  if (n.step.id === 'noshow' && !fresh.no_show_marked) {
    const since = new Date(toDate(fresh.meeting_at).getTime() - 15 * 6e4).toISOString();
    const called = await require('./ringcentral').hadCallWith(fresh.phone, since).catch(e => { console.warn('[cadence] no-show call check:', e.message); return null; });
    if (called) {
      await saveLead(fresh.email, { 'steps_done.noshow': { status: 'skipped', reason: 'the call happened', at: new Date() } });
      await refreshNext(fresh.email);
      return out;
    }
    note = called === null
      ? "Couldn't check RingCentral for the call. Send only if it really was a no-show."
      : 'No RingCentral call with this number since the start. Send only if it really was a no-show (a Meet or cell call would not show).';
  }
  if (n.step.channel === 'email') {
    const g = await emailGate(fresh.email);
    if (g.block) { await block(fresh, g.block); out.blocked.push(fresh.email); return out; }
    if (g.stop) { await refreshNext(fresh.email); return out; }
  }
  const msg = await buildMessage(await getLead(fresh.email), n.step);
  if (note) msg.note = note;
  if (msg.blocked) { await block(fresh, msg.blocked); out.blocked.push(fresh.email); return out; }
  const a = await queueStep(fresh, n.step, msg);
  out.queued.push(`${fresh.email} ${n.step.id}`);
  if (a.status === 'approved') {
    const r = await dispatch(a.id);
    if (r.status === 'sent') out.sent.push(`${fresh.email} ${n.step.id}`);
  }
  return out;
}

/**
 * The every-minute New Lead intake (services/leadIntake.js): new rows, tags and
 * their first card within a minute of the email. Shares the tick's guard.
 */
async function runIntake() {
  if (MODE() === 'off') return { skipped: 'CADENCE_MODE=off' };
  // The dispatcher fires on the same minute: wait out a short run instead of skipping.
  await lockFree(40000);
  if (_running) return { skipped: 'a run is going' };
  _running = true;
  try {
    const r = await require('./leadIntake').run();
    if (r.added.length) await syncSheet().catch(e => console.warn('[cadence] sheet sync:', e.message));
    return r;
  } finally {
    _running = false;
  }
}

async function tick() {
  if (MODE() === 'off') return { skipped: 'CADENCE_MODE=off' };
  if (_running) return { skipped: 'previous run still going' };
  _running = true;
  const out = { queued: [], sent: [], waiting: [], blocked: [] };
  try {
    out.replies = await checkReplies();
    out.calls = await require('./cadenceCalls').checkCalls().catch(e => ({ error: e.message }));

    // Approved cards waiting on a window or the Email 1 gap.
    const r = await sendApproved();
    for (const [id, x] of Object.entries(r)) (x.status === 'sent' ? out.sent : out.waiting).push(`${x.email} ${x.step}: ${x.status}`);

    for (const lead of (await listLeads()).filter(l => l.running && !l.pending_approval)) {
      await queueDue(lead.email, out);
    }
    out.sheet_rows = await syncSheet();
    await require('./clearout').checkUsageAlert().catch(e => console.warn('[cadence] Clearout usage alert:', e.message));
  } finally {
    _running = false;
  }
  // Nutshell is slow: drain in the background so it never holds up a send.
  drainNutshell().then(r => { if (r.done || r.failed) console.log('[cadence] nutshell', JSON.stringify(r)); }).catch(e => console.warn('[cadence] nutshell drain:', e.message));
  return out;
}

// ── Dry run ──────────────────────────────────────────────────────────────────

/**
 * Exactly what Email 1 and Text 1 would say for this lead if it went out at
 * `at` (default: the next time their window is open). Holds nothing, sends nothing.
 */
async function dryRun(email, { at, track = 'intro' } = {}) {
  const lead = await getLead(email);
  if (!lead) throw new Error('Lead not found');
  // Walk the track as if every step went out on time. Holds nothing, sends nothing.
  // Later steps plan times against today's calendar and holds, so they're a preview.
  const sendAt = at ? new Date(at) : intoWindow(new Date(), lead.tz);
  const sim = { ...lead, hold_reason: null, running: true, track, steps_done: {}, day1: null, email1_sent_at: null, offer: null };
  const steps = [];
  let first = null;
  for (let guard = 0; guard < 12; guard++) {
    const n = nextStep(sim);
    if (!n) break;
    if (n.skip) { steps.push({ step: n.step.id, label: n.step.label, skipped: n.skip }); sim.steps_done[n.step.id] = { status: 'skipped', at: null }; continue; }
    const due = n.step.id === 'email1' ? sendAt : n.due;
    const msg = await buildMessage(sim, n.step, { sendAt: due, dryRun: true });
    if (n.step.id === 'email1') {
      sim.email1_sent_at = due; sim.day1 = z.dayKey(z.parts(due, sim.tz));
      sim.offer = msg.offer; first = msg;
    }
    steps.push({ step: n.step.id, label: n.step.label, channel: n.step.channel, send_at: due, subject: msg.subject || undefined, text: msg.text, blocked: msg.blocked, times: msg.times });
    sim.steps_done[n.step.id] = { status: 'sent', at: due };
  }
  const e1 = steps.find(x => x.step === 'email1');
  const t1 = steps.find(x => x.step === 'text1');
  return {
    lead: { name: fullName(lead), email: lead.email, phone: lead.phone, tz: lead.tz, role: lead.role, frustration: lead.frustration, hold_reason: lead.hold_reason || null },
    email1: e1 ? { send_at: e1.send_at, subject: e1.subject, text: e1.text } : null,
    text1: t1 && !t1.skipped ? { send_at: t1.send_at, text: t1.text } : { skipped: 'email only' },
    offered_times_et: first ? first.times : null,
    offered_times_iso: first && first.offer ? { today: first.offer.today, day: first.offer.day, am: first.offer.am, pm: first.offer.pm } : null,
    steps,
    mode: MODE(),
  };
}

async function status() {
  const meta = (await metaDoc('state').get().catch(() => null))?.data() || {};
  const rc = require('./ringcentral');
  const cal = await slots.calendarBusy(new Date(), new Date(Date.now() + 864e5));
  return {
    mode: MODE(),
    smtp: require('./mailer').isConfigured(),
    signature: await signature().catch(e => `error: ${e.message}`),
    sms: await rc.smsStatus().catch(e => ({ error: e.message })),
    sms_read_ok: meta.sms_read_ok === true,
    calendars: slots.CALENDARS(),
    calendars_unreadable: cal.unreadable,
    sheet: await require('./adLeadsSheet').status(),
  };
}

module.exports = {
  MODE, importLeads, updateLead, startLead, setOutcome, markNoShow, listLeads, getLead, refreshNext, nextStep,
  listCopy, saveCopy, approve, skip, dispatch, tick, checkReplies, syncSheet, dryRun, status, inWindow, intoWindow,
  approvalsCol, queueStep, drainNutshell, touchesSoFar, dispatchApproved, rebuildPending, markChannelDead, realEmail, verifyLeadEmail, setEmailDecision, emailGate, emailHeld, pendingCards, approveMany, checkBatchToken, refreshBatchCard, cardTimes, ping, fullName, esc, DASHBOARD_URL, gmailInbox, queueDue, runIntake, saveLead, canEmail,
};
