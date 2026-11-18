const express = require('express');
const se = require('../services/subseqEnroll');

const router = express.Router();

// The log holds lead emails, so it needs the same shared key as the
// cross-channel routes when CROSS_CHANNEL_KEY is set. /status is open.
function requireKey(req, res, next) {
  const key = String(process.env.CROSS_CHANNEL_KEY || '');
  if (!key) return next();
  if (req.get('x-cross-channel-key') === key) return next();
  return res.status(401).json({ error: 'x-cross-channel-key header required' });
}

/**
 * GET /api/subseq-enroll/status
 * Mode, method, and how many decisions are in each state. No lead data.
 */
router.get('/status', async (req, res) => {
  try {
    let decisions = null;
    try { decisions = await se.firestoreStore().countByStatus(); } catch (e) { decisions = `count failed: ${e.message}`; }
    res.json({ mode: se.mode(), liveMethod: se.method(), decisions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/subseq-enroll/log?limit=50
 * Newest decisions first ("would enroll X into Y", skips, no action).
 */
router.get('/log', requireKey, async (req, res) => {
  try {
    const { logs } = require('../services/db');
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    // No orderBy: avoids a composite index. Sorted here.
    const snap = await logs.where('type', '==', se.LOG_TYPE).limit(2000).get();
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
