/**
 * Test for the reply follow-up auto-enroll (services/subseqEnroll.js,
 * lib/subseqPolicy.js). Safe to run anywhere: Firestore is an in-memory fake
 * and the Instantly API is a fake fetch that records every call, so nothing is
 * read from or written to the real services.
 *
 *   node scripts/test-subseq-enroll.js
 */
const path = require('path');

let failed = 0;
function check(label, got, want) {
  const pass = got === want;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: ${got}${pass ? '' : ` (wanted ${want})`}`);
}

// ----- stubs that must exist before services/instantly.js loads -----
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('services/db.js', { addLog: async () => {}, updateLead: async () => {} });
stub('services/clearout.js', { verifyEmail: async () => ({ status: 'valid' }) });
process.env.INSTANTLY_API_KEY = 'test-key-not-real';

// ----- fake Instantly -----
const CAMP = 'aaaaaaaa-0000-4000-8000-000000000001';
const CAMP_NONE = 'aaaaaaaa-0000-4000-8000-000000000002'; // a campaign with no subsequences
const SUB_CALL = 'sub-call-time';
const SUB_OBJ = 'sub-objection';
const world = { emails: {}, leads: {}, subs: {}, calls: [], failEmails: false, failMove: false };
function resetWorld() {
  world.emails = {}; world.leads = {}; world.calls = []; world.failEmails = false; world.failMove = false;
  world.subs = {
    [CAMP]: [
      { id: SUB_CALL, name: 'Call Time Sent', status: 1, parent_campaign: CAMP, conditions: { crm_status: [51] } },
      { id: SUB_OBJ, name: 'Objection Followup', status: 1, parent_campaign: CAMP, conditions: { crm_status: [52] } },
    ],
    [CAMP_NONE]: [],
  };
}
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const p = u.pathname.replace('/api/v2', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  world.calls.push({ method: opts.method, path: p, body });
  const ok = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const bad = (status, msg) => ({ ok: false, status, json: async () => ({}), text: async () => msg });
  if (opts.method === 'GET' && p === '/emails') {
    if (world.failEmails) return bad(500, 'boom');
    return ok({ items: world.emails[u.searchParams.get('lead')] || [] });
  }
  if (opts.method === 'GET' && p === '/subsequences') return ok({ items: world.subs[u.searchParams.get('parent_campaign')] || [] });
  if (opts.method === 'POST' && p === '/leads/list') {
    const l = world.leads[`${body.campaign}|${body.contacts[0]}`];
    return ok({ items: l ? [l] : [] });
  }
  if (opts.method === 'POST' && p === '/leads/subsequence/move') return world.failMove ? bad(400, 'nope') : ok({ ok: true });
  if (opts.method === 'POST' && p === '/leads/update-interest-status') return ok({ ok: true });
  const resume = opts.method === 'POST' && p.match(/^\/subsequences\/([^/]+)\/resume$/);
  if (resume) {
    if (world.failResume) return bad(400, 'nope');
    for (const list of Object.values(world.subs)) for (const s of list) if (s.id === decodeURIComponent(resume[1])) s.status = 1;
    return ok({ status: 1 });
  }
  return bad(404, `unexpected call ${opts.method} ${p}`);
};
const writes = () => world.calls.filter(c => !(c.method === 'GET' || c.path === '/leads/list'));

// ----- fake Firestore store -----
function makeStore() {
  const docs = {};
  const replies = {};
  const stopped = new Set();
  return {
    docs, replies, stopped,
    async get(id) { return docs[id] ? { id, ...docs[id] } : null; },
    async set(id, data) { docs[id] = { ...data }; },
    async patch(id, data) { docs[id] = { ...(docs[id] || {}), ...data }; },
    async listPending() { return Object.entries(docs).filter(([, d]) => d.status === 'pending').map(([id, d]) => ({ id, ...d })); },
    async replyInfo(replyId) { return replies[replyId] || null; },
    async crossChannelStopped(email, campaignId) { return stopped.has(`${campaignId}|${email}`); },
  };
}

const se = require('../services/subseqEnroll');
const policy = require('../lib/subseqPolicy');

const T0 = new Date('2026-11-18T15:00:00.000Z');
const min = n => new Date(T0.getTime() + n * 60000);

function setup() {
  resetWorld();
  const store = makeStore();
  const rows = [];
  const clock = { now: min(0) };
  const deps = { store, log: async row => { rows.push(row); }, now: () => clock.now };
  return { store, rows, clock, deps };
}

// A lead in CAMP whose reply landed at T0 (email id in-<n>), in thread th-<n>.
function seedLead(n, extra = {}) {
  const email = `lead${n}@example.com`;
  world.leads[`${extra.campaign || CAMP}|${email}`] = { id: `lead-id-${n}`, email, campaign: extra.campaign || CAMP, lt_interest_status: 1, subsequence_id: null, ...(extra.lead || {}) };
  world.emails[email] = [
    { id: `camp-${n}`, ue_type: 1, thread_id: `th-${n}`, timestamp_created: min(-30).toISOString() },
    { id: `in-${n}`, ue_type: 2, thread_id: `th-${n}`, timestamp_created: min(0).toISOString() },
  ];
  return email;
}
function addAnswer(n, { at = min(5), thread, html = '<div>We start at $10,000 and customize from there. Worth a quick call?</div>' } = {}) {
  world.emails[`lead${n}@example.com`].unshift({ id: `ans-${n}`, ue_type: 3, thread_id: thread || `th-${n}`, timestamp_created: at.toISOString(), body: { html } });
}
const webhook = (n, classification, extra = {}) => ({
  email: `lead${n}@example.com`, classification, campaignId: extra.campaign || CAMP, campaignName: 'Test campaign',
  replyId: `reply-${n}`, emailUuid: `in-${n}`, replyAt: min(0).toISOString(),
  classifierSubsequence: classification === 'interested' ? 'Call Time Sent' : 'Objection Follow-Up', ...extra,
});

async function main() {
  console.log('\n1. Policy table');
  check('interested', policy.pick({ classification: 'interested', classifierSubsequence: 'Call Time Sent' }).subsequence, 'Call Time Sent');
  check('re_engage', policy.pick({ classification: 're_engage', classifierSubsequence: 'Call Time Sent' }).subsequence, 'Call Time Sent');
  for (const c of ['cost_question', 'cost_question_repeat', 'question_other', 'timing_objection', 'guarantee', 'more_info']) {
    check(c, policy.pick({ classification: c, classifierSubsequence: 'Objection Follow-Up' }).subsequence, 'Objection Followup');
  }
  for (const c of ['not_interested', 'ooo', 'bounce', 'referral', 'other', 'ghost_followup']) {
    check(`${c} -> nothing`, policy.pick({ classification: c }).subsequence, null);
  }
  check('unclear (classifier picked no sequence) -> nothing', policy.pick({ classification: 'cost_question', classifierSubsequence: '' }).subsequence, null);
  check('unclear is flagged', policy.pick({ classification: 'cost_question' }).unclear, true);
  check('classifier failed -> nothing', policy.pick({ classification: 'interested', failed: true }).subsequence, null);
  check('unknown class, no hint -> nothing', policy.pick({ classification: 'brand_new_class' }).subsequence, null);
  check('unknown class takes the classifier hint', policy.pick({ classification: 'brand_new_class', classifierSubsequence: 'Objection Follow-Up' }).subsequence, 'Objection Followup');
  check('name match ignores case and hyphens', policy.sameSequence('objection follow-up', 'Objection Followup'), true);
  check('"2pm" is a call time', policy.proposesTimes('Are you free Tuesday at 2pm or 3:30 PM EST?'), true);
  check('"noon" is a call time', policy.proposesTimes('How about August 3rd around noon?'), true);
  check('a price is not a call time', policy.proposesTimes('We start at $10,000 and customize from there. Worth a call?'), false);

  console.log('\n2. Switch off: nothing happens');
  delete process.env.SUBSEQ_AUTO_ENROLL;
  let t = setup();
  seedLead(1); addAnswer(1);
  check('notePending when off', (await se.notePending(webhook(1, 'cost_question'), t.deps)).outcome, 'off');
  check('checkPending when off', (await se.checkPending({}, t.deps)).mode, 'off');
  check('off: nothing saved', Object.keys(t.store.docs).length, 0);
  check('off: no Instantly calls at all', world.calls.length, 0);

  console.log('\n3. Shadow: waits for OUR answer, then logs "would enroll"');
  process.env.SUBSEQ_AUTO_ENROLL = 'shadow';
  t = setup();
  seedLead(1);
  check('reply classified -> pending', (await se.notePending(webhook(1, 'cost_question'), t.deps)).outcome, 'pending');
  check('the webhook step calls Instantly zero times', world.calls.length, 0);
  t.clock.now = min(3);
  let r = await se.checkPending({}, t.deps);
  check('no answer sent yet -> waiting', r.results[0].outcome, 'waiting');
  check('waiting writes no log row', t.rows.length, 0);
  addAnswer(1);
  t.clock.now = min(8);
  r = await se.checkPending({}, t.deps);
  check('answer sent -> would_enroll', r.results[0].outcome, 'would_enroll');
  check('into Objection Followup', t.rows[0].subsequence, 'Objection Followup');
  check('subsequence id found by name on the lead\'s campaign', t.rows[0].subsequence_id, SUB_OBJ);
  check('row has the lead email', t.rows[0].lead_email, 'lead1@example.com');
  check('row has the campaign', t.rows[0].campaign_id, CAMP);
  check('row has the classification', t.rows[0].classification, 'cost_question');
  check('row has a reason', !!t.rows[0].reason, true);
  check('row has the sent answer it keyed on', t.rows[0].answer_email_id + '|' + /\$10,000/.test(t.rows[0].answer_text), 'ans-1|true');
  check('row says shadow', t.rows[0].mode, 'shadow');
  check('shadow made zero write calls to Instantly', writes().length, 0);
  t.clock.now = min(13);
  r = await se.checkPending({}, t.deps);
  check('decided once: next run has nothing to check', r.checked, 0);
  check('still one log row', t.rows.length, 1);
  check('same reply delivered twice does not reopen it', (await se.notePending(webhook(1, 'cost_question'), t.deps)).outcome, 'duplicate_webhook');

  console.log('\n4. Call Time Sent, and the sent text gets the last word');
  t = setup();
  seedLead(2); seedLead(3); seedLead(4);
  await se.notePending(webhook(2, 'interested'), t.deps);
  await se.notePending(webhook(3, 'interested'), t.deps);
  await se.notePending(webhook(4, 'cost_question'), t.deps);
  addAnswer(2, { html: '<div>Great. Are you free Thursday at 2pm or 4pm EST?</div><blockquote>earlier email, sent at 9am</blockquote>' });
  addAnswer(3, { html: '<div>Glad to hear it. What are you hoping press does for the business?</div><div class="gmail_quote">On Tue wrote: free at 3pm?</div>' });
  addAnswer(4, { html: '<div>We start at $10,000. Are you free Monday at 11am or 1pm EST?</div>' });
  t.clock.now = min(8);
  await se.checkPending({}, t.deps);
  const by = e => t.rows.find(x => x.lead_email === e);
  check('interested + times pitched -> Call Time Sent', by('lead2@example.com').subsequence, 'Call Time Sent');
  check('Call Time Sent id', by('lead2@example.com').subsequence_id, SUB_CALL);
  check('interested but our answer has no time (quoted text ignored) -> Objection Followup', by('lead3@example.com').subsequence, 'Objection Followup');
  check('cost answer that pitched times -> Call Time Sent', by('lead4@example.com').subsequence, 'Call Time Sent');

  console.log('\n5. Replies that never enroll');
  t = setup();
  seedLead(5); seedLead(6); seedLead(7);
  check('not_interested -> no_action', (await se.notePending(webhook(5, 'not_interested'), t.deps)).outcome, 'no_action');
  check('referral -> no_action', (await se.notePending(webhook(6, 'referral'), t.deps)).outcome, 'no_action');
  check('ooo -> ignored', (await se.notePending(webhook(7, 'ooo'), t.deps)).outcome, 'ignored_auto_reply');
  check('bounce -> ignored', (await se.notePending(webhook(7, 'bounce'), t.deps)).outcome, 'ignored_auto_reply');
  check('classifier failed -> no_action', (await se.notePending(webhook(7, 'other', { classifierFailed: true }), t.deps)).outcome, 'no_action');
  check('unclear classification -> skipped, logged', (await se.notePending(webhook(7, 'cost_question', { classifierSubsequence: '' }), t.deps)).outcome + '|' + t.rows[t.rows.length - 1].skip, 'skipped|unclear_classification');
  check('nothing pending', Object.values(t.store.docs).filter(d => d.status === 'pending').length, 0);
  // A question, then "not interested" before we answered: the open decision is cancelled.
  await se.notePending(webhook(5, 'cost_question'), t.deps);
  await se.notePending(webhook(5, 'not_interested', { emailUuid: 'in-5b', replyId: 'reply-5b' }), t.deps);
  check('a later "no" cancels the open decision', t.store.docs[se.pendingId(CAMP, 'lead5@example.com')].status, 'cancelled');
  // A question, then an out of office: the open decision stays.
  await se.notePending(webhook(6, 'cost_question'), t.deps);
  await se.notePending(webhook(6, 'ooo', { emailUuid: 'in-6b' }), t.deps);
  check('an out of office does not cancel it', t.store.docs[se.pendingId(CAMP, 'lead6@example.com')].status, 'pending');
  check('no Instantly calls from any of this', world.calls.length, 0);

  console.log('\n6. What counts as our answer');
  t = setup();
  seedLead(8); seedLead(9); seedLead(10);
  await se.notePending(webhook(8, 'cost_question'), t.deps);
  await se.notePending(webhook(9, 'cost_question'), t.deps);
  await se.notePending(webhook(10, 'cost_question', { emailUuid: null }), t.deps);
  addAnswer(8, { thread: 'some-other-thread' });          // sent, but in another thread
  addAnswer(9, { at: min(-10) });                          // sent before their reply
  addAnswer(10);                                           // no email id on the webhook: matched by time
  t.clock.now = min(8);
  r = await se.checkPending({}, t.deps);
  const out = e => r.results.find(x => x.email === e).outcome;
  check('a sent email in another thread is not an answer', out('lead8@example.com'), 'waiting');
  check('a sent email older than their reply is not an answer', out('lead9@example.com'), 'waiting');
  check('webhook without an email id still matches by time', out('lead10@example.com'), 'would_enroll');
  check('a campaign email (ue_type 1) alone is never an answer', se.findSentAnswer({ email_uuid: 'in-1' }, [
    { id: 'in-1', ue_type: 2, thread_id: 't', timestamp_created: min(0).toISOString() },
    { id: 'c', ue_type: 1, thread_id: 't', timestamp_created: min(5).toISOString() },
  ]).answer, null);

  console.log('\n7. Skips');
  t = setup();
  seedLead(11, { campaign: CAMP_NONE });
  seedLead(12); seedLead(13, { lead: { lt_interest_status: 2 } }); seedLead(14, { lead: { subsequence_id: SUB_OBJ } }); seedLead(15); seedLead(16);
  delete world.leads[`${CAMP}|lead15@example.com`]; // no longer in the campaign
  t.store.stopped.add(`${CAMP}|lead12@example.com`);
  await se.notePending(webhook(11, 'cost_question', { campaign: CAMP_NONE }), t.deps);
  for (const n of [12, 13, 14, 15, 16]) await se.notePending(webhook(n, 'cost_question'), t.deps);
  for (const n of [11, 12, 13, 14, 15, 16]) addAnswer(n);
  world.subs[CAMP][1].status = 2; // Objection Followup paused, for lead 16 only (checked last)
  t.clock.now = min(8);
  await se.checkPending({ limit: 5 }, t.deps);
  world.subs[CAMP][1].status = 1;
  const row = n => t.rows.find(x => x.lead_email === `lead${n}@example.com`) || {};
  check('campaign with no subsequences -> logged, nothing done', row(11).outcome, 'no_subsequence');
  check('cross-channel stop already moved the lead -> skipped', row(12).skip, 'cross_channel_stop');
  check('per-run limit respected', t.rows.length, 5);
  await se.checkPending({}, t.deps);
  // Leads 13, 14, 15 were decided while the subsequence was paused.
  check('paused subsequence -> skipped', [13, 14, 15, 16].filter(n => row(n).skip === 'subsequence_not_active').length >= 1, true);
  t = setup();
  seedLead(13, { lead: { lt_interest_status: 2 } }); seedLead(14, { lead: { subsequence_id: SUB_OBJ } }); seedLead(15);
  delete world.leads[`${CAMP}|lead15@example.com`];
  for (const n of [13, 14, 15]) { await se.notePending(webhook(n, 'cost_question'), t.deps); addAnswer(n); }
  t.clock.now = min(8);
  await se.checkPending({}, t.deps);
  const row2 = n => t.rows.find(x => x.lead_email === `lead${n}@example.com`) || {};
  check('Meeting Booked label -> skipped', row2(13).skip, 'lead_label');
  check('already in the subsequence -> already_enrolled', row2(14).outcome, 'already_enrolled');
  check('lead gone from the campaign -> skipped', row2(15).skip, 'not_in_campaign');
  check('skips made zero write calls', writes().length, 0);

  console.log('\n8. Expiry, reclassification, read failures');
  t = setup();
  seedLead(17); seedLead(18); seedLead(19);
  await se.notePending(webhook(17, 'cost_question'), t.deps);
  t.clock.now = new Date(T0.getTime() + 8 * 86400000);
  await se.checkPending({}, t.deps);
  check('no answer in 7 days -> expired, nothing enrolled', t.rows[0].outcome, 'expired_no_answer');
  t.clock.now = min(0);
  await se.notePending(webhook(18, 'cost_question'), t.deps);
  t.store.replies['reply-18'] = { classification: 'not_interested', subsequence: '' }; // reclassified after the webhook
  addAnswer(18);
  t.clock.now = min(8);
  await se.checkPending({}, t.deps);
  check('reclassified to not_interested -> no_action', t.rows[1].outcome, 'no_action');
  t.clock.now = min(0);
  await se.notePending(webhook(19, 'cost_question'), t.deps);
  addAnswer(19);
  world.failEmails = true;
  t.clock.now = min(8);
  r = await se.checkPending({}, t.deps);
  check('Instantly read fails -> error, no log row', r.results[0].outcome + '|' + t.rows.length, 'error|2');
  check('and the decision stays pending', t.store.docs[se.pendingId(CAMP, 'lead19@example.com')].status, 'pending');
  world.failEmails = false;
  t.clock.now = min(13);
  r = await se.checkPending({}, t.deps);
  check('next run picks it up', r.results[0].outcome, 'would_enroll');
  check('still zero write calls', writes().length, 0);

  console.log('\n9. Live (fake Instantly only): one enroll call, never twice');
  process.env.SUBSEQ_AUTO_ENROLL = 'live';
  delete process.env.SUBSEQ_ENROLL_METHOD;
  t = setup();
  seedLead(20);
  await se.notePending(webhook(20, 'cost_question'), t.deps);
  t.clock.now = min(3);
  await se.checkPending({}, t.deps);
  check('live, no answer yet: zero write calls', writes().length, 0);
  addAnswer(20);
  t.clock.now = min(8);
  await se.checkPending({}, t.deps);
  check('live: outcome enrolled', t.rows[0].outcome, 'enrolled');
  check('live: exactly one write call', writes().length, 1);
  check('live: it is the move call', writes()[0].path, '/leads/subsequence/move');
  check('live: body is the lead id and the subsequence id', JSON.stringify(writes()[0].body), JSON.stringify({ id: 'lead-id-20', subsequence_id: SUB_OBJ }));
  t.clock.now = min(13);
  await se.checkPending({}, t.deps);
  check('live: a second run sends nothing more', writes().length, 1);

  process.env.SUBSEQ_ENROLL_METHOD = 'label';
  t = setup();
  seedLead(21);
  await se.notePending(webhook(21, 'interested'), t.deps);
  addAnswer(21, { html: '<div>Are you free Tuesday at 2pm or 3pm EST?</div>' });
  t.clock.now = min(8);
  await se.checkPending({}, t.deps);
  check('label method: one write call', writes().length, 1);
  check('label method: the label call', writes()[0].path, '/leads/update-interest-status');
  check('label method: body uses the subsequence\'s own trigger label', JSON.stringify(writes()[0].body), JSON.stringify({ lead_email: 'lead21@example.com', interest_value: 51, campaign_id: CAMP }));
  delete process.env.SUBSEQ_ENROLL_METHOD;

  t = setup();
  seedLead(22);
  await se.notePending(webhook(22, 'cost_question'), t.deps);
  addAnswer(22);
  world.failMove = true;
  t.clock.now = min(8);
  await se.checkPending({}, t.deps);
  check('live: a failed enroll is logged for a manual check', t.rows[0].outcome + '|' + t.rows[0].manual_check, 'failed|true');
  world.failMove = false;
  t.clock.now = min(13);
  await se.checkPending({}, t.deps);
  check('live: a failed enroll is not retried', writes().length, 1);

  // Instantly marks an idle subsequence Completed (3). Seen live 11/23/2026.
  t = setup();
  seedLead(23);
  await se.notePending(webhook(23, 'cost_question'), t.deps);
  addAnswer(23);
  world.subs[CAMP][1].status = 3;
  t.clock.now = min(8);
  await se.checkPending({}, t.deps);
  check('live, Completed subsequence: enrolled', t.rows[0].outcome, 'enrolled');
  check('live, Completed subsequence: resume call then move call', writes().map(c => c.path).join(','), `/subsequences/${SUB_OBJ}/resume,/leads/subsequence/move`);
  check('live, Completed subsequence: row says it was turned back on', t.rows[0].resumed_subsequence, true);
  check('live, Completed subsequence: it is active again', world.subs[CAMP][1].status, 1);

  t = setup();
  seedLead(24);
  await se.notePending(webhook(24, 'cost_question'), t.deps);
  addAnswer(24);
  world.subs[CAMP][1].status = 3;
  world.failResume = true;
  t.clock.now = min(8);
  await se.checkPending({}, t.deps);
  check('live, resume fails: logged for a manual check', t.rows[0].outcome + '|' + t.rows[0].manual_check, 'failed|true');
  check('live, resume fails: no move call', writes().filter(c => c.path === '/leads/subsequence/move').length, 0);
  world.failResume = false;

  t = setup();
  seedLead(25);
  await se.notePending(webhook(25, 'cost_question'), t.deps);
  addAnswer(25);
  world.subs[CAMP][1].status = 2;
  t.clock.now = min(8);
  await se.checkPending({}, t.deps);
  check('live, Paused subsequence: still skipped, nothing turned on', t.rows[0].skip + '|' + writes().length, 'subsequence_not_active|0');
  world.subs[CAMP][1].status = 1;

  console.log('\n10. Unknown switch value means off');
  process.env.SUBSEQ_AUTO_ENROLL = 'yes';
  check('mode', se.mode(), 'off');
  delete process.env.SUBSEQ_AUTO_ENROLL;

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
