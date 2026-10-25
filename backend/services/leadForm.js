// services/leadForm.js — what the storygroup.io form told Nutshell about an ad lead (10/23).
//
// The New Lead email only has name, email and phone. The Nutshell lead has
// the rest: Annette's automation writes a first note ("Strategy call request
// submitted on storygroup.io") with Company, Situation, Timeline, Organization
// size, Budget, Message, the SMS consent line and the ad attribution, and sets
// the custom fields Situation Type, Urgency, Budget Range, Expected Engagement
// Type. This reads both onto the ad_leads doc:
//   form       { company, situation, timeline, urgency, org_size, budget, ... }
//   sms_consent 'yes' | 'no' (null: no record), sms_consent_at, sms_consent_text
//   ad         { source, medium, campaign, content, term, landing_page, ... }
//
// SMS consent rule (SMS_CONSENT_RULE=on in .env): the cadence texts a lead
// only when sms_consent is 'yes' (or 'grandfathered', set by hand for leads
// from before the form asked). Off: consent is shown, nothing changes.
//
// Package fit reads the "Packages at a glance" table in tier_reference.md
// every time (TIER_REFERENCE_PATH, else the pitch-call-prep skill's copy):
// prices are never written here.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TZ = 'America/Chicago';
const CONSENT_OK = ['yes', 'grandfathered'];
const consentRuleOn = () => /^(on|true|1)$/i.test(process.env.SMS_CONSENT_RULE || '');

// ── The Nutshell note ────────────────────────────────────────────────────────

const NOTE_RE = /Strategy call request submitted/i;
const KEYS = {
  company: 'Company', situation: 'Situation', timeline: 'Timeline', org_size: 'Organization size',
  budget: 'Budget', booking_route: 'Booking route', consent_text: 'Consent text', submitted_at: 'Submitted at',
  utm_source: 'utm_source', utm_medium: 'utm_medium', utm_campaign: 'utm_campaign', utm_content: 'utm_content',
  utm_term: 'utm_term', landing_page: 'Landing page', submitted_from: 'Submitted from', referrer: 'Referrer',
};

/** The form note's text -> its fields. Blank values stay ''. */
function parseNote(text) {
  const t = String(text || '').replace(/\r/g, '');
  const line = k => ((t.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'mi')) || [])[1] || '').trim();
  const out = Object.fromEntries(Object.entries(KEYS).map(([k, label]) => [k, line(label)]));
  // Message runs over several lines, up to the SMS consent line or Attribution.
  const msg = t.match(/^Message:[ \t]*\n?([\s\S]*?)\n\s*\n(?=SMS consent:|Attribution\b)/mi);
  out.message = msg ? msg[1].trim() : line('Message');
  const c = line('SMS consent');
  out.consent = /^yes\b/i.test(c) ? 'yes' : /^no\b/i.test(c) ? 'no' : null;
  out.consent_at = ((c.match(/\d{4}-\d\d-\d\dT[\d:.]+Z?/) || [])[0]) || '';
  return out;
}

/** Everything Nutshell has from the form for one lead, or { found: false }. */
async function fromNutshell(leadId) {
  const l = await require('./nutshell').call('getLead', { leadId });
  const note = (l.notes || []).find(n => NOTE_RE.test(n.note || ''));
  const cf = l.customFields || {};
  if (!note && !cf['Situation Type'] && !cf['Budget Range']) return { found: false, lead_id: leadId };
  return { found: true, has_note: !!note, lead_id: leadId, note: note ? parseNote(note.note) : null, cf };
}

// ── The assessment note (10/25) ──────────────────────────────────────────────
// Assessment form leads ("<name> - Impossible to Ignore Assessment") come in
// with no Nutshell contact. Annette's entry puts it all in one unlabeled note:
// name, email, phone, ad source, ad id, then each question with its answer run
// straight on ("...on their own? Pretty oftenWhat is your biggest...").

const QUESTIONS = {
  found_on_own: /How often do new customers find you on their own\??/i,
  frustration: /What is your biggest frustration right now\??/i,
  role: /What best describes your role\??/i,
};

/** The assessment note's text -> { full_name, email, phone_raw, role, frustration, found_on_own }. */
function parseAssessment(text) {
  const t = String(text || '').replace(/\r/g, '');
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  const isPhone = s => /^\+?[\d\s().-]+$/.test(s) && /^1?\d{10}$/.test(s.replace(/\D/g, '')); // not the 18-digit ad id
  const first = lines[0] || '';
  const out = {
    full_name: first && !first.includes('@') && !isPhone(first) && !Object.values(QUESTIONS).some(re => re.test(first)) ? first : '',
    email: ((t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [])[0] || '').toLowerCase(),
    phone_raw: lines.find(isPhone) || '',
    role: '', frustration: '', found_on_own: '',
  };
  // Each answer runs from its question to the next question or the end of its line.
  const qs = Object.entries(QUESTIONS).map(([k, re]) => { const m = t.match(re); return m && { k, start: m.index, end: m.index + m[0].length }; })
    .filter(Boolean).sort((a, b) => a.start - b.start);
  qs.forEach((q, i) => { out[q.k] = t.slice(q.end, i + 1 < qs.length ? qs[i + 1].start : t.length).trim().split('\n')[0].trim(); });
  return out;
}

/** The first note that isn't the strategy-call form note and has an email or phone, parsed; else null. */
function assessmentFrom(notes) {
  for (const n of notes || []) {
    if (NOTE_RE.test(n.note || '')) continue;
    const a = parseAssessment(n.note);
    if (a.email || a.phone_raw) return a;
  }
  return null;
}

const blankish = v => !v || /^(unknown|n\/a|none)$/i.test(String(v).trim());

/** The ad_leads fields for what fromNutshell() found. Never blanks a value already there. */
function leadPatch(found, lead = {}) {
  if (!found || !found.found) return {};
  const n = found.note || {}, cf = found.cf || {};
  const pick = (...vs) => vs.find(v => !blankish(v)) || '';
  const form = {
    nutshell_lead_id: found.lead_id,
    company: n.company || '',
    situation: n.situation || '',
    situation_type: cf['Situation Type'] || '',
    timeline: n.timeline || '',
    urgency: cf.Urgency || '',
    org_size: n.org_size || '',
    budget: pick(n.budget, cf['Budget Range']),
    engagement_type: cf['Expected Engagement Type'] || '',
    booking_route: n.booking_route || '',
    message: String(n.message || '').slice(0, 2000),
    submitted_at: n.submitted_at || '',
    fetched_at: new Date(),
  };
  const patch = { form, nutshell_lead_id: lead.nutshell_lead_id || found.lead_id };
  if (found.has_note) {
    patch.sms_consent = n.consent; // null when the note has no consent line
    patch.sms_consent_at = n.consent_at || null;
    patch.sms_consent_text = n.consent_text || null;
    patch.ad = {
      source: n.utm_source, medium: n.utm_medium, campaign: n.utm_campaign, content: n.utm_content, term: n.utm_term,
      landing_page: n.landing_page, submitted_from: n.submitted_from, referrer: n.referrer,
    };
  }
  if (!lead.company && form.company) patch.company = form.company;
  return patch;
}

// ── Consent ──────────────────────────────────────────────────────────────────

/** Why the cadence may not text this lead, or '' when it may. `ruleOn` overrides the .env switch (dry runs). */
function textBlock(lead, ruleOn = consentRuleOn()) {
  if (!ruleOn || CONSENT_OK.includes(lead.sms_consent)) return '';
  return lead.sms_consent === 'no' ? 'no SMS consent on the form' : 'no SMS consent on record';
}
const canTextConsent = lead => !textBlock(lead);

// ── Plain words (no dashes in anything Vincent reads) ────────────────────────

const undash = s => String(s || '')
  .replace(/(\S)\s*[–—]\s*(\S)/g, '$1 to $2')
  .replace(/(\d)\s*-\s*(\d)/g, '$1 to $2');

function timelineLabel(form = {}) {
  const t = undash(form.timeline);
  // Urgency only adds something when it has a window ("Immediate: 0-24 Hours").
  const u = /\d/.test(form.urgency || '') ? undash(form.urgency).replace(/:\s*/, ', ').replace(/\bHours\b/, 'hours') : '';
  if (t && u) return `${t} (${u})`;
  return t || undash(form.urgency);
}

const fmtAt = v => {
  const d = v ? new Date(v.toDate ? v.toDate() : v) : null;
  return d && !isNaN(d) ? `${d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ })} CT` : '';
};

function consentLabel(lead) {
  if (lead.sms_consent === 'yes') return `yes${lead.sms_consent_at ? `, ${fmtAt(lead.sms_consent_at)}` : ''}`;
  if (lead.sms_consent === 'grandfathered') return 'no record, texting allowed (from before the form asked)';
  if (lead.sms_consent === 'no') return 'no';
  return 'no record';
}

// ── Package fit, from tier_reference.md ──────────────────────────────────────

function tierPath() {
  const rel = '.claude/skills/story-group-pitch-call-prep/assets/tier_reference.md';
  const tries = [process.env.TIER_REFERENCE_PATH, path.join(os.homedir(), rel), path.join('/home/worker/mac', rel)].filter(Boolean);
  return tries.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

let _tiers = null;
/** [{ name, start, price, above, once }] from the "Packages at a glance" table, or null. */
function tiers() {
  const file = tierPath();
  if (!file) return null;
  const mtime = fs.statSync(file).mtimeMs;
  if (_tiers && _tiers.file === file && _tiers.mtime === mtime) return _tiers.list;
  const md = fs.readFileSync(file, 'utf8');
  const table = (md.split(/^## Packages at a glance.*$/m)[1] || '').split(/^## /m)[0];
  const list = [];
  for (const line of table.split('\n')) {
    const m = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*([^|]+)\|/);
    const amt = m && m[2].match(/\$([\d,]+)/);
    if (!amt) continue;
    list.push({ name: m[1].trim(), start: m[2].trim(), price: Number(amt[1].replace(/,/g, '')), above: /^above/i.test(m[2].trim()), once: /one-time/i.test(m[2]) });
  }
  _tiers = { file, mtime, list };
  return list;
}

/** "Under $10K" / "$10K–$25K" / "$100K+" -> [lo, hi, hiExclusive], or null. */
function budgetRange(b) {
  const s = String(b || '');
  const amts = [...s.matchAll(/\$\s*([\d.,]+)\s*([KkMm])?/g)].map(m => Number(m[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[String(m[2] || '').toLowerCase()] || 1));
  if (!amts.length) return null;
  if (/under|less than|below/i.test(s)) return [0, amts[0], true];
  if (/\+|over|above/i.test(s)) return [amts[0], Infinity, false];
  return [amts[0], amts[1] || amts[0], false];
}

const money = n => `$${n.toLocaleString('en-US')}`;
const tierLabel = t => `${t.name} (${t.above ? `above ${money(t.price)}/mo` : `${money(t.price)}${t.once ? ' one-time' : '/mo'}`})`;

/** Packages whose Start-here price sits inside the lead's budget range: '' when unknown. */
function packageFit(budget) {
  const r = budgetRange(budget);
  if (!r) return '';
  const list = tiers();
  if (!list) return '(tier_reference.md not found on this server)';
  const [lo, hi, excl] = r;
  const fits = list.filter(t => (t.above ? hi > t.price : t.price >= lo && (excl ? t.price < hi : t.price <= hi)));
  return fits.length ? fits.map(tierLabel).join(', ') : 'none of the packages';
}

// ── What Vincent sees ────────────────────────────────────────────────────────

/** Display-ready details for the card and the Ad Leads page. */
function view(lead) {
  const f = lead.form || {};
  const ad = lead.ad || {};
  return {
    company: f.company || lead.company || '',
    situation: f.situation || '',
    timeline: timelineLabel(f),
    team: undash(f.org_size),
    budget: undash(f.budget),
    fits: packageFit(f.budget),
    consent: consentLabel(lead),
    texts_off: textBlock(lead),
    ad: [ad.content, ad.campaign].filter(Boolean).join(' · '),
    ad_term: ad.term || '',
    message: f.message || '',
    has_form: !!lead.form,
  };
}

/**
 * Lines for a Telegram card. First-touch cards (Email 1, the texts-only intro)
 * get everything; later cards only say so when texts are off for consent.
 * Urgency is plain text, never a banner (Vincent, 10/23).
 */
function cardLines(lead, step) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const v = view(lead);
  const textsOff = lead.phone && v.texts_off ? `Texts off: ${v.texts_off}. Email only.` : '';
  if (!['email1', 'text_intro'].includes(step.id)) return textsOff ? [esc(textsOff)] : [];
  if (!v.has_form) return [esc(`No form details from Nutshell${lead.nutshell_lead_id ? ` (lead ${lead.nutshell_lead_id})` : ''}.`), textsOff && esc(textsOff)].filter(Boolean);
  const flat = v.message.replace(/\s+/g, ' ').trim();
  const msg = flat.length > 280 ? `${flat.slice(0, 280)}…` : flat;
  return [
    [v.company && `Company: ${v.company}`, v.team && `Team: ${v.team}`].filter(Boolean).join(' · '),
    v.situation && `Situation: ${v.situation}`,
    v.timeline && `Timeline: ${v.timeline}`,
    `Budget: ${v.budget || 'not given'}${v.fits ? `. Fits: ${v.fits}` : ''}`,
    lead.phone ? `SMS consent: ${v.consent}${v.texts_off ? '. Email only.' : ''}` : '',
    v.ad && `Ad: ${v.ad}${v.ad_term ? ` (${v.ad_term})` : ''}`,
    msg && `Message: ${msg}`,
  ].filter(Boolean).map(esc);
}

// ── Sheet D and E (Vincent's rows, blank cells only) ─────────────────────────

/** What goes in D (role) and E (frustration) for a form lead: the form's own words. */
function sheetCells(lead) {
  const f = lead.form || {};
  return { role: f.org_size ? `Team: ${undash(f.org_size)}` : '', frustration: f.situation || '' };
}

// ── Backfill ─────────────────────────────────────────────────────────────────

/** The lead's Nutshell lead id: linked already, else via the contact's email. */
async function findLeadId(lead) {
  if (lead.nutshell_lead_id) return lead.nutshell_lead_id;
  if (!/@/.test(lead.email || '')) return null;
  const nutshell = require('./nutshell');
  const hits = await nutshell.call('searchByEmail', { emailAddressString: lead.email });
  const contacts = (hits && hits.contacts) || [];
  for (const c of contacts.slice(0, 2)) {
    const full = await nutshell.call('getContact', { contactId: c.id });
    const open = (full.leads || []).filter(l => l.status === 0 || l.status === undefined);
    if (open.length === 1) return open[0].id;
  }
  return null;
}

/**
 * Fill form / consent / ad on Vincent's leads from Nutshell, and blank D/E on
 * their sheet rows. `apply: false` says what it would do and writes nothing.
 */
async function backfill({ apply = false, only = null } = {}) {
  const cadence = require('./cadence');
  const rep = (process.env.AD_LEADS_REP || 'Vincent').toLowerCase();
  const leads = (await cadence.listLeads()).filter(l => String(l.rep || '').toLowerCase().includes(rep) && !/@storygroup\.io$/i.test(l.email) && (!only || l.email === only));
  const out = [];
  for (const l of leads) {
    const row = { lead: l.email, name: cadence.fullName(l), state: l.state, running: !!l.running };
    try {
      const id = await findLeadId(l);
      row.nutshell_lead_id = id;
      const found = id ? await fromNutshell(id) : { found: false };
      const patch = leadPatch(found, l);
      row.found = found.found ? (found.has_note ? 'form note' : 'custom fields only') : 'nothing';
      const after = { ...l, ...patch };
      row.view = view(after);
      row.texts_with_rule_on = !after.phone ? 'no phone' : textBlock(after, true) ? `off: ${textBlock(after, true)}` : 'on';
      const cells = sheetCells(after);
      row.sheet = await require('./adLeadsSheet').fillBlank({ email: l.email, phone: l.phone, role: cells.role, frustration: cells.frustration, apply });
      if (apply && Object.keys(patch).length) await cadence.saveLead(l.email, patch);
    } catch (e) { row.error = e.message; }
    out.push(row);
  }
  return { apply, rule: consentRuleOn() ? 'on' : 'off', leads: out };
}

module.exports = { parseNote, fromNutshell, parseAssessment, assessmentFrom, leadPatch, textBlock, canTextConsent, view, cardLines, sheetCells, packageFit, tiers, timelineLabel, undash, backfill, consentRuleOn };
