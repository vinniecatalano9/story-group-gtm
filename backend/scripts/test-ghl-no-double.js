// Checks the 11/18 no-double-send rules without Firestore or network:
// meeting confirm and reminders skip unless we auto-booked the meeting; no-show still runs.
// Run: node scripts/test-ghl-no-double.js
const path = require('path');
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('services/db.js', { db: () => ({ collection: () => ({ doc: () => ({}) }) }), addLog: async () => {} });
const { nextStep } = require('../services/cadence');
let fail = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fail++; };
const meetIn2Days = new Date(Date.now() + 2 * 864e5);
const base = { running: true, track: 'meeting', tz: 'America/New_York', email: 'a@b.co', phone: '+15555550100', sms_consent: 'yes', meeting_at: meetIn2Days, steps_done: {} };

let n = nextStep({ ...base, meeting_source: '' });
ok(n && n.step.id === 'meet_confirm' && n.skip === 'GHL calendar sends this', 'manual booking: confirm text skipped');
const allSkipped = { meet_confirm: 1, remind24_email: 1, remind24_text: 1, remind1_email: 1, remind1_text: 1 };
n = nextStep({ ...base, meeting_source: null, steps_done: allSkipped });
ok(n && n.step.id === 'noshow' && !n.skip, 'no-show text still runs');
n = nextStep({ ...base, meeting_source: 'auto-booked from email reply' });
ok(n && n.step.id === 'meet_confirm' && n.skip !== 'GHL calendar sends this', 'auto-booked: our confirm still runs');
n = nextStep({ ...base, track: 'intro', meeting_at: null });
ok(n && n.step.id === 'email1' && !n.skip, 'intro track untouched');
process.exit(fail ? 1 : 0);
