#!/usr/bin/env node
/**
 * Cross-channel stop: replay check. Run it after any change to
 * services/crossChannel.js, routes/heyreach.js or routes/replies.js.
 *
 *   node scripts/crosschannel-replay.js              # real HeyReach payloads from Firestore (read only)
 *   node scripts/crosschannel-replay.js --synthetic  # made-up payloads, no Firestore
 *
 * What it does: runs the REAL webhook routes and the REAL cross-channel
 * service in this process, against an in-memory database and fake Instantly
 * and HeyReach calls. Nothing is written to Firestore, nothing is sent, no
 * campaign is touched, no Claude call is made. It prints the log rows the
 * system would have written and checks each decision.
 *
 * Real names are masked in the output.
 */
const path = require('path');
const http = require('http');
const BACKEND = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(BACKEND, '.env') });

const SYNTHETIC = process.argv.includes('--synthetic');
const INSTANTLY_CAMPAIGN = '3652a64b-15c2-4eb4-bc64-cb43ff1808a3';
const HEYREACH_CAMPAIGN = '741119';
const OTHER_PAIR = { instantly: '00000000-0000-4000-8000-000000000000', heyreach: '999999' };

// ---------- 1. real payloads (read only), before anything is faked ----------

function syntheticPayloads() {
  const mk = (first, last, slug, company, id, campaign) => ({
    is_inmail: false,
    recent_messages: [{ creation_time: new Date().toISOString(), message: 'Sure, send it over.', is_reply: true }],
    conversation_id: `conv-${slug}`,
    ...(campaign ? { campaign: { name: 'Video Outbound | Founders 2-30', id: Number(HEYREACH_CAMPAIGN), status: 2 } } : {}),
    sender: { id: 199221, first_name: 'Sender', last_name: 'One', full_name: 'Sender One', email_address: 'sender@example.com', profile_url: 'https://www.linkedin.com/in/sender-one' },
    lead: { id, profile_url: `https://www.linkedin.com/in/${slug}`, first_name: first, last_name: last, full_name: `${first} ${last}`, location: 'Austin, Texas', summary: 'Founder', company_url: null, company_name: company, position: 'Founder', about: null, email_address: null, enriched_email: null, custom_email: null, tags: [], lists: [] },
    external_reference: null,
    timestamp: new Date().toISOString(),
    event_type: 'every_message_reply_received',
    correlation_id: `corr-${slug}`,
  });
  return [
    mk('Dana', 'Whitfield', 'dana-whitfield-1a2b3c', 'Whitfield Roofing', '50000001', true),
    mk('Marcus', 'Oyelaran', 'marcusoyelaran', 'Brightline Software, Inc.', '50000002', false),
    mk('Priya', 'Raman', 'priya-raman-77', 'Raman Advisory', '50000003', true),
  ];
}

async function realPayloads() {
  const admin = require('firebase-admin');
  const app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID }, 'replay-reader');
  const snap = await app.firestore().collection('replies').where('source', '==', 'heyreach').limit(300).get();
  const rows = snap.docs.map(d => d.data())
    .filter(d => d.raw_payload)
    .sort((a, b) => (b.created_at?.toMillis?.() || 0) - (a.created_at?.toMillis?.() || 0))
    .map(d => JSON.parse(JSON.stringify(d.raw_payload)))
    .filter(p => {
      const e = p.data || p;
      const l = e.lead || {};
      return e.event_type === 'every_message_reply_received' && l.profile_url && l.first_name && l.last_name && l.company_name
        && Array.isArray(e.recent_messages) && e.recent_messages.some(m => m && m.is_reply && (m.message || '').trim());
    });
  await app.delete();
  const picked = [];
  const seen = new Set();
  // One with a campaign block, one without, then whatever is newest.
  for (const want of [p => !!(p.data || p).campaign, p => !(p.data || p).campaign, () => true]) {
    const hit = rows.find(p => want(p) && !seen.has((p.data || p).lead.profile_url));
    if (hit) { picked.push(hit); seen.add((hit.data || hit).lead.profile_url); }
  }
  if (picked.length < 3) throw new Error(`only ${picked.length} usable HeyReach payloads in Firestore`);
  return picked;
}

// ---------- 2. in-memory Firestore ----------

let idSeq = 0;
class FakeCollection {
  constructor(name) { this.name = name; this.docs = new Map(); }
  _ref(id) {
    const col = this;
    return {
      id,
      async get() { const d = col.docs.get(id); return { exists: !!d, id, data: () => d, ref: col._ref(id) }; },
      async set(data, opts) { col.docs.set(id, opts && opts.merge ? { ...(col.docs.get(id) || {}), ...data } : { ...data }); },
      async update(data) { if (!col.docs.has(id)) throw new Error('no doc'); col.docs.set(id, { ...col.docs.get(id), ...data }); },
    };
  }
  doc(id) { return this._ref(id || `auto${++idSeq}`); }
  async add(data) { const id = `auto${++idSeq}`; this.docs.set(id, { ...data }); return this._ref(id); }
  where(f, op, v) { return new FakeQuery(this, [[f, op, v]]); }
  orderBy() { return new FakeQuery(this, []); }
  limit(n) { return new FakeQuery(this, [], n); }
}
class FakeQuery {
  constructor(col, filters, lim) { this.col = col; this.filters = filters; this.lim = lim; }
  where(f, op, v) { return new FakeQuery(this.col, [...this.filters, [f, op, v]], this.lim); }
  orderBy() { return this; }
  limit(n) { return new FakeQuery(this.col, this.filters, n); }
  _run() {
    let out = [...this.col.docs.entries()].filter(([, d]) => this.filters.every(([f, , v]) => d[f] === v));
    if (this.lim) out = out.slice(0, this.lim);
    return out.map(([id, d]) => ({ id, data: () => d, ref: this.col._ref(id) }));
  }
  async get() { const docs = this._run(); return { empty: !docs.length, size: docs.length, docs }; }
  count() { return { get: async () => ({ data: () => ({ count: this._run().length }) }) }; }
}
const cols = {};
const fakeDb = {
  collection: name => (cols[name] = cols[name] || new FakeCollection(name)),
  batch() {
    const ops = [];
    return { set: (ref, data, opts) => ops.push(() => ref.set(data, opts)), async commit() { for (const op of ops) await op(); } };
  },
};
const dbStub = {
  db: fakeDb,
  leads: fakeDb.collection('leads'), replies: fakeDb.collection('replies'), logs: fakeDb.collection('logs'), transcripts: fakeDb.collection('transcripts'),
  async getLeadByEmail() { return null; },
  async updateLead() {},
  async addReply(r) { return (await fakeDb.collection('replies').add({ ...r, created_at: new Date() })).id; },
  async getRepliesByEmail() { return []; },
  async addLog(type, data) { await fakeDb.collection('logs').add({ type, data, created_at: new Date() }); },
};

// ---------- 3. fake vendors: every call is recorded, none leaves this process ----------

const vendorCalls = [];
let vendorsDown = false;
let nextClassification = 'interested';
let classifierDown = false;
const instantlyLeads = new Map(); // email -> lead record in the paired campaign

const instantlyStub = {
  async removeLeads(emails, campaignId) { vendorCalls.push({ vendor: 'instantly', call: 'removeLeads (existing behavior)', emails, campaignId: campaignId || null }); },
  async findLeadInCampaign(email, campaignId) {
    if (vendorsDown) throw new Error('Instantly POST /leads/list failed (503): simulated outage');
    vendorCalls.push({ vendor: 'instantly', call: 'POST /leads/list (read only)', body: { campaign: campaignId, contacts: [email], limit: 5 } });
    return instantlyLeads.get(email) || null;
  },
  async findOrCreateLeadList(name) { vendorCalls.push({ vendor: 'instantly', call: 'find or create lead list', name }); return 'hold-list-0001'; },
  async moveLeadToList(leadId, campaignId, listId) {
    vendorCalls.push({ vendor: 'instantly', call: 'POST /leads/move', body: { ids: [leadId], campaign: campaignId, to_list_id: listId, limit: 1 } });
    return { id: 'job-0001', status: 'pending' };
  },
};
const axiosStub = {
  async post(url, body) {
    if (vendorsDown) throw new Error('HeyReach request failed (503): simulated outage');
    const call = url.replace('https://api.heyreach.io/api/public', '');
    vendorCalls.push({ vendor: 'heyreach', call: `POST ${call}${call.includes('GetLead') ? ' (read only)' : ''}`, body });
    if (call === '/lead/GetLead') return { status: 200, data: { linkedin_id: '70000001', profileUrl: body.profileUrl } };
    return { status: 200, data: {} };
  },
  async get() { return { status: 200, data: {} }; },
};

function stub(rel, exports) {
  const file = require.resolve(path.join(BACKEND, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
}
stub('services/db.js', dbStub);
stub('services/instantly.js', instantlyStub);
stub('node_modules/axios', axiosStub);
stub('services/claude.js', { claudeJSON: async () => ({}) });
stub('services/replyClassifier.js', {
  classifyReply: async () => classifierDown
    ? { failed: true, classification: 'other', sentiment: 'neutral', summary: 'Classification failed', draft_response: '' }
    : { classification: nextClassification, sentiment: 'positive', summary: 'replay', draft_response: '', suggested_macro: 'NONE', tag: '', subsequence: '' },
});
stub('services/autoReply.js', { evaluateReply: async () => null, fetchConversation: async () => null, markSeen: async () => {} });
stub('services/replyApprovals.js', { offerReply: async () => {}, paidMisread: () => false });
stub('services/calendar.js', { findMeetingSlots: async () => null, peopleFromNote: () => [], holdSlots: async () => {}, releaseHolds: async () => {}, draftOffersSlots: () => false, getAvailableSlots: async () => null });
stub('services/hubspot.js', { syncLead: async () => {} });
stub('services/coteriehq.js', { syncReply: async () => {} });
stub('services/slack.js', { notifyNewReply: async () => {} });

// ---------- 4. the real routes ----------

process.env.CROSS_CHANNEL_PAIRS = `${INSTANTLY_CAMPAIGN}:${HEYREACH_CAMPAIGN}`;
process.env.CROSS_CHANNEL_STOP = 'shadow';
process.env.CROSS_CHANNEL_ACCEPT = 'off';
delete process.env.CROSS_CHANNEL_KEY;
delete process.env.CROSS_CHANNEL_HOLD_LIST_ID;
process.env.AUTO_REPLY_MODE = 'off';
process.env.HEYREACH_API_KEY = process.env.HEYREACH_API_KEY || 'replay-not-a-real-key';

const express = require('express');
const crossChannel = require(path.join(BACKEND, 'services/crossChannel.js'));
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/reply', require(path.join(BACKEND, 'routes/replies.js')));
app.use('/api/heyreach', require(path.join(BACKEND, 'routes/heyreach.js')));
app.use('/api/crosschannel', require(path.join(BACKEND, 'routes/crosschannel.js')));

// ---------- 5. helpers ----------

const quiet = { log: console.log, warn: console.warn, error: console.error };
const mute = () => { console.log = console.warn = console.error = () => {}; };
const unmute = () => Object.assign(console, quiet);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const maskName = n => String(n || '').split(' ').filter(Boolean).map((w, i) => (i === 0 ? w[0] + '.' : w[0] + '***')).join(' ');
const maskEmail = e => (e ? String(e).replace(/^(.{2}).*@/, '$1***@') : e);
const maskUrl = u => (u ? String(u).replace(/(\/in\/[^/?]{3})[^/?\s]*/gi, '$1***').replace(/\?.*$/, '') : u);
function maskRow(r) {
  const out = JSON.parse(JSON.stringify(r));
  if (out.who) out.who = { ...out.who, name: maskName(out.who.name), email: maskEmail(out.who.email), linkedin_url: maskUrl(out.who.linkedin_url) };
  for (const k of ['would', 'did', 'reason']) if (out[k]) out[k] = maskUrl(out[k]).replace(/[\w.+-]+@[\w.-]+/g, maskEmail);
  delete out.at;
  return out;
}

let server, base;
async function post(route, body) {
  const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch (e) { /* not json */ }
  return { status: res.status, json };
}
const logRows = () => [...fakeDb.collection('logs').docs.values()].filter(d => d.type === 'cross_channel').map(d => d.data);
const replyCount = () => fakeDb.collection('replies').docs.size;

let failures = 0;
function check(label, ok) {
  quiet.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

async function run(title, fn) {
  const logsBefore = logRows().length;
  const repliesBefore = replyCount();
  vendorCalls.length = 0;
  mute();
  let http;
  try { http = await fn(); await sleep(250); } finally { unmute(); }
  const rows = logRows().slice(logsBefore);
  quiet.log(`\n== ${title}`);
  if (http) quiet.log(`   webhook answered ${http.status}; reply cards saved by this call: ${replyCount() - repliesBefore}`);
  if (!rows.length) quiet.log('   log rows: none');
  for (const r of rows) quiet.log('   log row: ' + JSON.stringify(maskRow(r)));
  const writes = vendorCalls.filter(c => !/read only|existing behavior/.test(c.call));
  if (vendorCalls.length) quiet.log(`   vendor calls: ${vendorCalls.map(c => c.call).join('; ')}`);
  return { http, rows, writes, savedReplies: replyCount() - repliesBefore, calls: [...vendorCalls] };
}

// ---------- 6. the cases ----------

(async () => {
  let payloads;
  let source = 'synthetic payloads';
  if (!SYNTHETIC) {
    try { payloads = await realPayloads(); source = '3 real HeyReach reply payloads from Firestore (read only, names masked)'; }
    catch (e) { quiet.log(`Could not read real payloads (${e.message}). Using synthetic ones.`); }
  }
  if (!payloads) payloads = syntheticPayloads();
  const leadOf = p => (p.data || p).lead;
  const [pA, pB, pC] = payloads;
  const A = leadOf(pA), B = leadOf(pB), C = leadOf(pC);

  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  quiet.log('Cross-channel stop replay');
  quiet.log(`Source: ${source}`);
  quiet.log(`Pair on the allowlist: Instantly ${INSTANTLY_CAMPAIGN} <-> HeyReach ${HEYREACH_CAMPAIGN}`);
  quiet.log('Everything below ran against an in-memory database and fake vendor calls.');

  // Seed the link store through the real bulk route.
  mute();
  const seed = await post('/api/crosschannel/links', {
    rows: [
      // A: same profile URL as HeyReach reports it, with tracking junk and a different case.
      { email: 'replay.a@example.com', linkedinUrl: A.profile_url.replace('/in/', '/IN/') + '/?utm_source=apollo', firstName: A.first_name, lastName: A.last_name, company: A.company_name },
      // B: the export had a member-id URL, so the URL will miss and name plus company has to match.
      { email: 'replay.b@example.com', linkedinUrl: 'https://www.linkedin.com/in/ACoAAB0replayMemberId', firstName: B.first_name, lastName: B.last_name, company: `${B.company_name}, LLC` },
      // E: email-side test lead.
      { email: 'replay.e@example.com', linkedinUrl: 'https://www.linkedin.com/in/replay-email-lead/', firstName: 'Erin', lastName: 'Sample', company: 'Sample Co' },
      { email: 'not-an-email', linkedinUrl: 'https://www.linkedin.com/in/bad-row', firstName: 'Bad', lastName: 'Row' },
      { email: 'replay.nourl@example.com', linkedinUrl: '', firstName: 'No', lastName: 'Url' },
    ],
  });
  // A second upload naming a pair that is NOT on the allowlist must be refused.
  const refused = await post('/api/crosschannel/links', {
    instantlyCampaignId: OTHER_PAIR.instantly, heyreachCampaignId: OTHER_PAIR.heyreach,
    rows: [{ email: 'replay.c@example.com', linkedinUrl: C.profile_url, firstName: C.first_name, lastName: C.last_name, company: C.company_name }],
  });
  unmute();
  quiet.log(`\n== Link store: bulk upload through POST /api/crosschannel/links`);
  quiet.log(`   saved ${seed.json.saved}, skipped ${seed.json.skipped} (${seed.json.skippedSample.map(s => s.reason).join('; ')})`);
  check('3 good rows saved, 2 bad rows skipped', seed.json.saved === 3 && seed.json.skipped === 2);
  check('upload for a pair that is not on the allowlist is refused', refused.status === 400);

  instantlyLeads.set('replay.a@example.com', { id: 'lead-a-0001', email: 'replay.a@example.com', campaign: INSTANTLY_CAMPAIGN, status: 1, email_reply_count: 0, last_step_id: 'step-2' });
  instantlyLeads.set('replay.b@example.com', { id: 'lead-b-0001', email: 'replay.b@example.com', campaign: INSTANTLY_CAMPAIGN, status: 1, email_reply_count: 0, last_step_id: 'step-1' });

  // --- LinkedIn reply -> stop email (shadow) ---
  let r = await run('1. LinkedIn reply, profile URL matches (shadow)', () => post('/api/heyreach/webhook', pA));
  check('webhook 200 and reply card saved', r.http.status === 200 && r.savedReplies === 1);
  check('one row: would stop the email, matched by URL', r.rows.length === 1 && r.rows[0].outcome === 'would_stop' && r.rows[0].match === 'url' && r.rows[0].who.email === 'replay.a@example.com');
  check('nothing changed at Instantly or HeyReach', r.writes.length === 0);

  r = await run('2. Same person sends a second LinkedIn message (shadow)', () => post('/api/heyreach/webhook', pA));
  check('webhook 200, no second card, no duplicate row', r.http.status === 200 && r.savedReplies === 0 && r.rows.length === 0);

  r = await run('3. LinkedIn reply, URL misses (member-id export), name plus company matches one person (shadow)', () => post('/api/heyreach/webhook', pB));
  check('one row: would stop the email, matched by name and company', r.rows.length === 1 && r.rows[0].outcome === 'would_stop' && r.rows[0].match === 'name_company' && r.rows[0].who.email === 'replay.b@example.com');
  check('nothing changed at Instantly or HeyReach', r.writes.length === 0);

  r = await run('4. LinkedIn reply from someone with no link (shadow)', () => post('/api/heyreach/webhook', pC));
  check('webhook 200 and reply card saved', r.http.status === 200 && r.savedReplies === 1);
  const cInPair = String(((pC.data || pC).campaign || {}).id || '') === HEYREACH_CAMPAIGN;
  check(cInPair ? 'no stop; a "no link on file" row because the reply came from the paired campaign' : 'no stop and no row (not one of ours)', r.writes.length === 0 && (cInPair ? r.rows.length === 1 && r.rows[0].outcome === 'no_link' : r.rows.length === 0));

  // Two different people with the same name at the same company, neither URL on file.
  mute();
  await crossChannel.upsertLinks([
    { email: 'replay.twin1@example.com', linkedinUrl: 'https://www.linkedin.com/in/ACoAAtwin1', firstName: 'Jordan', lastName: 'Twin', company: 'Twin Partners' },
    { email: 'replay.twin2@example.com', linkedinUrl: 'https://www.linkedin.com/in/ACoAAtwin2', firstName: 'Jordan', lastName: 'Twin', company: 'Twin Partners LLC' },
  ], { instantlyCampaignId: INSTANTLY_CAMPAIGN, heyreachCampaignId: HEYREACH_CAMPAIGN, source: 'replay' });
  unmute();
  const twin = JSON.parse(JSON.stringify(syntheticPayloads()[0]));
  Object.assign(twin.lead, { id: '50000009', profile_url: 'https://www.linkedin.com/in/jordan-twin', first_name: 'Jordan', last_name: 'Twin', full_name: 'Jordan Twin', company_name: 'Twin Partners' });
  twin.conversation_id = 'conv-twin';
  r = await run('5. LinkedIn reply, URL misses and two links share the name and company (shadow)', () => post('/api/heyreach/webhook', twin));
  check('no stop; one row asking for a manual check', r.rows.length === 1 && r.rows[0].outcome === 'no_action' && r.rows[0].manual_check === true && r.writes.length === 0);

  const stranger = JSON.parse(JSON.stringify(syntheticPayloads()[0]));
  Object.assign(stranger.lead, { id: '50000010', profile_url: 'https://www.linkedin.com/in/erin-sample-other', first_name: 'Erin', last_name: 'Sample', full_name: 'Erin Sample', company_name: 'A Different Company' });
  stranger.conversation_id = 'conv-stranger';
  delete stranger.campaign;
  r = await run('6. LinkedIn reply, same name as a link but a different company (shadow)', () => post('/api/heyreach/webhook', stranger));
  check('no stop; one row saying name matched but company did not', r.rows.length === 1 && r.rows[0].outcome === 'no_action' && r.writes.length === 0);

  // --- Email reply -> stop LinkedIn (shadow) ---
  const instantlyBody = (email, text) => ({
    timestamp: new Date().toISOString(), event_type: 'reply_received', workspace: 'replay-workspace',
    campaign_id: INSTANTLY_CAMPAIGN, campaign_name: 'Video Outbound | Founders 2-30 | DRAFT 11-17-26',
    lead_email: email, email_account: 'sender@example.com', email_id: 'email-uuid-0001',
    reply_subject: 'Re: quick question', reply_text: text, reply_text_snippet: text.slice(0, 60),
    first_name: 'Erin', last_name: 'Sample', company_name: 'Sample Co',
  });

  nextClassification = 'interested';
  r = await run('7. Email reply from a real person (shadow)', () => post('/api/reply', instantlyBody('Replay.E@example.com', 'Sure, what does it cost?')));
  check('webhook 200 and reply saved', r.http.status === 200 && r.savedReplies === 1);
  check('one row: would stop LinkedIn', r.rows.length === 1 && r.rows[0].outcome === 'would_stop' && r.rows[0].action === 'stop_linkedin' && r.rows[0].heyreach_campaign_id === HEYREACH_CAMPAIGN);
  check('nothing changed at Instantly or HeyReach', r.writes.length === 0);

  mute();
  await crossChannel.upsertLinks([{ email: 'replay.f@example.com', linkedinUrl: 'https://www.linkedin.com/in/replay-ooo-lead', firstName: 'Frank', lastName: 'Away', company: 'Away Inc' }],
    { instantlyCampaignId: INSTANTLY_CAMPAIGN, heyreachCampaignId: HEYREACH_CAMPAIGN, source: 'replay' });
  unmute();
  nextClassification = 'ooo';
  r = await run('8. Email out-of-office (shadow)', () => post('/api/reply', instantlyBody('replay.f@example.com', 'I am out of the office until Monday.')));
  check('reply saved; LinkedIn left running (row says skipped)', r.savedReplies === 1 && r.rows.length === 1 && r.rows[0].outcome === 'skipped' && r.writes.length === 0);

  nextClassification = 'bounce';
  r = await run('9. Email bounce (shadow)', () => post('/api/reply', instantlyBody('replay.f@example.com', 'Delivery has failed to these recipients.')));
  check('reply saved; LinkedIn left running (row says skipped)', r.savedReplies === 1 && r.rows.length === 1 && r.rows[0].outcome === 'skipped' && r.writes.length === 0);

  nextClassification = 'interested'; classifierDown = true;
  r = await run('10. Email reply while the classifier is down (shadow)', () => post('/api/reply', instantlyBody('replay.f@example.com', 'Thanks, tell me more.')));
  check('reply saved; no stop, row asks for a manual check', r.savedReplies === 1 && r.rows.length === 1 && r.rows[0].outcome === 'skipped' && r.rows[0].manual_check === true);
  classifierDown = false;

  nextClassification = 'not_interested';
  r = await run('11. Email reply from an address with no link, other campaign (shadow)', () => post('/api/reply', { ...instantlyBody('stranger@example.com', 'No thanks.'), campaign_id: 'aaaaaaaa-0000-4000-8000-000000000000' }));
  check('reply saved; no row; cross-channel touched nothing', r.savedReplies === 1 && r.rows.length === 0 && r.writes.length === 0);
  nextClassification = 'interested';

  // --- Failure isolation ---
  vendorsDown = true;
  const pA2 = JSON.parse(JSON.stringify(twin));
  Object.assign(pA2.lead, { id: '50000011', profile_url: 'https://www.linkedin.com/in/replay-email-lead', first_name: 'Erin', last_name: 'Sample', full_name: 'Erin Sample', company_name: 'Sample Co' });
  pA2.conversation_id = 'conv-outage';
  r = await run('12. Instantly and HeyReach both down during a LinkedIn reply (shadow)', () => post('/api/heyreach/webhook', pA2));
  check('webhook still 200 and reply card still saved', r.http.status === 200 && r.savedReplies === 1);
  check('row still written, noting the lookup failed', r.rows.length === 1 && r.rows[0].outcome === 'would_stop' && !!r.rows[0].instantly_lead.lookup_error);
  vendorsDown = false;

  const realLi = crossChannel.onLinkedInReply;
  crossChannel.onLinkedInReply = () => { throw new Error('simulated crash inside cross-channel code'); };
  const crash = JSON.parse(JSON.stringify(twin)); crash.conversation_id = 'conv-crash'; crash.lead.profile_url = 'https://www.linkedin.com/in/crash-case';
  r = await run('13. Cross-channel code itself crashes during a LinkedIn reply', () => post('/api/heyreach/webhook', crash));
  check('webhook still 200 and reply card still saved', r.http.status === 200 && r.savedReplies === 1);
  crossChannel.onLinkedInReply = realLi;

  // --- Mode off ---
  process.env.CROSS_CHANNEL_STOP = 'off';
  const offP = JSON.parse(JSON.stringify(pA)); (offP.data || offP).conversation_id = 'conv-off-mode';
  r = await run('14. CROSS_CHANNEL_STOP=off, LinkedIn reply from a linked person', () => post('/api/heyreach/webhook', offP));
  check('reply card saved; no rows, no lookups, no vendor calls', r.http.status === 200 && r.rows.length === 0 && r.calls.length === 0);
  r = await run('15. CROSS_CHANNEL_STOP=off, email reply from a linked person', () => post('/api/reply', instantlyBody('replay.e@example.com', 'Yes, interested.')));
  check('reply saved; no rows, no vendor calls', r.http.status === 200 && r.savedReplies === 1 && r.rows.length === 0 && r.calls.length === 0);

  // --- Connection accepted (built, off) ---
  process.env.CROSS_CHANNEL_STOP = 'shadow';
  const accepted = JSON.parse(JSON.stringify(pA)); const ae = accepted.data || accepted;
  ae.event_type = 'connection_request_accepted'; delete ae.recent_messages; ae.conversation_id = null;
  r = await run('16. "Connection request accepted" event, accept tracking off', () => post('/api/heyreach/webhook', accepted));
  check('200, no reply card created, nothing recorded, nothing sent', r.http.status === 200 && r.savedReplies === 0 && r.rows.length === 0 && r.calls.length === 0 && r.http.json.tracked === false);
  process.env.CROSS_CHANNEL_ACCEPT = 'on';
  r = await run('17. Same event with CROSS_CHANNEL_ACCEPT=on', () => post('/api/heyreach/webhook', accepted));
  check('marks the link accepted and does nothing else', r.http.json.tracked === true && r.savedReplies === 0 && r.rows.length === 1 && r.rows[0].action === 'mark_accepted' && r.calls.length === 0);
  process.env.CROSS_CHANNEL_ACCEPT = 'off';

  // --- Live mode, against the fake vendors, to show the exact calls ---
  process.env.CROSS_CHANNEL_STOP = 'live';
  const liveP = JSON.parse(JSON.stringify(pB)); (liveP.data || liveP).conversation_id = 'conv-live-b';
  r = await run('18. LIVE mode against fake vendors: LinkedIn reply stops email', () => post('/api/heyreach/webhook', liveP));
  const move = r.calls.find(c => c.call === 'POST /leads/move');
  if (move) quiet.log('   Instantly call body: ' + JSON.stringify(move.body));
  check('one lead moved out of the paired campaign only, limit 1, no delete', !!move && move.body.ids.length === 1 && move.body.ids[0] === 'lead-b-0001' && move.body.campaign === INSTANTLY_CAMPAIGN && move.body.limit === 1 && !r.calls.some(c => /removeLeads|DELETE/.test(c.call)));
  check('row says stopped; copy of the lead saved on the link first', r.rows.length === 1 && r.rows[0].outcome === 'stopped' && [...fakeDb.collection('channel_links').docs.values()].some(l => l.email === 'replay.b@example.com' && l.instantly_snapshot && l.email_stopped_at));

  nextClassification = 'interested';
  r = await run('19. LIVE mode against fake vendors: email reply stops LinkedIn', () => post('/api/reply', instantlyBody('replay.e@example.com', 'Sounds good, send times.')));
  const stop = r.calls.find(c => c.call === 'POST /campaign/StopLeadInCampaign');
  if (stop) quiet.log('   HeyReach call body: ' + JSON.stringify(stop.body));
  check('StopLeadInCampaign on the paired HeyReach campaign only', !!stop && stop.body.campaignId === Number(HEYREACH_CAMPAIGN) && !!stop.body.leadMemberId && /replay-email-lead/.test(stop.body.leadUrl));
  check('row says stopped', r.rows.length === 1 && r.rows[0].outcome === 'stopped');

  r = await run('20. LIVE mode: the same person replies by email again', () => post('/api/reply', instantlyBody('replay.e@example.com', 'Following up on my note.')));
  check('not stopped twice', r.writes.length === 0 && r.rows.length === 0);

  // A link whose pair is no longer on the allowlist is inert, even in live mode.
  process.env.CROSS_CHANNEL_PAIRS = `${OTHER_PAIR.instantly}:${OTHER_PAIR.heyreach}`;
  const offList = JSON.parse(JSON.stringify(pA)); (offList.data || offList).conversation_id = 'conv-offlist';
  r = await run('21. LIVE mode, pair removed from the allowlist: LinkedIn reply from a linked person', () => post('/api/heyreach/webhook', offList));
  check('nothing stopped, no vendor calls', r.http.status === 200 && r.writes.length === 0 && r.calls.length === 0 && !r.rows.some(x => x.outcome === 'stopped'));

  server.close();
  quiet.log(`\n${failures ? `FAILED: ${failures} check(s) did not pass` : 'ALL CHECKS PASSED'}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { unmute(); console.error('Replay crashed:', e); process.exit(1); });
