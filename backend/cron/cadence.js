// cron/cadence.js — every 10 minutes: turn new "New Lead" emails into tagged
// leads (services/leadIntake.js), check ad lead replies (email over IMAP,
// texts from RingCentral), send or queue whatever step is due, and keep the
// shared sheet's Outreach Status / Last Touch / Next Touch current.
// All the logic is in services/cadence.js.

const cadence = require('../services/cadence');

async function runCadence() {
  const r = await cadence.tick();
  if (r && (r.intake?.added?.length || r.intake?.skipped?.length || r.intake?.error || r.queued?.length || r.sent?.length || r.replies?.email || r.replies?.sms || r.blocked?.length)) {
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

module.exports = { runCadence, runDispatcher };
