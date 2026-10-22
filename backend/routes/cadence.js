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
  const leads = await cadence.listLeads();
  return { mode: cadence.MODE(), leads: leads.sort((a, b) => (a.sheet_row || 999) - (b.sheet_row || 999)) };
}));

// Import from the sheet, or from rows the page sends (pasted CSV fallback).
router.post('/import', wrap(async req => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : (await sheet.readLeads()).leads;
  return cadence.importLeads(rows);
}));

router.post('/leads/:email/start', wrap(req => cadence.startLead(req.params.email)));
router.post('/leads/:email/outcome', wrap(req => cadence.setOutcome(req.params.email, req.body.outcome, { meeting_at: req.body.meeting_at })));
router.post('/leads/:email/noshow', wrap(req => cadence.markNoShow(req.params.email.toLowerCase())));
router.post('/leads/:email/update', wrap(req => cadence.updateLead(req.params.email.toLowerCase(), req.body || {})));
router.get('/leads/:email/preview', wrap(req => cadence.dryRun(req.params.email, { at: req.query.at, track: req.query.track })));

router.get('/copy', wrap(() => cadence.listCopy()));
router.post('/copy/:step', wrap(async req => { await cadence.saveCopy(req.params.step, req.body || {}); return cadence.listCopy(); }));

router.post('/run', wrap(() => cadence.tick()));
router.post('/sync-sheet', wrap(() => cadence.syncSheet({ all: true })));

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

module.exports = router;
