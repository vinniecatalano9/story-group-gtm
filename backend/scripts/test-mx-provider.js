/**
 * Test for the cold email mail provider gate. Safe to run anywhere:
 * Firestore and the Instantly API are both stubbed, so nothing is written or uploaded.
 *
 *   node scripts/test-mx-provider.js
 *
 * Part 1: the rule table on fixed MX hostnames (no network).
 * Part 2: live MX lookups on real domains.
 * Part 3: the gate inside addLeadsToCampaign, with a fake fetch that records what would be uploaded.
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

  uploaded.length = 0;
  const none = await instantly.addLeadsToCampaign('standard', [leads[2], leads[3]]);
  check('all blocked: nothing uploaded', uploaded.length, 0);
  check('all blocked: returns null so the lead is not marked emailed', none, null);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
