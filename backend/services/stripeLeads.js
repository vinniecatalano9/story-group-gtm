// services/stripeLeads.js — tidy the leads Nutshell's Stripe integration makes (Vincent, 10/28).
//
// Every Stripe payment becomes a Nutshell lead under Aaron: open in Default
// Pipeline / Qualify, no owner, no company, described only as "- <code>" (the
// Stripe customer's 8-character invoice prefix), tagged "Stripe Payment".
// Vincent can't change that, so this job cleans them up after they land:
//   - a known texting code: assign to Vincent, rename "<Client> Texting
//     (Stripe <code>)", link the client's company, close Won
//   - a known PR code (Aaron's retainers): left alone
//   - an unknown code: one Telegram ping asking texting or PR, then left alone
//     until Vincent answers through Work Bot (it appends to CODES_FILE)
// No LLM: the code decides, so nothing gets guessed.

const fs = require('fs');

const VINCENT = 3;
const WON = 1;
const TAG = 'Stripe Payment';
const CODES_FILE = () => process.env.STRIPE_CODES_FILE || '/home/worker/gtm-feed/stripe-codes.txt';

// Known Stripe codes (from the 10/28 cleanup). account = Nutshell account id,
// contact = the client's usual contact, so a second one Stripe makes gets flagged.
const KNOWN = {
  YJPXJ9CU: { kind: 'texting', client: 'Miami-Dade County GOP', account: 310, contact: 573 },
  A78D3YCY: { kind: 'texting', client: 'We Win Races', account: 326, contact: 607 },
  RZMKIVMA: { kind: 'texting', client: 'Bill Money', contact: 604 },
  JWUBATT9: { kind: 'texting', client: 'Rob Ashe', contact: 456 },
  CNV8RQ1K: { kind: 'texting', client: 'Brian Jinks', contact: 640 },
  LTKZ2QZQ: { kind: 'texting', client: 'Brandon Barrera', contact: 620 },
  ARPFWWP4: { kind: 'pr', client: 'APIS Services' },
  SLZKGJXU: { kind: 'pr', client: 'Gene Boykin' },
  '8AMV8UTO': { kind: 'pr', client: 'Andy Robbins' },
};

const FILE_HEADER = `# Stripe codes Vincent sorted on Telegram. The backend reads this every 10 minutes.
# One per line:  CODE texting Client Name   or   CODE pr
`;

/** KNOWN plus Work Bot's file. A file line wins, so Vincent can correct a code. */
function codeBook() {
  const book = { ...KNOWN };
  let text = '';
  try { text = fs.readFileSync(CODES_FILE(), 'utf8'); } catch { return book; }
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^([A-Z0-9]{8})\s+(texting|pr)\b\s*(.*)$/i);
    if (!m) continue;
    const code = m[1].toUpperCase(), kind = m[2].toLowerCase(), client = m[3].trim();
    if (kind === 'texting' && !client) continue;
    book[code] = { ...(book[code] || {}), kind, ...(client ? { client } : {}) };
  }
  return book;
}

function ensureCodesFile() {
  if (fs.existsSync(CODES_FILE())) return;
  const p = require('path').relative(process.env.WORKBOT_FEED_DIR || '/home/worker/gtm-feed', CODES_FILE());
  require('./telegram').dropForWorkBot(p, FILE_HEADER);
}

const codeOf = l => ((l.description || '').match(/-\s*([A-Z0-9]{8})\s*$/) || [])[1] || null;
const isStripe = l => (l.tags || []).includes(TAG) && !!codeOf(l);
const money = v => `$${Number((v && v.amount) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const contactName = c => (c && (c.name && (c.name.displayName || c.name))) || 'no contact';

async function accountFor(entry) {
  if (entry.account) return entry.account;
  if (!entry.client) return null;
  const hits = await require('./nutshell').call('searchAccounts', { string: entry.client, limit: 10 });
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hit = (hits || []).find(a => norm(a.name) === norm(entry.client));
  return hit ? hit.id : null; // never creates a company from a guess
}

/** Assign, rename, link, close Won. Returns a line for the Telegram summary. */
async function cleanTexting(l, code, entry, { dryRun }) {
  const nutshell = require('./nutshell');
  const description = `${entry.client} Texting (Stripe ${code})`;
  const account = await accountFor(entry);
  const contacts = (l.contacts || []).map(c => c.id);
  const odd = entry.contact && contacts.length && !contacts.includes(entry.contact)
    ? ` Stripe attached contact ${contacts.join(', ')} (${contactName(l.contacts[0])}), not the usual ${entry.contact}: maybe a duplicate to merge.` : '';
  if (!dryRun) {
    const lead = { description, assignee: { entityType: 'Users', id: VINCENT } };
    if (account) lead.accounts = [{ id: account }];
    const fresh = await nutshell.call('getLead', { leadId: l.id });
    await nutshell.call('editLead', { leadId: l.id, rev: fresh.rev, lead }, { attempts: 1 });
    await nutshell.closeLead(l.id, WON);
  }
  return `${entry.client} ${money(l.value)} (lead ${l.id}) closed Won.${odd}`;
}

let running = false;

/**
 * One pass over open Stripe leads. { dryRun } reads only: no Nutshell edits,
 * no Firestore, no Telegram. Returns what it did (or would do).
 */
async function run({ dryRun = false, limit = 60 } = {}) {
  const nutshell = require('./nutshell');
  if (!nutshell.isConfigured()) return { skipped: 'Nutshell not set up' };
  if (running) return { skipped: 'already running' };
  running = true;
  const out = { cleaned: [], pinged: [], pr: [], waiting: [], errors: [] };
  try {
    if (!dryRun) ensureCodesFile();
    const book = codeBook();
    const open = await nutshell.call('findLeads', { query: { status: 0 }, orderBy: 'createdTime', orderDirection: 'DESC', limit, stubResponses: false }) || [];
    const { db } = require('./db');
    const seen = db.collection('stripe_leads');

    for (const l of open.filter(isStripe)) {
      const code = codeOf(l);
      const entry = book[code];
      try {
        if (entry && entry.kind === 'texting') {
          const line = await cleanTexting(l, code, entry, { dryRun });
          out.cleaned.push(line);
          if (!dryRun) await seen.doc(String(l.id)).set({ status: 'cleaned', code, client: entry.client, amount: (l.value && l.value.amount) || null, at: new Date() }, { merge: true });
          continue;
        }
        if (entry && entry.kind === 'pr') { out.pr.push(`${l.id} ${entry.client || code}`); continue; }

        // Unknown code: ping once, then wait for Vincent's answer in CODES_FILE.
        const doc = dryRun ? null : await seen.doc(String(l.id)).get();
        if (doc && doc.exists && doc.data().status === 'pinged') { out.waiting.push(`${l.id} ${code}`); continue; }
        const who = contactName((l.contacts || [])[0]);
        out.pinged.push(`${l.id} ${code} ${money(l.value)} ${who}`);
        if (dryRun) continue;
        const tg = require('./telegram');
        await tg.sendTelegram(`New Stripe payment in Nutshell I don't recognize: ${money(l.value)} from ${who}, Stripe code ${code} (lead ${l.id}).\n\nTexting or PR? Tell Work Bot "${code} is texting for <client>" or "${code} is PR". Texting ones get assigned to you, renamed and closed Won within 10 minutes. PR ones are left alone.`);
        tg.noteForWorkBot(`backend asked Vincent about Stripe lead ${l.id} (code ${code}, ${money(l.value)}, ${who}). When he answers, append one line to ~/gtm-feed/stripe-codes.txt: "${code} texting <Client Name>" if it's texting, "${code} pr" if it's PR. The backend picks it up within 10 minutes; nothing else to do.`);
        await seen.doc(String(l.id)).set({ status: 'pinged', code, amount: (l.value && l.value.amount) || null, contact: who, at: new Date() }, { merge: true });
      } catch (e) {
        out.errors.push(`${l.id}: ${e.message}`);
        console.warn(`[stripe-leads] lead ${l.id} failed: ${e.message}`);
      }
    }

    if (!dryRun && out.cleaned.length) {
      const tg = require('./telegram');
      await tg.sendTelegram(`Stripe texting payment${out.cleaned.length > 1 ? 's' : ''} cleaned up in Nutshell:\n${out.cleaned.map(s => `• ${s}`).join('\n')}`, { silent: true })
        .catch(e => console.warn('[stripe-leads] Telegram summary failed:', e.message));
    }
    return out;
  } finally {
    running = false;
  }
}

module.exports = { run, codeBook, KNOWN };
