// cron/healthcheck.js — Brains (Claude auth) health check
//
// Pings Claude with a tiny prompt and records the result in Firestore (system/brains).
// The Command tab reads this to show a green/red status dot, so a dead OAuth token
// surfaces immediately instead of silently breaking classification + insights for weeks.

const { db } = require('../services/db');
const { claudePrompt } = require('../services/claude');

async function checkBrains() {
  let status;
  try {
    const out = await claudePrompt('Reply with exactly one word: ok', { timeout: 60000 });
    status = { brains_ok: /\bok\b/i.test(out || ''), checked_at: new Date(), sample: (out || '').slice(0, 40) };
  } catch (e) {
    status = { brains_ok: false, checked_at: new Date(), error: (e.message || '').slice(0, 200) };
  }
  try {
    await db.collection('system').doc('brains').set(status);
  } catch (e) {
    console.error('[healthcheck] store failed:', e.message);
  }
  console.log('[healthcheck] brains_ok:', status.brains_ok);
  return status;
}

module.exports = { checkBrains };
