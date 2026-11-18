#!/usr/bin/env node
/**
 * Rebuild the cross-channel link store from what is actually in Instantly and
 * HeyReach right now. Run it on the VPS (it needs both API keys) after the
 * lead list or the campaign split changes.
 *
 *   node scripts/crosschannel-sync.js <leads.csv> --heyreach-campaign 741119            # report only
 *   node scripts/crosschannel-sync.js <leads.csv> --heyreach-campaign 741119 --apply    # write
 *
 * What it reads (read only): every lead in each Instantly campaign that
 * CROSS_CHANNEL_PAIRS pairs with that HeyReach campaign, and every lead on the
 * HeyReach campaign's list. The CSV supplies the LinkedIn URL, name and
 * company for each email.
 *
 * What it writes (only with --apply, only to Firestore `channel_links`):
 *   - one link per person who is in one of the paired Instantly campaigns and
 *     has a LinkedIn URL, pointing at the campaign they are really in
 *   - `on_linkedin: false` when that person is not on the HeyReach list
 *   - deletes links for this HeyReach campaign that no longer belong (a copy
 *     of every existing link is saved to a backup file first)
 *
 * It never changes anything in Instantly or HeyReach and sends nothing.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { parse } = require('csv-parse/sync');
const cc = require('../services/crossChannel');

const args = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const APPLY = args.includes('--apply');
const HR_CAMPAIGN = String(opt('--heyreach-campaign') || '');
const HR_LIST_ARG = opt('--heyreach-list');
const BACKUP_DIR = opt('--backup-dir') || '/root/backups';
const file = args.find(a => !a.startsWith('--') && ![HR_CAMPAIGN, HR_LIST_ARG, opt('--backup-dir')].includes(a));
if (!file || !HR_CAMPAIGN) {
  console.error('Usage: node scripts/crosschannel-sync.js <leads.csv> --heyreach-campaign <id> [--heyreach-list <id>] [--apply]');
  process.exit(1);
}

const INSTANTLY = 'https://api.instantly.ai/api/v2';
const HEYREACH = 'https://api.heyreach.io/api/public';
const ih = () => ({ Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`, 'Content-Type': 'application/json' });
const hh = () => ({ 'X-API-KEY': process.env.HEYREACH_API_KEY, 'Content-Type': 'application/json' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(url, init, label) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, init);
    if (res.status === 429) { await sleep((i + 1) * 4000); continue; }
    if (!res.ok) throw new Error(`${label} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error(`${label} kept returning 429`);
}

async function instantlyLeads(campaignId) {
  const out = [];
  let after = null;
  for (let page = 0; page < 200; page++) {
    const body = { campaign: campaignId, limit: 100, ...(after ? { starting_after: after } : {}) };
    const j = await call(`${INSTANTLY}/leads/list`, { method: 'POST', headers: ih(), body: JSON.stringify(body) }, 'Instantly leads/list');
    const items = j.items || [];
    // Belt and braces: only count leads Instantly says are in this campaign.
    out.push(...items.filter(l => String(l.campaign || '').toLowerCase() === campaignId));
    if (!j.next_starting_after || !items.length) break;
    after = j.next_starting_after;
  }
  return out;
}

async function heyreachListLeads(listId) {
  const out = [];
  for (let offset = 0; offset < 20000; offset += 100) {
    const j = await call(`${HEYREACH}/list/GetLeadsFromList`, { method: 'POST', headers: hh(), body: JSON.stringify({ listId: Number(listId), offset, limit: 100 }) }, 'HeyReach GetLeadsFromList');
    const items = j.items || [];
    out.push(...items);
    if (!items.length || out.length >= Number(j.totalCount || 0)) break;
  }
  return out;
}

const pick = (row, names) => { for (const n of names) if (row[n] != null && String(row[n]).trim()) return String(row[n]).trim(); return ''; };
const initials = (f, l) => `${(f || '?')[0]}. ${(l || '?')[0]}.`;
const sample = (arr, n = 8) => arr.slice(0, n).join(', ') + (arr.length > n ? `, and ${arr.length - n} more` : '');

(async () => {
  const pairs = cc.pairs().filter(p => p.heyreach === HR_CAMPAIGN);
  if (!pairs.length) throw new Error(`No pair in CROSS_CHANNEL_PAIRS uses HeyReach campaign ${HR_CAMPAIGN}`);

  // --- CSV ---
  const csv = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
  const byEmail = new Map();
  for (const r of csv) {
    const email = cc.cleanEmail(pick(r, ['email', 'Email']));
    if (email) byEmail.set(email, r);
  }

  // --- live Instantly ---
  const live = new Map(); // email -> { campaign, id }
  const perCampaign = {};
  const inTwo = [];
  for (const p of pairs) {
    const leads = await instantlyLeads(p.instantly);
    perCampaign[p.instantly] = leads.length;
    for (const l of leads) {
      const email = cc.cleanEmail(l.email);
      if (!email) continue;
      if (live.has(email)) inTwo.push(email);
      live.set(email, { campaign: p.instantly, id: l.id, first: l.first_name || '', last: l.last_name || '', company: l.company_name || '' });
    }
  }

  // --- live HeyReach list ---
  let listId = HR_LIST_ARG;
  if (!listId) {
    const c = await call(`${HEYREACH}/campaign/GetById?campaignId=${HR_CAMPAIGN}`, { headers: hh() }, 'HeyReach campaign/GetById');
    listId = c.linkedInUserListId;
  }
  const hrLeads = await heyreachListLeads(listId);
  const hrKeys = new Set(hrLeads.map(l => cc.linkedinKey(l.profileUrl)).filter(Boolean));
  const hrNames = new Map(); // nameKey -> [companyName]
  for (const l of hrLeads) {
    const nk = cc.nameKey(l.firstName, l.lastName);
    if (nk) hrNames.set(nk, [...(hrNames.get(nk) || []), l.companyName || '']);
  }
  const onHeyreach = (url, first, last, companies) => {
    if (hrKeys.has(cc.linkedinKey(url))) return 'url';
    const cos = hrNames.get(cc.nameKey(first, last)) || [];
    return cos.some(c => companies.some(mine => cc.sameCompany(mine, c))) ? 'name' : '';
  };

  // --- desired links ---
  const desired = new Map(); // link id -> doc
  const notes = { instantlyNotInCsv: [], noUrl: [], notOnLinkedin: [], csvCampaignDiffers: [], matchedByNameOnly: [] };
  const now = new Date();
  for (const [email, l] of live) {
    const r = byEmail.get(email);
    if (!r) { notes.instantlyNotInCsv.push(initials(l.first, l.last)); continue; }
    const url = pick(r, ['linkedin_url', 'linkedinUrl', 'LinkedIn URL', 'person_linkedin_url']);
    const first = pick(r, ['firstName', 'first_name']);
    const last = pick(r, ['lastName', 'last_name']);
    const company = pick(r, ['companyName', 'company', 'company_name']);
    const companyAlt = pick(r, ['companyName_raw']);
    const key = cc.linkedinKey(url);
    if (!key) { notes.noUrl.push(initials(first, last)); continue; }
    const how = onHeyreach(url, first, last, [company, companyAlt].filter(Boolean));
    if (!how) notes.notOnLinkedin.push(initials(first, last));
    if (how === 'name') notes.matchedByNameOnly.push(initials(first, last));
    desired.set(cc.linkId(l.campaign, HR_CAMPAIGN, email), {
      email,
      linkedin_url: url,
      linkedin_key: key,
      first_name: first,
      last_name: last,
      name_key: cc.nameKey(first, last),
      company,
      company_key: cc.companyKey(company),
      ...(companyAlt && companyAlt !== company ? { company_alt: companyAlt } : {}),
      instantly_campaign_id: l.campaign,
      heyreach_campaign_id: HR_CAMPAIGN,
      instantly_lead_id: l.id,
      on_linkedin: !!how,
      source: 'sync',
      updated_at: now,
    });
  }

  // CSV rows that look email-ready but are not in any paired Instantly campaign.
  const csvEmailReady = [...byEmail.entries()].filter(([, r]) => pick(r, ['email_status']) === 'valid' && /^(google|microsoft)$/i.test(pick(r, ['email_provider'])));
  const csvNotInInstantly = csvEmailReady.filter(([e]) => !live.has(e)).map(([, r]) => initials(pick(r, ['firstName']), pick(r, ['lastName'])));
  // HeyReach list members that the CSV does not have.
  const csvKeys = new Set(csv.map(r => cc.linkedinKey(pick(r, ['linkedin_url']))).filter(Boolean));
  const hrNotInCsv = hrLeads.filter(l => !csvKeys.has(cc.linkedinKey(l.profileUrl))).map(l => initials(l.firstName, l.lastName));
  // CSV LinkedIn-eligible rows missing from the HeyReach list.
  const csvLiEligible = csv.filter(r => pick(r, ['linkedin_url']) && !pick(r, ['heyreach_existing_campaign']) && pick(r, ['lastName']));
  const csvLiNotOnList = csvLiEligible.filter(r => !onHeyreach(pick(r, ['linkedin_url']), pick(r, ['firstName']), pick(r, ['lastName']), [pick(r, ['companyName']), pick(r, ['companyName_raw'])].filter(Boolean))).map(r => initials(pick(r, ['firstName']), pick(r, ['lastName'])));

  // --- existing links ---
  const { db } = require('../services/db');
  const col = db.collection(cc.LINKS);
  const existing = (await col.where('heyreach_campaign_id', '==', HR_CAMPAIGN).get()).docs;
  const stale = existing.filter(d => !desired.has(d.id));
  const fresh = [...desired.keys()].filter(id => !existing.some(d => d.id === id));

  // --- report ---
  console.log(`Cross-channel link sync (${APPLY ? 'APPLY' : 'report only'})`);
  console.log(`CSV: ${csv.length} rows, ${byEmail.size} with an email, ${csvEmailReady.length} email-ready (valid, Google or Microsoft)`);
  console.log(`HeyReach campaign ${HR_CAMPAIGN}, list ${listId}: ${hrLeads.length} leads`);
  console.log('Instantly campaigns paired with it:');
  for (const p of pairs) {
    const links = [...desired.values()].filter(d => d.instantly_campaign_id === p.instantly);
    console.log(`  ${p.instantly}: ${perCampaign[p.instantly]} leads live -> ${links.length} links (${links.filter(d => d.on_linkedin).length} also on the LinkedIn list, ${links.filter(d => !d.on_linkedin).length} email only)`);
  }
  console.log(`Links wanted: ${desired.size}. Already there: ${existing.length - stale.length}. New: ${fresh.length}. Stale to delete: ${stale.length}.`);
  const line = (label, arr) => console.log(`  ${label}: ${arr.length}${arr.length ? ` (${sample(arr)})` : ''}`);
  console.log('Checks:');
  line('In two paired Instantly campaigns at once', inTwo.map(e => e.replace(/^(.{2}).*@/, '$1***@')));
  line('In Instantly but not in the CSV (no link possible)', notes.instantlyNotInCsv);
  line('Email-ready in the CSV but not in any paired Instantly campaign', csvNotInInstantly);
  line('In Instantly with no LinkedIn URL (no link, email only)', notes.noUrl);
  line('In Instantly, has a LinkedIn URL, not on the HeyReach list (link kept, on_linkedin false)', notes.notOnLinkedin);
  line('On the HeyReach list by name and company only, URL differs', notes.matchedByNameOnly);
  line('On the HeyReach list but not in the CSV', hrNotInCsv);
  line('LinkedIn-eligible in the CSV but not on the HeyReach list', csvLiNotOnList);

  if (!APPLY) { console.log('Report only: nothing written. Add --apply to write.'); process.exit(0); }

  // --- apply ---
  if (existing.length) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = path.join(BACKUP_DIR, `crosschannel-links-${HR_CAMPAIGN}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backup, JSON.stringify(existing.map(d => ({ id: d.id, ...d.data() })), null, 1), { mode: 0o600 });
    console.log(`Backup of the ${existing.length} existing links: ${backup}`);
  }
  const ops = [
    ...[...desired.entries()].map(([id, data]) => b => b.set(col.doc(id), data, { merge: true })),
    ...stale.map(d => b => b.delete(d.ref)),
  ];
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(op => op(batch));
    await batch.commit();
  }
  const after = (await col.where('heyreach_campaign_id', '==', HR_CAMPAIGN).count().get()).data().count;
  console.log(`Written ${desired.size} links, deleted ${stale.length}. Links for this HeyReach campaign now: ${after}.`);
  process.exit(0);
})().catch(e => { console.error('Sync failed:', e.message); process.exit(1); });
