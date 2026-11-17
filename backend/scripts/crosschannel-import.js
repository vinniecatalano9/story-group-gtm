#!/usr/bin/env node
/**
 * Fill the cross-channel link store from a lead CSV. Writes only to the
 * Firestore collection `channel_links`. It uploads nothing to Instantly or
 * HeyReach and sends nothing.
 *
 *   node scripts/crosschannel-import.js <leads.csv> --dry      # count only
 *   node scripts/crosschannel-import.js <leads.csv>            # save
 *   node scripts/crosschannel-import.js <leads.csv> --pair <instantlyCampaignId>:<heyreachCampaignId>
 *
 * Columns it reads (any of): email | linkedin_url, linkedinUrl, "LinkedIn URL",
 * person_linkedin_url | firstName, first_name | lastName, last_name |
 * companyName, company, company_name. Rows without both an email and a
 * LinkedIn profile URL are skipped and counted. Safe to run twice.
 *
 * Without --pair it uses CROSS_CHANNEL_PAIRS from .env when that holds exactly
 * one pair; otherwise it uses the video test pair below.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { parse } = require('csv-parse/sync');

const VIDEO_TEST_PAIR = '3652a64b-15c2-4eb4-bc64-cb43ff1808a3:741119';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const pairArg = args.includes('--pair') ? args[args.indexOf('--pair') + 1] : null;
const file = args.find(a => !a.startsWith('--') && a !== pairArg);
if (!file) { console.error('Usage: node scripts/crosschannel-import.js <leads.csv> [--dry] [--pair instantlyId:heyreachId]'); process.exit(1); }

if (pairArg) process.env.CROSS_CHANNEL_PAIRS = pairArg;
const cc = require('../services/crossChannel');
if (cc.pairs().length !== 1) process.env.CROSS_CHANNEL_PAIRS = VIDEO_TEST_PAIR;
const pair = cc.pairs()[0];

const pick = (row, names) => { for (const n of names) if (row[n] != null && String(row[n]).trim()) return String(row[n]).trim(); return ''; };

(async () => {
  const records = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
  const rows = records.map(r => ({
    email: pick(r, ['email', 'Email', 'work_email']),
    linkedinUrl: pick(r, ['linkedin_url', 'linkedinUrl', 'LinkedIn URL', 'person_linkedin_url', 'Person Linkedin Url', 'profileUrl', 'profile_url']),
    firstName: pick(r, ['firstName', 'first_name', 'First Name']),
    lastName: pick(r, ['lastName', 'last_name', 'Last Name']),
    company: pick(r, ['companyName', 'company', 'company_name', 'Company', 'Company Name']),
  }));
  const usable = rows.filter(r => cc.cleanEmail(r.email) && cc.linkedinKey(r.linkedinUrl));
  console.log(`File: ${file}`);
  console.log(`Pair: Instantly ${pair.instantly} <-> HeyReach ${pair.heyreach}`);
  console.log(`Rows: ${rows.length}. With both an email and a LinkedIn URL: ${usable.length}. Skipped: ${rows.length - usable.length}.`);
  if (dry) { console.log('Dry run: nothing saved.'); process.exit(0); }
  const out = await cc.upsertLinks(rows, { instantlyCampaignId: pair.instantly, heyreachCampaignId: pair.heyreach, source: 'csv' });
  const reasons = {};
  for (const s of out.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
  console.log(`Saved ${out.saved} links. Skipped ${out.skipped.length}${out.skipped.length ? ': ' + JSON.stringify(reasons) : ''}.`);
  process.exit(0);
})().catch(e => { console.error('Import failed:', e.message); process.exit(1); });
