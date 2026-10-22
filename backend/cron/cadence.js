// cron/cadence.js — every 10 minutes: check ad lead replies (email over IMAP,
// texts from RingCentral), send or queue whatever step is due, and keep the
// shared sheet's Outreach Status / Last Touch / Next Touch current.
// All the logic is in services/cadence.js.

const cadence = require('../services/cadence');

async function runCadence() {
  const r = await cadence.tick();
  if (r && (r.queued?.length || r.sent?.length || r.replies?.email || r.replies?.sms || r.blocked?.length)) {
    console.log('[cadence]', JSON.stringify(r));
  }
  return r;
}

/** Every minute: send approved cards whose window and Email 1 gap allow it. */
async function runDispatcher() {
  const r = await cadence.dispatchApproved();
  const sent = Object.values((r && r.results) || {}).filter(x => x.status === 'sent');
  if (sent.length) console.log('[cadence] dispatched', sent.map(x => `${x.email} ${x.step}`).join(', '));
  return r;
}

/**
 * Every minute: New Lead emails become tagged leads with their first card queued.
 * Quiet in the PM2 log (no logrotate on the VPS): a line only when it finds a New
 * Lead, and an error once, then again only if it changes or an hour passes.
 */
let _lastErr = null;
async function runIntake() {
  let r, err = null;
  try { r = await cadence.runIntake(); err = r && r.error; } catch (e) { err = e.message; }
  if (r && (r.added?.length || r.skipped?.length)) console.log('[intake]', JSON.stringify(r));
  if (err && (!_lastErr || _lastErr.msg !== err || Date.now() - _lastErr.at > 36e5)) {
    console.error('[intake] error:', err);
    _lastErr = { msg: err, at: Date.now() };
  } else if (!err && _lastErr) {
    console.log('[intake] working again');
    _lastErr = null;
  }
  return r;
}

module.exports = { runCadence, runDispatcher, runIntake };
