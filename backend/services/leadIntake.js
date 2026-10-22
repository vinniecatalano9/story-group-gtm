// services/leadIntake.js — "New Lead" emails start the ad lead cadence on their own (Vincent, 10/22).
//
// Runs first thing in the cadence's 10-minute tick. Every "New Lead" email in
// vincent@storygroup.io (not from Vincent) becomes a row in the ad leads sheet
// (Channel ad/form, Lead Status complete, Assigned Rep Vincent; Notes never
// written), then is imported, Clearout-checked and tagged, so the same tick
// queues the Email 1 card (or the intro text for a texts-only lead).
//
// Each email is handled once: lead_intake/{sha1 of Message-ID} is claimed
// before anything is written. A lead already in the sheet (any rep's row) or
// in the cadence, by email or phone, isn't added again. Emails from before
// the first run (cadence_meta/lead_intake.since) are never processed.
// No email and no textable phone: a Telegram ping, nothing added.

const crypto = require('crypto');

const INTAKE_LOOKBACK_MS = 30 * 6e4; // first run also takes the last 30 minutes
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TEST_EMAIL = /@(storygroup\.io|example\.(com|net|org))$|\.(test|invalid|example)$/i;

function db() { return require('./db').db; }
const intakeCol = () => db().collection('lead_intake');
const metaDoc = () => db().collection('cadence_meta').doc('lead_intake');
const idFor = mid => crypto.createHash('sha1').update(String(mid)).digest('hex');
const toDate = v => (v ? (v.toDate ? v.toDate() : new Date(v)) : null);

// ── Parsing ──────────────────────────────────────────────────────────────────

/** "Key: value" lines, keys lowercased; the first non-empty value wins. */
function formFields(body) {
  const out = {};
  for (const line of String(body || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][\w '’?/()-]{0,80}?)\s*:[ \t]*(.*?)\s*$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (!out[k]) out[k] = m[2].replace(/[<>"]/g, '').trim();
  }
  return out;
}

function get(f, ...res) {
  for (const re of res) {
    const k = Object.keys(f).find(key => re.test(key) && f[key]);
    if (k) return f[k];
  }
  return '';
}

/** One New Lead email -> the lead's fields. Same email/name rules as the old Apps Script. */
function parseLeadEmail(msg) {
  const { toE164 } = require('./ringcentral');
  const body = String(msg.body || '');
  const f = formFields(body);
  const email = ((body.match(/E-?mail(?: Address)?:[^\n@]*?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i) || [])[1] || '').toLowerCase();
  const first = get(f, /^first name$/, /^first$/);
  const last = get(f, /^last name$/, /^last$/);
  const full = get(f, /^full name$/) || [first, last].filter(Boolean).join(' ') || get(f, /^name$/);
  const phoneRaw = get(f, /phone/, /mobile/, /\bcell\b/);
  return {
    full_name: full,
    first_name: first || full.split(/\s+/)[0] || '',
    last_name: last || full.split(/\s+/).slice(1).join(' '),
    email: EMAIL_RE.test(email) ? email : '',
    phone_raw: phoneRaw,
    phone: toE164(phoneRaw),
    role: get(f, /role/, /describes/, /^title$/, /position/),
    frustration: get(f, /frustrat/, /challenge/, /struggl/),
    company: get(f, /company/, /business/, /organi[sz]ation/),
    ad: /becomeimpossibletoignore/i.test(msg.from || ''),
  };
}

// A public form: never let a value become a sheet formula.
const cell = v => (/^[=+\-@]/.test(String(v || '')) ? `'${v}` : String(v || ''));

/** The A:H cells for the new row. */
function rowCells(p) {
  return [
    cell(p.full_name),
    p.phone ? p.phone.replace(/^\+/, '') : cell(p.phone_raw), // digits, like the rows already there
    p.email,
    cell(p.role), cell(p.frustration),
    'ad/form', 'complete', process.env.AD_LEADS_REP || 'Vincent',
  ];
}

// ── Deciding ─────────────────────────────────────────────────────────────────

/** Everything already in the sheet (every rep's rows) and the cadence, for dedupe. */
async function known() {
  const { toE164 } = require('./ringcentral');
  const { rows, header } = await require('./adLeadsSheet').readRows();
  const repCol = header.findIndex(h => /assigned|rep\b/i.test(String(h)));
  const sheet = rows.map(r => ({ where: `sheet row ${r.row}${repCol >= 0 && r.raw[repCol] ? ` (${r.raw[repCol]})` : ''}`, email: String(r.raw[2] || '').trim().toLowerCase(), phone: toE164(r.raw[1]) }));
  const leads = (await require('./cadence').listLeads()).map(l => ({ where: `the cadence (${l.state})`, email: EMAIL_RE.test(l.email) ? l.email : '', phone: l.phone || null }));
  return [...sheet, ...leads];
}

/**
 * What to do with one parsed email: { action: 'add' | 'skip' | 'no_channel' | 'duplicate', why }.
 * Email OR phone matching a known lead counts as the same person: a resubmit
 * with a new email must not start a second cadence on the same phone, and a
 * teammate's lead is never touched.
 */
function decide(p, seen) {
  if (p.email && TEST_EMAIL.test(p.email)) return { action: 'skip', why: 'Story Group or test address' };
  if (/^test\b/i.test(p.full_name)) return { action: 'skip', why: 'test submission (name starts with TEST)' };
  if (!p.email && !p.phone) return { action: 'no_channel', why: 'no email and no textable phone' };
  const hit = seen.find(k => (p.email && k.email === p.email) || (p.phone && k.phone === p.phone));
  if (hit) return { action: 'duplicate', why: `already in ${hit.where}${p.email && hit.email === p.email ? '' : ' (same phone)'}` };
  return { action: 'add', cells: rowCells(p) };
}

async function fetchEmails(since) {
  const day = new Date(since.getTime() - 864e5).toISOString().slice(0, 10); // IMAP SINCE is a date
  const r = await require('./cadence').gmailInbox({ op: 'new_leads', since: day });
  if (!r.ok) throw new Error(`IMAP: ${r.error}`);
  return r.messages.filter(m => m.message_id).sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ── The run ──────────────────────────────────────────────────────────────────

async function run() {
  const cadence = require('./cadence');
  const { esc, ping } = cadence;
  const meta = await metaDoc().get();
  let since = meta.exists ? toDate(meta.data().since) : null;
  if (!since) {
    since = new Date(Date.now() - INTAKE_LOOKBACK_MS);
    await metaDoc().set({ since, started_at: new Date() });
  }
  const msgs = (await fetchEmails(since)).filter(m => !m.date || new Date(m.date) >= since);
  const out = { checked: msgs.length, added: [], skipped: [] };
  let seen = null;
  for (const m of msgs) {
    const ref = intakeCol().doc(idFor(m.message_id));
    // Claim it first so a crash after the sheet write can never add the row twice.
    try { await ref.create({ message_id: m.message_id, date: m.date, status: 'claimed', at: new Date() }); } catch { continue; }
    const p = parseLeadEmail(m);
    seen = seen || (await known());
    const d = decide(p, seen);
    const who = esc(p.full_name || p.email || p.phone_raw || '(no name)');
    if (d.action !== 'add') {
      await ref.update({ status: d.action, why: d.why, parsed: p });
      out.skipped.push(`${p.email || p.phone || p.full_name}: ${d.why}`);
      if (d.action === 'no_channel') {
        const found = Object.entries({ name: p.full_name, email: p.email, phone: p.phone_raw, role: p.role, frustration: p.frustration }).filter(([, v]) => v).map(([k, v]) => `${k}: ${esc(v)}`).join('\n') || '(nothing)';
        await ping(`⚠️ New Lead email (${esc(m.date ? new Date(m.date).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : '')} CT) has no email and no textable phone, so nothing was added.\n\n${found}`);
      } else if (d.action === 'duplicate') {
        await ping(`🔁 New Lead email for <b>${who}</b>: ${esc(d.why)}. Nothing added, no new cadence.`);
      }
      continue;
    }
    let row;
    try {
      row = await require('./adLeadsSheet').appendLead(d.cells);
    } catch (e) {
      // Sheet down: release the claim and try again next run.
      await ref.delete().catch(() => {});
      console.warn('[intake] sheet append failed, retrying next run:', e.message);
      out.error = e.message;
      break;
    }
    seen.push({ where: `sheet row ${row} (Vincent)`, email: p.email, phone: p.phone });
    await ref.update({ status: 'appended', sheet_row: row, parsed: p });
    try {
      await cadence.importLeads([{ sheet_row: row, email: p.email, first_name: cap(p.first_name), last_name: p.last_name, phone: p.phone || p.phone_raw, role: p.role, frustration: p.frustration, company: p.company, source: 'New Lead email', rep: process.env.AD_LEADS_REP || 'Vincent', notes: '' }]);
      const key = p.email || `phone:${p.phone}`;
      await cadence.startLead(key);
      const lead = await cadence.getLead(key);
      const c = lead.email_check;
      await ref.update({ status: 'started', lead: key });
      out.added.push(key);
      await ping(`🆕 New ad lead <b>${who}</b> is in sheet row ${row} and the cadence started.\n${[p.email, p.phone, p.role, p.frustration].filter(Boolean).map(esc).join(' · ')}${c ? `\nClearout: ${esc(c.status)}` : ''}\nNext: ${esc(lead.next_touch_label || 'see the Ad Leads page')}`);
    } catch (e) {
      await ref.update({ status: 'start_failed', error: e.message });
      out.skipped.push(`${p.email || p.phone}: start failed (${e.message})`);
      await ping(`⚠️ New ad lead <b>${who}</b> is in sheet row ${row}, but the cadence didn't start: ${esc(e.message)}`);
    }
  }
  return out;
}

const cap = n => (n && n === n.toLowerCase() ? n.charAt(0).toUpperCase() + n.slice(1) : n);

/**
 * What run() would do with the last `last` New Lead emails, ignoring the
 * go-live cutoff and the processed marks. Writes nothing, sends nothing.
 */
async function dryRun({ last = 8, days = 14 } = {}) {
  const msgs = (await fetchEmails(new Date(Date.now() - days * 864e5))).slice(-last);
  const seen = await known();
  const meta = await metaDoc().get();
  const out = [];
  for (const m of msgs) {
    const p = parseLeadEmail(m);
    const d = decide(p, seen);
    const done = await intakeCol().doc(idFor(m.message_id)).get();
    if (d.action === 'add') seen.push({ where: 'an earlier email in this dry run', email: p.email, phone: p.phone });
    out.push({ date: m.date, from: m.from, ...d, parsed: p, already_processed: done.exists ? done.data().status : null });
  }
  return { since: meta.exists ? toDate(meta.data().since) : 'not started (first run takes the last 30 minutes)', emails: out };
}

module.exports = { run, dryRun, parseLeadEmail, decide, rowCells, formFields };
