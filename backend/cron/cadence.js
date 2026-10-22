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

module.exports = { runCadence };
