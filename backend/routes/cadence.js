// routes/cadence.js — the ad lead cadence: dashboard API (Ad Leads page) and
// the approval page behind each Telegram card. See services/cadence.js.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const cadence = require('../services/cadence');
const sheet = require('../services/adLeadsSheet');

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(400).json({ error: e.message }); }
};

router.get('/status', wrap(() => cadence.status()));
router.get('/leads', wrap(async () => {
  const leadForm = require('../services/leadForm');
  const leads = (await cadence.listLeads()).map(l => ({ ...l, form_view: leadForm.view(l) }));
  return { mode: cadence.MODE(), sms_consent_rule: leadForm.consentRuleOn() ? 'on' : 'off', leads: leads.sort((a, b) => (a.sheet_row || 999) - (b.sheet_row || 999)) };
}));
// Nutshell form details (budget, consent, ad) onto Vincent's leads. GET says what it would do; POST writes.
router.get('/form/backfill', wrap(req => require('../services/leadForm').backfill({ apply: false, only: req.query.lead || null })));
router.post('/form/backfill', wrap(req => require('../services/leadForm').backfill({ apply: true, only: (req.body && req.body.lead) || null })));
// The extra lines a lead's Email 1 card would carry.
router.get('/form/card/:email', wrap(async req => {
  const lead = await cadence.getLead(req.params.email.toLowerCase());
  if (!lead) throw new Error('Lead not found');
  return { lines: require('../services/leadForm').cardLines(lead, { id: 'email1' }), view: require('../services/leadForm').view(lead) };
}));

// Import from the sheet, or from rows the page sends (pasted CSV fallback).
router.post('/import', wrap(async req => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : (await sheet.readLeads()).leads;
  return cadence.importLeads(rows);
}));

router.post('/leads/:email/start', wrap(req => cadence.startLead(req.params.email)));
router.post('/leads/:email/outcome', wrap(req => cadence.setOutcome(req.params.email, req.body.outcome, { meeting_at: req.body.meeting_at })));
router.post('/leads/:email/verify', wrap(async req => { await cadence.verifyLeadEmail(req.params.email.toLowerCase()); return cadence.getLead(req.params.email); }));
router.post('/leads/:email/email-decision', wrap(req => cadence.setEmailDecision(req.params.email.toLowerCase(), req.body.decision === 'send' ? 'send' : 'no')));
router.post('/leads/:email/noshow', wrap(req => cadence.markNoShow(req.params.email.toLowerCase())));
router.post('/leads/:email/update', wrap(req => cadence.updateLead(req.params.email.toLowerCase(), req.body || {})));
router.get('/leads/:email/preview', wrap(req => cadence.dryRun(req.params.email, { at: req.query.at, track: req.query.track })));

router.get('/copy', wrap(() => cadence.listCopy()));
router.post('/copy/:step', wrap(async req => { await cadence.saveCopy(req.params.step, req.body || {}); return cadence.listCopy(); }));

router.post('/run', wrap(() => cadence.tick()));
router.get('/intake/dry-run', wrap(req => require('../services/leadIntake').dryRun({ last: Number(req.query.last) || 8 })));

// Dashboard "Approve all pending": the full list, then the exact ids shown.
router.get('/pending', wrap(() => cadence.pendingCards().then(cs => cs.map(({ token, tg_text, ...a }) => ({ ...a, times: cadence.cardTimes(a) })))));
// (A form post with the Telegram link's token falls through to the page handler below.)
router.post('/approve-all', (req, res, next) => (req.body && req.body.t ? next()
  : wrap(r => cadence.approveMany(Array.isArray(r.body.ids) ? r.body.ids : []))(req, res)));
router.post('/sync-sheet', wrap(() => cadence.syncSheet({ all: true })));
// Vincent's open times: free and not yet offered, plus what's promised to whom.
router.get('/open-times', wrap(req => require('../services/cadenceSlots').openTimes({ days: Math.min(Math.max(Number(req.query.days) || 5, 1), 10) })));

// Auto-booking (services/autoBook.js): is the Apps Script reachable, and a
// dry run of the reply match for one lead (books nothing).
router.get('/autobook/status', wrap(() => require('../services/autoBook').check()));
router.post('/autobook/match', wrap(async req => {
  const ab = require('../services/autoBook');
  const lead = await cadence.getLead(String(req.body.email || '').toLowerCase());
  if (!lead) throw new Error('Lead not found');
  const options = await ab.offeredTimes(lead);
  const m = await ab.matchReply(req.body.text, options);
  return { mode: ab.MODE(), offered: options.map(o => `${ab.fullLabel(o.at)} ET (${o.step})`), pick: m ? `${ab.fullLabel(m.at)} ET` : null, why: m ? m.why : null };
}));

// ── Approval page (link on the Telegram card) ───────────────────────────────

async function loadApproval(req) {
  const doc = await cadence.approvalsCol().doc(req.params.id).get();
  if (!doc.exists) return null;
  const a = doc.data();
  const t = String(req.query.t || (req.body && req.body.t) || '');
  if (!a.token || t.length !== a.token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(a.token))) return null;
  return a;
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ad lead send</title><style>
body{font:16px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#0f1424;color:#e8eaf0}
.card{max-width:640px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}.muted{color:#9aa3b8;font-size:14px}
textarea,input{width:100%;box-sizing:border-box;background:#1a2138;color:#e8eaf0;border:1px solid #2c3656;border-radius:10px;padding:10px;font:inherit}
textarea{min-height:260px}button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 16px;margin:12px 8px 0 0;cursor:pointer}
.send{background:#ff2257;color:#fff}.skip{background:#2c3656;color:#e8eaf0}.stop{background:transparent;color:#ff8a8a;border:1px solid #5a2a3a}
.box{background:#1a2138;border-radius:10px;padding:12px;margin:12px 0;white-space:pre-wrap}
</style></head><body><div class="card">${body}</div></body></html>`;
}

router.get('/approval/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const a = await loadApproval(req).catch(() => null);
  if (!a) return res.status(404).send(page('<h1>Link not valid</h1>'));
  const done = a.status !== 'pending';
  res.send(page(`
<h1>${esc(a.step_label)} to ${esc(a.name)}</h1>
<div class="muted">${a.channel === 'email' ? 'Email' : 'Text'} to ${esc(a.to)} · status: <b>${esc(a.status)}</b>${a.last_error ? ` · last error: ${esc(a.last_error)}` : ''}</div>
${done ? `<div class="box">${esc(a.subject ? `Subject: ${a.subject}\n\n` : '')}${esc(a.text)}</div>` : `
<form method="post">
<input type="hidden" name="t" value="${esc(req.query.t)}">
${a.channel === 'email' ? `<p class="muted">Subject</p><input name="subject" value="${esc(a.subject)}">` : ''}
<p class="muted">Message (edit if you want; this exact text goes out)</p>
<textarea name="text">${esc(a.text)}</textarea>
<button class="send" name="action" value="send">Send</button>
<button class="skip" name="action" value="skip">Skip this step</button>
<button class="stop" name="action" value="stop">Stop this lead</button>
</form>`}`));
});

router.post('/approval/:id', express.urlencoded({ extended: false }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const a = await loadApproval(req).catch(() => null);
  if (!a) return res.status(404).send(page('<h1>Link not valid</h1>'));
  try {
    let msg;
    if (req.body.action === 'send') {
      const r = await cadence.approve(req.params.id, { text: req.body.text, subject: req.body.subject });
      msg = r.status === 'sent' ? 'Sent.' : r.status === 'failed' ? `Not sent: ${r.error}` : `Approved. ${r.status.replace(/^waiting: /, 'Waiting: ')}`;
    } else if (req.body.action === 'skip') {
      await cadence.skip(req.params.id); msg = 'Skipped. The next step is scheduled.';
    } else if (req.body.action === 'stop') {
      await cadence.skip(req.params.id, { stopLead: true }); msg = 'Lead stopped. Nothing more goes out.';
    } else msg = 'Nothing done.';
    res.send(page(`<h1>${esc(msg)}</h1><p class="muted">${esc(a.step_label)} to ${esc(a.name)}</p>`));
  } catch (e) {
    res.status(400).send(page(`<h1>${esc(e.message)}</h1>`));
  }
});

// ── Approve-all page (button on the Telegram summary) ───────────────────────

router.get('/approve-all', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!(await cadence.checkBatchToken(String(req.query.t || '')).catch(() => false))) return res.status(404).send(page('<h1>Link not valid</h1>'));
  const cards = await cadence.pendingCards();
  if (!cards.length) return res.send(page('<h1>Nothing waiting</h1>'));
  res.send(page(`
<h1>${cards.length} messages waiting</h1>
<div class="muted">Each goes out in this order. First emails go 8 to 13 minutes apart, inside each lead's send window.</div>
${cards.map((a, i) => `
<p style="margin:18px 0 4px"><b>${i + 1}. ${esc(a.step_label)} to ${esc(a.name)}</b><br><span class="muted">${a.channel === 'email' ? 'Email' : 'Text'} to ${esc(a.to)}${cadence.cardTimes(a) ? ` · held: ${esc(cadence.cardTimes(a))} ET` : ''}</span></p>
<div class="box">${esc(a.subject ? `Subject: ${a.subject}\n\n` : '')}${esc(a.text)}</div>`).join('')}
<form method="post">
<input type="hidden" name="t" value="${esc(req.query.t)}">
<input type="hidden" name="ids" value="${esc(cards.map(a => a.id).join(','))}">
<button class="send" name="action" value="send">Send all ${cards.length}</button>
</form>
<p class="muted">To change or skip one, use its own card in Telegram instead.</p>`));
});

router.post('/approve-all', express.urlencoded({ extended: false }), async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!(await cadence.checkBatchToken(String(req.body.t)).catch(() => false))) return res.status(404).send(page('<h1>Link not valid</h1>'));
  try {
    const r = await cadence.approveMany(String(req.body.ids || '').split(',').filter(Boolean));
    res.send(page(`<h1>Approved ${r.approved}.</h1><p class="muted">${r.sent} sent so far; the rest go out on their gaps and windows. Each card in Telegram updates as it sends.</p>`));
  } catch (e) {
    res.status(400).send(page(`<h1>${esc(e.message)}</h1>`));
  }
});

// ── Held email: Vincent's answer from Telegram (Send anyway / No emails) ─────

async function decisionLead(req) {
  const lead = await cadence.getLead(req.params.email).catch(() => null);
  const t = String(req.query.t || (req.body && req.body.t) || '');
  if (!lead || !lead.decision_token || t.length !== lead.decision_token.length
    || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(lead.decision_token))) return null;
  return lead;
}

router.get('/email-decision/:email', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const lead = await decisionLead(req);
  if (!lead) return res.status(404).send(page('<h1>Link not valid</h1>'));
  const d = req.query.d === 'send' ? 'send' : 'no';
  const c = lead.email_check || {};
  res.send(page(`
<h1>${d === 'send' ? 'Send emails anyway' : 'No emails'} to ${esc([lead.first_name, lead.last_name].filter(Boolean).join(' '))}?</h1>
<div class="muted">${esc(lead.email)} · Clearout: ${esc(c.status || 'not checked')}${c.desc ? ` (${esc(c.desc)})` : ''}</div>
<p class="muted">${d === 'send' ? 'Their email steps go out on schedule, each still waiting for your OK on its own card.' : 'No email ever goes to this address. Texts keep going.'}</p>
<form method="post"><input type="hidden" name="t" value="${esc(req.query.t)}"><input type="hidden" name="d" value="${d}">
<button class="send">${d === 'send' ? 'Yes, send emails' : 'Yes, no emails'}</button></form>`));
});

router.post('/email-decision/:email', express.urlencoded({ extended: false }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const lead = await decisionLead(req);
  if (!lead) return res.status(404).send(page('<h1>Link not valid</h1>'));
  try {
    await cadence.setEmailDecision(lead.email, req.body.d === 'send' ? 'send' : 'no');
    res.send(page(`<h1>${req.body.d === 'send' ? 'Emails back on.' : 'No emails to this address.'}</h1>`));
  } catch (e) {
    res.status(400).send(page(`<h1>${esc(e.message)}</h1>`));
  }
});

// ── Book button (reply card, when a lead picked an offered time) ────────────

router.get('/book/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ab = require('../services/autoBook');
  const b = await ab.loadBooking(req.params.id, req.query.t).catch(() => null);
  if (!b) return res.status(404).send(page('<h1>Link not valid</h1>'));
  if (b.status !== 'pending') return res.send(page(`<h1>Already ${esc(b.status)}</h1><p class="muted">${esc(b.name)}, ${esc(ab.fullLabel(b.at))} ET</p>`));
  res.send(page(`
<h1>Book ${esc(b.name)}?</h1>
<div class="muted">${esc(ab.fullLabel(b.at))} ET, 30 minutes${b.why ? ` · read as: ${esc(b.why)}` : ''}</div>
<p class="muted">Checks your calendar once more, then puts the call on it and sends them the invite with a Meet link. The confirm text and reminders follow.</p>
<form method="post"><input type="hidden" name="t" value="${esc(req.query.t)}"><button class="send">Book it</button></form>`));
});

router.post('/book/:id', express.urlencoded({ extended: false }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const r = await require('../services/autoBook').confirmBooking(req.params.id, req.body.t);
    const msg = r.status === 'booked' ? `Booked ${r.label} ET.`
      : r.status === 'taken' ? `Not booked: ${r.label} isn't free anymore.${r.next ? ` Next open: ${r.next} ET.` : ''}`
      : r.status === 'too_soon' ? 'Not booked: that time is too close now.'
      : r.status === 'error' ? `Not booked: ${r.error}` : `Already ${r.status}.`;
    const sub = r.status === 'booked' ? (r.invited ? `Invite with a Meet link sent to ${r.invited}. Confirm text and reminders are queued.` : 'No working email, so it\'s on your calendar as a phone call.') : '';
    res.send(page(`<h1>${esc(msg)}</h1><p class="muted">${esc(sub)}</p>`));
  } catch (e) {
    res.status(400).send(page(`<h1>${esc(e.message)}</h1>`));
  }
});

// ── Who takes a new lead (buttons on the unassigned card; one tap, no confirm) ─

router.get('/claim/:email', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const r = await require('../services/leadClaim').tap(req.params.email.toLowerCase(), req.query.t, req.query.who === 'me' ? 'me' : 'other');
    if (!r.ok) return res.status(404).send(page(`<h1>${esc(r.msg)}</h1>`));
    res.send(page(`<h1>${esc(r.msg)}</h1><p class="muted">${esc(r.sub)}</p>`));
  } catch (e) {
    res.status(400).send(page(`<h1>${esc(e.message)}</h1>`));
  }
});

module.exports = router;
