// services/leadIntake.js — "New Lead" emails start the ad lead cadence on their own (Vincent, 10/22).
//
// Runs every minute on its own cron (cadence.runIntake, under the cadence's
// lock). Every "New Lead" email from the form (lc.becomeimpossibletoignore.com)
// in vincent@storygroup.io whose Nutshell lead is Vincent's (round robin,
// 10/23; see "Nutshell owner") becomes a row in the ad leads sheet
// (Channel ad/form, Lead Status complete, Assigned Rep Vincent; Notes never
// written), then is imported, Clearout-checked and tagged, and its Email 1
// card (or the intro text for a texts-only lead) is queued right then.
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
// Message-IDs this process already handled: IMAP skips their bodies, Firestore isn't asked again.
const handled = new Set();
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
  const r = await require('./cadence').gmailInbox({ op: 'new_leads', since: day, skip: [...handled] });
  if (!r.ok) throw new Error(`IMAP: ${r.error}`);
  return r.messages.filter(m => m.message_id).sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ── Nutshell owner ───────────────────────────────────────────────────────────
// Nutshell round-robins new leads to the Sales Team (10/23). The form makes
// the Nutshell lead seconds before its New Lead email lands, so the intake
// looks that lead up and only works Vincent's: someone else's gets a Telegram
// line and nothing else. With no owner yet it checks again every minute; after
// OWNER_WAIT_MS it falls back to the old rule (Vincent's), and says so.

const OWNER_WAIT_MS = 15 * 6e4;
const ME = () => Number(process.env.NUTSHELL_USER_ID || 3); // Vincent
const KICKSTART_STAGESET = 5; // Kickstart / Diagnostic Pipeline
// Only the form's own emails are leads. Nutshell's "New Lead–1199" notices
// (a Stripe invoice deal, 10/23) and anything else with the subject aren't.
const isFormEmail = m => new RegExp(process.env.AD_FORM_SENDER || 'becomeimpossibletoignore\\.com', 'i').test(m.from || '');
const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const firstName = n => String(n || '').trim().split(/\s+/)[0];

/** { status: 'mine' | 'theirs' | 'unassigned' | 'unknown', lead_id, owner } for a form lead. */
async function nutshellOwner(p, at) {
  const nutshell = require('./nutshell');
  if (!nutshell.isConfigured()) return { status: 'unknown', why: 'Nutshell not set up' };
  const t = new Date(at || Date.now()).getTime();
  const recent = (await nutshell.call('findLeads', { query: { status: 0 }, orderBy: 'createdTime', orderDirection: 'DESC', limit: 40, stubResponses: false }) || [])
    .filter(l => Math.abs(new Date(l.createdTime) - t) < OWNER_WAIT_MS);
  const name = norm(p.full_name);
  let hits = name ? recent.filter(l => norm(l.description).includes(name) || (l.contacts || []).some(c => norm(c.name) === name)) : [];
  // No name match: check the contacts' email and phone on leads made within 3 minutes.
  if (!hits.length) {
    for (const l of recent.filter(x => Math.abs(new Date(x.createdTime) - t) < 3 * 6e4)) {
      for (const c of (l.contacts || []).slice(0, 2)) {
        const k = await contactKeys(c.id).catch(() => ({}));
        if ((p.email && k.email === p.email) || (p.phone && k.phone === p.phone)) { hits.push(l); break; }
      }
    }
  }
  if (hits.length !== 1) return { status: 'unknown', why: hits.length ? `${hits.length} Nutshell leads match` : 'no Nutshell lead found' };
  const l = hits[0], a = l.assignee;
  if (!a || a.entityType !== 'Users') return { status: 'unassigned', lead_id: l.id, why: 'not assigned yet' };
  return { status: a.id === ME() ? 'mine' : 'theirs', lead_id: l.id, owner: a.name };
}

/** A Nutshell contact's primary email and E.164 phone. */
async function contactKeys(contactId) {
  const c = await require('./nutshell').call('getContact', { contactId });
  const email = String((c.email && (c.email['--primary'] || Object.values(c.email)[0])) || '').toLowerCase();
  const ph = c.phone && (c.phone['--primary'] || Object.values(c.phone)[0]);
  return { name: c.name || '', email: EMAIL_RE.test(email) ? email : '', phone: (ph && ph.E164) || null, phone_raw: (ph && ph.numberFormatted) || '' };
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
  // IMAP looks back one day past the newer of the cutoff and yesterday: cheap every minute.
  const msgs = (await fetchEmails(new Date(Math.max(since, Date.now() - 864e5)))).filter(m => !m.date || new Date(m.date) >= since);
  const out = { checked: msgs.length, added: [], skipped: [] };
  let seen = null;
  for (const m of msgs) {
    if (handled.has(m.message_id)) continue;
    if (!isFormEmail(m)) { handled.add(m.message_id); continue; }
    const p = parseLeadEmail(m);
    seen = seen || (await known());
    const d = decide(p, seen);
    let owner = null;
    if (d.action === 'add') {
      owner = await nutshellOwner(p, m.date).catch(e => ({ status: 'unknown', why: `Nutshell: ${e.message}` }));
      // No owner yet: leave it unclaimed and look again next minute.
      if ((owner.status === 'unknown' || owner.status === 'unassigned') && Date.now() - new Date(m.date || 0) < OWNER_WAIT_MS) continue;
    }
    const ref = intakeCol().doc(idFor(m.message_id));
    // Claim it first so a crash after the sheet write can never add the row twice.
    try { await ref.create({ message_id: m.message_id, date: m.date, status: 'claimed', at: new Date() }); } catch { handled.add(m.message_id); continue; }
    handled.add(m.message_id);
    const who = esc(p.full_name || p.email || p.phone_raw || '(no name)');
    if (owner && owner.status === 'theirs') {
      await ref.update({ status: 'other_rep', owner: owner.owner, nutshell_lead_id: owner.lead_id, parsed: p });
      out.skipped.push(`${p.email || p.phone}: ${owner.owner}'s lead`);
      await ping(`👥 New ad lead <b>${who}</b> went to ${esc(owner.owner)} in Nutshell. Not added, no cadence.`);
      continue;
    }
    const r = await addLead(p, d, ref, { out, seen, who, owner, source: 'New Lead email', at: m.date });
    if (r === 'retry') { handled.delete(m.message_id); break; }
  }
  await nutshellAssigned(out).catch(e => { out.nutshell_error = e.message; });
  return out;
}

/**
 * Sheet row, import, tag and first card for one lead that's Vincent's.
 * `d` is decide()'s answer; skips and duplicates get their ping here too.
 * Returns 'retry' when the sheet was down (the claim is released).
 */
async function addLead(p, d, ref, { out, seen, who, owner, source, at }) {
  const cadence = require('./cadence');
  const { esc, ping } = cadence;
  if (d.action !== 'add') {
    await ref.update({ status: d.action, why: d.why, parsed: p });
    out.skipped.push(`${p.email || p.phone || p.full_name}: ${d.why}`);
    if (d.action === 'no_channel') {
      const found = Object.entries({ name: p.full_name, email: p.email, phone: p.phone_raw, role: p.role, frustration: p.frustration }).filter(([, v]) => v).map(([k, v]) => `${k}: ${esc(v)}`).join('\n') || '(nothing)';
      await ping(`⚠️ ${esc(source)} (${esc(at ? new Date(at).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : '')} CT) has no email and no textable phone, so nothing was added.\n\n${found}`);
    } else if (d.action === 'duplicate') {
      await ping(`🔁 ${esc(source)} for <b>${who}</b>: ${esc(d.why)}. Nothing added, no new cadence.`);
    }
    return 'skipped';
  }
  let row;
  try {
    row = await require('./adLeadsSheet').appendLead(d.cells);
  } catch (e) {
    // Sheet down: release the claim and try again next run.
    await ref.delete().catch(() => {});
    out.error = `sheet append failed, retrying next run: ${e.message}`; // cron/cadence.js logs it
    return 'retry';
  }
  seen.push({ where: `sheet row ${row} (Vincent)`, email: p.email, phone: p.phone });
  await ref.update({ status: 'appended', sheet_row: row, parsed: p, nutshell_lead_id: (owner && owner.lead_id) || null });
  try {
    await cadence.importLeads([{ sheet_row: row, email: p.email, first_name: cap(p.first_name), last_name: p.last_name, phone: p.phone || p.phone_raw, role: p.role, frustration: p.frustration, company: p.company, source, rep: process.env.AD_LEADS_REP || 'Vincent', notes: '', nutshell_lead_id: owner && owner.lead_id }]);
    const key = p.email || `phone:${p.phone}`;
    await cadence.startLead(key);
    const lead = await cadence.getLead(key);
    const c = lead.email_check;
    out.added.push(key);
    const whose = !owner ? '' : owner.status === 'mine' ? '\nNutshell: assigned to you.' : `\nNutshell: ${esc(owner.why || 'no owner')} after 15 min, so I treated it as yours. Skip the card if it isn't.`;
    await ping(`🆕 New ad lead <b>${who}</b> (${esc(source)}) is in sheet row ${row} and the cadence started.\n${[p.email, p.phone, p.role, p.frustration].filter(Boolean).map(esc).join(' · ')}${c ? `\nClearout: ${esc(c.status)}` : ''}${whose}\nNext: ${esc(lead.next_touch_label || 'see the Ad Leads page')}`);
    // First card now, not on the next tick (speed to lead).
    const q = await cadence.queueDue(key);
    const lag = at ? Math.round((Date.now() - new Date(at)) / 1000) : null;
    await ref.update({ status: 'started', lead: key, queued: q.queued, blocked: q.blocked, card_at: new Date(), seconds_from_email: lag });
    if (q.queued.length) console.log(`[intake] ${key}: ${q.queued.join(', ')} queued ${lag}s after the ${source}`);
  } catch (e) {
    await ref.update({ status: 'start_failed', error: e.message });
    out.skipped.push(`${p.email || p.phone}: start failed (${e.message})`);
    await ping(`⚠️ New ad lead <b>${who}</b> is in sheet row ${row}, but the cadence didn't start: ${esc(e.message)}`);
  }
  return 'added';
}

// ── Leads Nutshell assigns to Vincent ────────────────────────────────────────
// Some round-robin leads never send Vincent a New Lead email (the assessment
// form's go to Annette). Every few minutes: open Kickstart pipeline leads
// assigned to Vincent, made after the first check, that no cadence lead is
// linked to. Each one gets NUTSHELL_WAIT_MS for its form email to arrive and
// claim it; after that its Nutshell contact's email and phone go through the
// same steps (dedupe, sheet row, cadence, first card). Once per Nutshell lead.

const NUTSHELL_WAIT_MS = 20 * 6e4;
const NUTSHELL_EVERY_MS = 3 * 6e4;
let _lastNutshell = 0;
const nutshellMeta = () => db().collection('cadence_meta').doc('nutshell_intake');

async function nutshellAssigned(out) {
  const nutshell = require('./nutshell');
  if (!nutshell.isConfigured() || Date.now() - _lastNutshell < NUTSHELL_EVERY_MS) return;
  _lastNutshell = Date.now();
  const cadence = require('./cadence');
  const meta = await nutshellMeta().get();
  let since = meta.exists ? toDate(meta.data().since) : null;
  if (!since) {
    since = new Date();
    await nutshellMeta().set({ since, started_at: new Date() });
  }
  const leads = (await nutshell.call('findLeads', { query: { status: 0, stagesetId: KICKSTART_STAGESET, assignee: [{ entityType: 'Users', id: ME() }] }, orderBy: 'createdTime', orderDirection: 'DESC', limit: 20, stubResponses: false }) || [])
    .filter(l => new Date(l.createdTime) >= since && Date.now() - new Date(l.createdTime) >= NUTSHELL_WAIT_MS);
  if (!leads.length) return;
  const linked = new Set((await cadence.listLeads()).map(l => l.nutshell_lead_id).filter(Boolean));
  let seen = null;
  for (const l of leads) {
    if (linked.has(l.id)) continue;
    const ref = db().collection('lead_intake').doc(`nutshell_${l.id}`);
    try { await ref.create({ nutshell_lead_id: l.id, status: 'claimed', at: new Date() }); } catch { continue; }
    const c = (l.contacts || [])[0];
    const k = c ? await contactKeys(c.id) : {};
    const full = (c && c.name) || '';
    const p = {
      full_name: full, first_name: firstName(full), last_name: full.split(/\s+/).slice(1).join(' '),
      email: k.email || '', phone_raw: k.phone_raw || '', phone: k.phone || null, role: '', frustration: '', company: '',
    };
    seen = seen || (await known());
    const d = decide(p, seen);
    const who = cadence.esc(full || l.description || `Nutshell lead ${l.id}`);
    const source = `Nutshell lead assigned to you (${(l.sources || []).map(s => s.name).join(', ') || 'no source'})`;
    // Already in the cadence by email or phone: link it so stages land on this lead.
    if (d.action === 'duplicate') {
      const hit = (await cadence.listLeads()).find(x => (p.email && x.email === p.email) || (p.phone && x.phone === p.phone));
      if (hit && !hit.nutshell_lead_id) await cadence.saveLead(hit.email, { nutshell_lead_id: l.id });
    }
    const r = await addLead(p, d, ref, { out, seen, who, owner: { status: 'mine', lead_id: l.id }, source, at: l.createdTime });
    if (r === 'retry') { _lastNutshell = 0; break; }
  }
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
    if (!isFormEmail(m)) { out.push({ date: m.date, from: m.from, action: 'ignore', why: 'not from the form' }); continue; }
    const p = parseLeadEmail(m);
    const d = decide(p, seen);
    const done = await intakeCol().doc(idFor(m.message_id)).get();
    if (d.action === 'add') seen.push({ where: 'an earlier email in this dry run', email: p.email, phone: p.phone });
    out.push({ date: m.date, from: m.from, ...d, parsed: p, already_processed: done.exists ? done.data().status : null });
  }
  return { since: meta.exists ? toDate(meta.data().since) : 'not started (first run takes the last 30 minutes)', emails: out };
}

module.exports = { run, dryRun, parseLeadEmail, decide, rowCells, formFields };
