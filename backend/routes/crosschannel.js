const express = require('express');
const cc = require('../services/crossChannel');

const router = express.Router();

// Anything that writes or reads lead data needs the shared key when
// CROSS_CHANNEL_KEY is set (it is on the VPS). /status is open.
function requireKey(req, res, next) {
  const key = String(process.env.CROSS_CHANNEL_KEY || '');
  if (!key) return next();
  if (req.get('x-cross-channel-key') === key) return next();
  return res.status(401).json({ error: 'x-cross-channel-key header required' });
}

// With one pair on the allowlist the caller does not have to name it.
function pickPair(body = {}) {
  const all = cc.pairs();
  const inst = body.instantlyCampaignId || body.instantly_campaign_id;
  const hr = body.heyreachCampaignId || body.heyreach_campaign_id;
  if (inst && hr) return { instantly: String(inst).toLowerCase(), heyreach: String(hr) };
  if (!inst && !hr && all.length === 1) return all[0];
  if (hr) return all.find(p => p.heyreach === String(hr)) || null;
  if (inst) return all.find(p => p.instantly === String(inst).toLowerCase()) || null;
  return null;
}

/**
 * GET /api/crosschannel/status
 * Mode, the allowlisted pairs and how many links each has.
 */
router.get('/status', async (req, res) => {
  try {
    const store = cc.firestoreStore();
    const pairs = [];
    for (const p of cc.pairs()) {
      let links = null;
      try { links = await store.countForPair(p.instantly, p.heyreach); } catch (e) { links = `count failed: ${e.message}`; }
      pairs.push({ instantlyCampaignId: p.instantly, heyreachCampaignId: p.heyreach, links });
    }
    res.json({ mode: cc.mode(), acceptTracking: cc.acceptTracking(), keyRequired: !!process.env.CROSS_CHANNEL_KEY, pairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/crosschannel/links
 * Fill the link store from a list.
 * Body: { rows: [{ email, linkedinUrl, firstName, lastName, company }],
 *         instantlyCampaignId?, heyreachCampaignId? }
 * The pair must be on the CROSS_CHANNEL_PAIRS allowlist. Safe to re-run: a row
 * is keyed by pair plus email, so the same list twice updates, never doubles.
 */
router.post('/links', requireKey, express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : (Array.isArray(req.body?.leads) ? req.body.leads : null);
    if (!rows || !rows.length) return res.status(400).json({ error: 'rows array required' });
    const pair = pickPair(req.body);
    if (!pair || !cc.isAllowedPair(pair.instantly, pair.heyreach)) {
      return res.status(400).json({ error: 'instantlyCampaignId and heyreachCampaignId must be a pair listed in CROSS_CHANNEL_PAIRS' });
    }
    const out = await cc.upsertLinks(rows, { instantlyCampaignId: pair.instantly, heyreachCampaignId: pair.heyreach, source: 'bulk' });
    res.json({
      ok: true,
      instantlyCampaignId: pair.instantly,
      heyreachCampaignId: pair.heyreach,
      received: rows.length,
      saved: out.saved,
      skipped: out.skipped.length,
      skippedSample: out.skipped.slice(0, 25),
    });
  } catch (e) {
    console.error('[cross-channel] links upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/crosschannel/links/lookup?email=  or  ?linkedinUrl=
 */
router.get('/links/lookup', requireKey, async (req, res) => {
  try {
    const store = cc.firestoreStore();
    const email = cc.cleanEmail(req.query.email);
    const key = cc.linkedinKey(req.query.linkedinUrl || req.query.linkedin_url);
    if (!email && !key) return res.status(400).json({ error: 'email or linkedinUrl required' });
    const links = email ? await store.byEmail(email) : await store.byLinkedinKey(key);
    res.json({ count: links.length, links: links.map(({ instantly_snapshot, ...l }) => l) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/crosschannel/simulate
 * Runs one decision in shadow mode whatever CROSS_CHANNEL_STOP says. It never
 * stops anything, never touches link state, and its log row is marked
 * simulated. For checking a link or a payload before going live.
 * Body: { channel: 'linkedin', profileUrl, firstName, lastName, company, heyreachCampaignId }
 *    or { channel: 'email', email, classification, instantlyCampaignId }
 */
router.post('/simulate', requireKey, express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (b.channel === 'linkedin') {
      return res.json(await cc.onLinkedInReply({
        profileUrl: b.profileUrl || b.linkedinUrl, firstName: b.firstName, lastName: b.lastName, company: b.company,
        heyreachCampaignId: b.heyreachCampaignId, simulated: true,
      }));
    }
    if (b.channel === 'email') {
      return res.json(await cc.onEmailReply({
        email: b.email, classification: b.classification || 'interested', instantlyCampaignId: b.instantlyCampaignId, simulated: true,
      }));
    }
    res.status(400).json({ error: "channel must be 'linkedin' or 'email'" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/crosschannel/log?limit=50
 * The newest cross-channel rows from the logs collection.
 */
router.get('/log', requireKey, async (req, res) => {
  try {
    const { logs } = require('../services/db');
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    // No orderBy: avoids a composite index. Sorted here.
    const snap = await logs.where('type', '==', 'cross_channel').limit(2000).get();
    const rows = snap.docs
      .map(d => ({ id: d.id, created_at: d.data().created_at?.toDate?.()?.toISOString?.() || null, ...d.data().data }))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, limit);
    res.json({ count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
