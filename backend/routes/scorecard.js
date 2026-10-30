// Website scorecard → Nutshell (10/30). The short public quiz at /scorecard/
// (story-group-gtm.web.app) posts here when a visitor asks for their score.
//
// The visitor never waits on Nutshell (~8s a call): the answers are saved to
// Firestore (scorecard_leads), the page gets 202, and the lead is made after.
// It lands like Annette's ad leads: Kickstart pipeline, New Diagnostic
// Opportunity, Vincent's. So the intake's Nutshell check (leadIntake.js)
// picks it up after its wait and starts the cadence. The note is shaped like
// the storygroup.io form note, so leadForm reads company, situation, SMS
// consent and attribution off it. Vincent gets a Telegram ping either way.
const express = require('express');
const nutshell = require('../services/nutshell');

const router = express.Router();

const KICKSTART_STAGESET = 5;
const NEW_OPPORTUNITY = 114; // New Diagnostic Opportunity
const VINCENT = 3;
const SOURCE = { web: 1, paid_social: 14 }; // Nutshell: Web Signup, Paid Social
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TEST_EMAIL = /@(storygroup\.io|example\.(com|net|org))$|\.(test|invalid|example)$/i;

// A public form: browser posts only, from where the page is hosted or embedded.
const ALLOWED = /^(https:\/\/story-group-gtm\.(web\.app|firebaseapp\.com)|https:\/\/([a-z0-9-]+\.)*storygroup\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
router.use((req, res, next) => {
  if (!ALLOWED.test(req.get('origin') || '')) return res.status(403).json({ error: 'Origin not allowed' });
  next();
});

// 5 sends per IP per hour.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 36e5);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 36e5) hits.delete(k);
  return list.length > 5;
}

const str = (v, n = 200) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, n);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function ping(text) {
  try { await require('../services/cadence').ping(text); } catch (e) { console.warn('[scorecard] ping failed:', e.message); }
}

/** The note, in the storygroup.io form note's "Key: value" shape (leadForm.parseNote reads it). */
function noteFor(p) {
  const lines = [
    'Scorecard submitted on the website (short visibility scorecard)',
    '',
    `Name: ${p.name}`,
    `Email: ${p.email}`,
    p.phone ? `Phone: ${p.phone}` : null,
    `Company: ${p.company}`,
    `Situation: ${p.frustration || 'not given'}`,
    `Score: ${p.score}/100 (${p.type})`,
    `Fix first: ${p.fix_first}`,
    `Submitted at: ${p.submitted_at}`,
    '',
    'Message:',
    p.pillars.map(x => `${x.name} ${x.pct}`).join(' · '),
    ...p.answers.map((a, i) => `${i + 1}. ${a.q} ${a.a}`),
    '',
    ...(p.phone ? [`SMS consent: ${p.sms_consent ? `yes, ${p.submitted_at}` : 'no'}`, p.sms_consent ? `Consent text: ${p.consent_text}` : null, ''] : []),
    'Attribution',
    ...['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].map(k => (p.utm[k] ? `${k}: ${p.utm[k]}` : null)),
    `Landing page: ${p.landing_page}`,
    p.referrer ? `Referrer: ${p.referrer}` : null,
  ];
  return lines.filter(l => l !== null).join('\n');
}

/** Contact, then the open lead it already has (by name) or a new Kickstart lead, then the note. */
async function toNutshell(p) {
  const contact = await nutshell.findOrCreateContact({ name: p.name, email: p.email, phone: p.phone });
  if (!contact) throw new Error('no contact');
  let leadId = null, existing = false;
  if (!contact.created) {
    const open = ((await nutshell.call('searchLeads', { string: p.name, limit: 10 })) || [])
      .filter(l => l.status === 0 && l.description.trim().toLowerCase() === p.name.toLowerCase());
    if (open.length === 1) { leadId = open[0].id; existing = true; }
  }
  let stage = null;
  if (!leadId) {
    const paid = /^(fb|facebook|ig|instagram|meta|linkedin|li|tiktok|youtube|yt)$/i.test(p.utm.utm_source || '') || /paid|cpc|social/i.test(p.utm.utm_medium || '');
    const made = await nutshell.newPipelineLead({
      description: p.name, contactId: contact.id, stagesetId: KICKSTART_STAGESET, milestoneId: NEW_OPPORTUNITY,
      sourceId: paid ? SOURCE.paid_social : SOURCE.web, assigneeId: VINCENT,
    });
    leadId = made.id;
    stage = made.stage;
  }
  await nutshell.call('newNote', { entity: { entityType: 'Leads', id: leadId }, note: noteFor(p) });
  return { leadId, existing, stage, contactCreated: contact.created };
}

router.post('/lead', async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(202).json({ ok: true }); // honeypot: bots fill every field
  const ip = String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
  if (limited(ip)) return res.status(429).json({ error: 'Too many tries. Try again in an hour.' });

  const p = {
    name: str(b.name, 120), email: str(b.email, 200).toLowerCase(), company: str(b.company, 200),
    phone: str(b.phone, 40).replace(/[^\d+().\s-]/g, ''), sms_consent: b.sms_consent === true, consent_text: str(b.consent_text, 400),
    frustration: str(b.frustration, 120), score: Math.max(0, Math.min(100, Number(b.score) || 0)), type: str(b.type, 60), fix_first: str(b.fix_first, 60),
    pillars: (Array.isArray(b.pillars) ? b.pillars : []).slice(0, 5).map(x => ({ name: str(x && x.name, 40), pct: Math.round(Number(x && x.pct) || 0) })),
    answers: (Array.isArray(b.answers) ? b.answers : []).slice(0, 12).map(x => ({ q: str(x && x.q, 200), a: str(x && x.a, 200) })),
    utm: Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].map(k => [k, str(b.utm && b.utm[k], 200)])),
    landing_page: str(b.landing_page, 500), referrer: str(b.referrer, 500), submitted_at: new Date().toISOString(),
  };
  if (!p.name || !EMAIL_RE.test(p.email)) return res.status(400).json({ error: 'Need a name and a valid email' });
  if (!p.phone.replace(/\D/g, '')) p.phone = '';

  let ref = null;
  try {
    ref = require('../services/db').db.collection('scorecard_leads').doc();
    await ref.set({ ...p, ip, status: 'received', at: new Date() });
  } catch (e) {
    console.warn('[scorecard] Firestore save failed:', e.message);
    ref = null;
  }
  res.status(202).json({ ok: true });

  const save = patch => ref && ref.update(patch).catch(() => {});
  const who = `<b>${esc(p.name)}</b>${p.company ? ` (${esc(p.company)})` : ''}`;
  const summary = `${esc(p.email)}${p.phone ? ` · ${esc(p.phone)}${p.sms_consent ? ' (texts OK)' : ' (no text consent)'}` : ''}\nScore ${p.score}/100, ${esc(p.type)}. Fix first: ${esc(p.fix_first)}.${p.frustration ? `\nFrustration: ${esc(p.frustration)}` : ''}${p.utm.utm_source ? `\nFrom: ${esc([p.utm.utm_source, p.utm.utm_campaign].filter(Boolean).join(' / '))}` : ''}`;

  if (TEST_EMAIL.test(p.email) || !nutshell.isConfigured()) {
    await save({ status: 'skipped', why: TEST_EMAIL.test(p.email) ? 'test email' : 'Nutshell not configured' });
    await ping(`🧪 Scorecard test from ${who}: not sent to Nutshell (${TEST_EMAIL.test(p.email) ? 'test email' : 'Nutshell not set up'}).\n${summary}`);
    return;
  }
  try {
    const r = await toNutshell(p);
    await save({ status: 'in_nutshell', nutshell_lead_id: r.leadId, existing_lead: r.existing });
    const where = r.existing ? 'added to their open Nutshell lead' : r.stage ? `new Nutshell lead in Kickstart at ${esc(r.stage)}` : 'new Nutshell lead, but not in the Kickstart pipeline (set it by hand)';
    await ping(`📋 Scorecard lead ${who}: ${where}. ${r.existing ? '' : 'The cadence picks it up in about 20 minutes.'}\n${summary}\nhttps://app.nutshell.com/lead/${r.leadId}`);
  } catch (e) {
    console.error('[scorecard] Nutshell failed:', e.message);
    await save({ status: 'nutshell_failed', error: e.message });
    await ping(`⚠️ Scorecard lead ${who} didn't reach Nutshell (${esc(e.message)}). Add it by hand.\n${summary}`);
  }
});

module.exports = router;
