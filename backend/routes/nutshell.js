// Scorecard → Nutshell. Nutshell can take minutes across several calls, so the
// scorecard starts a job and polls it instead of holding one request open.
const express = require('express');
const crypto = require('crypto');
const nutshell = require('../services/nutshell');

const router = express.Router();
const jobs = new Map();  // id -> { status, step, result, error, at }
const JOB_TTL_MS = 60 * 60 * 1000;

// The scorecard is a public page; only accept writes from where it's hosted.
const ALLOWED = /^(https:\/\/story-group-gtm\.(web\.app|firebaseapp\.com)|http:\/\/localhost(:\d+)?)$/;
router.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !ALLOWED.test(origin)) return res.status(403).json({ error: 'Origin not allowed' });
  next();
});

router.post('/scorecard', (req, res) => {
  const b = req.body || {};
  if (!nutshell.isConfigured()) return res.status(503).json({ error: 'Nutshell is not connected on the server yet' });
  if (!b.note || !(b.name || b.email || b.company)) return res.status(400).json({ error: 'Need a name, email, or company, plus notes' });

  const id = crypto.randomUUID();
  const job = { status: 'running', step: 'Starting', at: Date.now() };
  jobs.set(id, job);
  nutshell.pushScorecard({
    name: String(b.name || '').slice(0, 120),
    email: String(b.email || '').slice(0, 200),
    title: String(b.title || '').slice(0, 120),
    company: String(b.company || '').slice(0, 200),
    website: String(b.website || '').slice(0, 200),
    source: String(b.source || ''),
    repEmail: String(b.repEmail || ''),
    packageLine: String(b.packageLine || '').slice(0, 200),
    note: String(b.note).slice(0, 20000),
    leadId: b.leadId || null,
    contactId: b.contactId || null,
    accountId: b.accountId || null,
  }, step => { job.step = step; })
    .then(result => { Object.assign(job, { status: 'done', step: 'Done', result }); })
    .catch(e => {
      console.error('[nutshell] scorecard push failed:', e.message);
      Object.assign(job, { status: 'error', error: /timeout|504|aborted/i.test(e.message) ? 'Nutshell is responding slowly or is down. Try again in a few minutes.' : e.message });
    });

  // Forget old jobs.
  for (const [k, j] of jobs) if (Date.now() - j.at > JOB_TTL_MS) jobs.delete(k);
  res.status(202).json({ jobId: id });
});

router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job (the server may have restarted). Send again.' });
  res.json(job);
});

module.exports = router;
