/**
 * Test for the cold email mail provider gate. Safe to run anywhere:
 * Firestore, Clearout and the Instantly API are all stubbed, so nothing is written or uploaded.
 *
 *   node scripts/test-mx-provider.js
 *
 * Part 1: the rule table on fixed MX hostnames (no network).
 * Part 2: live MX lookups on real domains.
 * Part 3: the gate inside addLeadsToCampaign, with a fake fetch that records what would be uploaded.
 * Part 4: the Clearout half of the gate, with Clearout stubbed (no real checks are spent).
 */
const path = require('path');
const mx = require('../lib/mxProvider');

let failed = 0;
function check(label, got, want) {
  const pass = got === want;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: ${got}${pass ? '' : ` (wanted ${want})`}`);
}

async function main() {
  console.log('\n1. Rule table (no network)');
  const table = [
    [['aspmx.l.google.com', 'alt1.aspmx.l.google.com'], 'Google'],
    [['acme-com.mail.protection.outlook.com'], 'Microsoft'],
    [['mx1-us1.ppe-hosted.com', 'mx2-us1.ppe-hosted.com'], 'Proofpoint'],
    [['mxa-00614f02.gslb.pphosted.com'], 'Proofpoint'],
    [['us-smtp-inbound-1.mimecast.com'], 'Mimecast'],
    [['d12345a.ess.barracudanetworks.com'], 'Barracuda'],
    [['mx-01-us-west-2.prod.hydra.sophos.com'], 'Sophos'],
    [['mailstore1.secureserver.net'], 'GoDaddy'],
    [['mail.smalltownhost.net'], 'Other'],
    [[], mx.NO_MX],
  ];
  for (const [hosts, want] of table) {
    const got = mx.classify(hosts);
    check(`${hosts[0] || '(no hosts)'} -> ${want}, ok=${mx.isOkProvider(want)}`, got, want);
  }
  check('only Google and Microsoft are ok', mx.RULES.map(r => r[0]).filter(mx.isOkProvider).join(','), 'Google,Microsoft');

  console.log('\n2. Live MX lookups');
  const live = [
    ['storygroup.io', 'Google', true],
    ['microsoft.com', 'Microsoft', true],
    ['nasdaq.com', 'Proofpoint', false],
    ['example.com', mx.NO_MX, false], // publishes a null MX ("0 .")
    ['no-such-domain-sg-test-9f3a7c.com', mx.NO_MX, false],
  ];
  for (const [domain, wantProvider, wantOk] of live) {
    const r = await mx.checkDomain(domain);
    check(`${domain} provider (mx: ${r.mx || 'none'})`, r.provider, wantProvider);
    check(`${domain} ok`, r.ok, wantOk);
  }
  const bad = await mx.checkEmail('not-an-email');
  check('address with no domain is not ok', bad.ok, false);

  console.log('\n3. Gate inside addLeadsToCampaign (Firestore and Instantly stubbed)');
  const marks = {};
  const logs = [];
  const dbPath = require.resolve(path.join(__dirname, '..', 'services', 'db.js'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      updateLead: async (id, data) => { marks[id] = { ...(marks[id] || {}), ...data }; },
      addLog: async (type, data) => { logs.push({ type, ...data }); },
    },
  };
  // Clearout stub: canned answers by address, and a count of calls made.
  const clearoutCalls = [];
  const canned = { 'e@storygroup.io': 'invalid', 'f@storygroup.io': 'catch_all', 'g@storygroup.io': 'ERROR' };
  const clearoutPath = require.resolve(path.join(__dirname, '..', 'services', 'clearout.js'));
  require.cache[clearoutPath] = {
    id: clearoutPath, filename: clearoutPath, loaded: true,
    exports: {
      verifyEmail: async (email, source) => {
        clearoutCalls.push(`${email}|${source}`);
        const status = canned[email] || 'valid';
        if (status === 'ERROR') throw new Error('Clearout 402: out of credits');
        return { status, sub_status: null, desc: '', safe_to_send: status === 'valid' ? 'yes' : 'no', at: new Date() };
      },
    },
  };
  const uploaded = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    uploaded.push(...(body.leads || []).map(l => l.email));
    return { ok: true, status: 200, json: async () => ({ stubbed: true }) };
  };
  process.env.INSTANTLY_CAMPAIGN_STANDARD = 'test-campaign-not-real';
  process.env.INSTANTLY_API_KEY = 'test-key-not-real';

  const instantly = require('../services/instantly');
  const leads = [
    { id: 'L1', email: 'a@storygroup.io', first_name: 'A', company_name: 'Google hosted' },
    { id: 'L2', email: 'b@microsoft.com', first_name: 'B', company_name: 'Microsoft hosted' },
    { id: 'L3', email: 'c@nasdaq.com', first_name: 'C', company_name: 'Proofpoint hosted' },
    { id: 'L4', email: 'd@example.com', first_name: 'D', company_name: 'No MX' },
  ];
  const result = await instantly.addLeadsToCampaign('standard', leads);
  check('uploaded emails', uploaded.join(','), 'a@storygroup.io,b@microsoft.com');
  check('result is truthy when something uploads', !!result, true);
  check('L1 cold_email_blocked', marks.L1.cold_email_blocked, false);
  check('L3 cold_email_blocked', marks.L3.cold_email_blocked, true);
  check('L3 email_provider', marks.L3.email_provider, 'Proofpoint');
  check('L4 cold_email_blocked', marks.L4.cold_email_blocked, true);
  check('L4 email_provider', marks.L4.email_provider, mx.NO_MX);
  check('blocked count logged', logs[0] && logs[0].count, 2);
  check('Clearout ran only on leads that passed the provider check', clearoutCalls.join(','), 'a@storygroup.io|cold_email_gate,b@microsoft.com|cold_email_gate');
  check('L1 email_check saved', marks.L1.email_check && marks.L1.email_check.status, 'valid');

  console.log('\n4. Clearout part of the gate (stubbed)');
  uploaded.length = 0;
  clearoutCalls.length = 0;
  const report = {};
  await instantly.addLeadsToCampaign('standard', [
    { id: 'L5', email: 'e@storygroup.io' }, // Clearout invalid
    { id: 'L6', email: 'f@storygroup.io' }, // Clearout catch_all
    { id: 'L7', email: 'g@storygroup.io' }, // Clearout down or out of credits
    { id: 'L8', email: 'h@storygroup.io', email_check: { status: 'valid', at: new Date(Date.now() - 5 * 86400000) } }, // fresh saved check
    { id: 'L9', email: 'i@storygroup.io', email_check: { status: 'valid', at: new Date(Date.now() - 60 * 86400000) } }, // stale saved check
    { id: 'L10', email: 'j@storygroup.io', email_check: { status: 'invalid', at: new Date() } }, // fresh saved invalid
  ], report);
  check('only Clearout-valid leads uploaded', uploaded.join(','), 'h@storygroup.io,i@storygroup.io');
  check('L5 blocked (invalid)', marks.L5.cold_email_blocked, true);
  check('L6 blocked (catch_all)', marks.L6.cold_email_blocked, true);
  check('L7 blocked (Clearout failed)', marks.L7.cold_email_blocked, true);
  check('L7 error saved', marks.L7.email_check_error, 'Clearout 402: out of credits');
  check('L8 fresh saved check reused, no Clearout call', clearoutCalls.some(c => c.startsWith('h@')), false);
  check('L9 stale saved check re-verified', clearoutCalls.some(c => c.startsWith('i@')), true);
  check('L10 saved invalid blocks without a call', marks.L10.cold_email_blocked && !clearoutCalls.some(c => c.startsWith('j@')), true);
  check('report lists the blocked leads', report.blocked.map(b => b.lead_id).join(','), 'L5,L6,L7,L10');
  check('by_reason logged', JSON.stringify(logs[logs.length - 1].by_reason), '{"Clearout invalid":2,"Clearout catch_all":1,"Clearout check failed":1}');

  uploaded.length = 0;
  const none = await instantly.addLeadsToCampaign('standard', [leads[2], leads[3]]);
  check('all blocked: nothing uploaded', uploaded.length, 0);
  check('all blocked: returns null so the lead is not marked emailed', none, null);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
