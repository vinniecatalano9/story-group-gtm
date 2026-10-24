// services/leadClaim.js — who works a new ad lead (Vincent, 10/23).
//
// "Don't have the assigned rep set to Vincent every time. Have that empty."
// A form lead Nutshell gave Vincent (or no one) lands in the sheet with a blank
// Assigned Rep (H), Clearout-checked and imported but not started, and gets
// one Telegram card:
//   [I'll take it]  Vincent in H, cadence starts, Email 1 card within a minute.
//   [McKenna's]     her name in H, the system never touches the lead again.
// A name typed into H instead does the same on the next intake run. One tap
// does it (no confirm page). Leads Nutshell gives another rep never get here:
// leadIntake pings once and adds nothing.
//
// State on the ad_leads doc: unassigned (true until decided), claim_token
// (the card's links), claim ({ rep, via, at } from a tap, applied by sweep()),
// claim_card ({ message_id, text }) so the card can say what happened.

const crypto = require('crypto');

const REP = () => process.env.AD_LEADS_REP || 'Vincent';
const OTHER = () => process.env.AD_LEADS_OTHER_REP || 'McKenna';
// Same origin as the approval links in services/cadence.js.
const PUBLIC_URL = () => (process.env.CADENCE_PUBLIC_URL || new URL(process.env.REPLY_PANEL_URL || 'https://gtm-api.srv1364275.hstgr.cloud/api/approve/panel').origin).replace(/\/$/, '');
const SHEET_EVERY_MS = 2 * 6e4; // typed names in H: read the sheet at most this often
const isMe = rep => String(rep || '').toLowerCase().includes(REP().toLowerCase());
let _lastSheet = 0;

async function tg(method, body) {
  return require('./replyApprovals').tg(method, body);
}

/** The card's text plus a closing line; buttons gone. Never throws. */
async function closeCard(lead, line) {
  const c = lead.claim_card;
  if (!c || !c.message_id) return;
  const chat = process.env.FEED_TELEGRAM_CHAT || '1027800577';
  await tg('editMessageText', { chat_id: chat, message_id: c.message_id, text: `${c.text}\n\n${line}`, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } })
    .catch(e => console.warn('[leadClaim] card edit failed:', e.message));
}

/**
 * Mark an imported (not started) lead unassigned and send its card.
 * `lines` are the card's detail lines, already HTML-escaped.
 */
async function offer(key, { who, row, source, lines = [] }) {
  const cadence = require('./cadence');
  const token = crypto.randomBytes(16).toString('hex');
  await cadence.saveLead(key, { unassigned: true, claim_token: token, claim: null, rep: '' });
  const url = w => `${PUBLIC_URL()}/api/cadence/claim/${encodeURIComponent(key)}?t=${token}&who=${w}`;
  const text = [
    `🆕 New ad lead <b>${who}</b> (${cadence.esc(source)}), sheet row ${row}: <b>Unassigned</b>.`,
    ...lines.filter(Boolean),
    'Nothing goes out until someone takes it.',
  ].join('\n');
  const m = await cadence.ping(text, { reply_markup: { inline_keyboard: [[{ text: "I'll take it", url: url('me') }, { text: `${OTHER()}'s`, url: url('other') }]] } });
  const id = m && (m.message_id || (m.result && m.result.message_id));
  if (id) await cadence.saveLead(key, { claim_card: { message_id: id, text } });
  return !!m;
}

/**
 * A tap on the card: { ok, msg } for the page. Writes H now (only when blank)
 * so the sheet shows it at once; the cadence start runs under the intake's
 * guard (sweep), kicked off right away.
 */
async function tap(key, t, who) {
  const cadence = require('./cadence');
  const lead = await cadence.getLead(key).catch(() => null);
  const token = String(t || '');
  if (!lead || !lead.claim_token || token.length !== lead.claim_token.length
    || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(lead.claim_token))) return { ok: false, msg: 'Link not valid' };
  const name = cadence.fullName(lead);
  if (!lead.unassigned) return { ok: true, msg: `Already ${lead.rep || 'taken'}'s`, sub: name };
  let rep = who === 'me' ? REP() : OTHER();
  const inH = await require('./adLeadsSheet').setRep({ email: cadence.realEmail(lead), phone: lead.phone, rep });
  // Someone typed a different name in H first: that name wins.
  if (inH && inH.toLowerCase() !== rep.toLowerCase()) rep = inH;
  await cadence.saveLead(key, { claim: { rep, via: 'card', at: new Date() } });
  cadence.runIntake().catch(e => console.warn('[leadClaim] intake after tap:', e.message));
  return isMe(rep)
    ? { ok: true, msg: 'Yours.', sub: `${name}: cadence starting. ${cadence.inWindow(new Date(), lead.tz) ? 'The first card comes within a minute.' : 'The first card comes when their send window opens (9:30am their time).'}` }
    : { ok: true, msg: `${rep}'s.`, sub: `${name}: nothing will go out from the system.` };
}

/** Find this lead's row: email in C, else phone in B. */
function rowFor(rows, lead) {
  const { toE164 } = require('./ringcentral');
  const email = require('./cadence').realEmail(lead);
  return rows.find(r => (email && String(r.raw[2] || '').trim().toLowerCase() === email))
    || (lead.phone ? rows.find(r => toE164(r.raw[1]) === lead.phone) : null);
}

/**
 * Every intake run (caller holds the cadence guard): apply taps, names typed
 * into H, and leads started by hand from the Ad Leads page. Vincent: start
 * the cadence and queue the first card. Anyone else: rep set, stopped, never
 * touched again (like Moshy, 10/22).
 */
async function sweep(out) {
  const cadence = require('./cadence');
  const open = (await cadence.listLeads()).filter(l => l.unassigned);
  if (!open.length) return;
  let rows = null;
  const typed = open.some(l => !(l.claim && l.claim.rep)) && Date.now() - _lastSheet >= SHEET_EVERY_MS;
  if (typed) {
    _lastSheet = Date.now();
    rows = await require('./adLeadsSheet').readRows().then(r => {
      const col = r.header.findIndex(h => /assigned|rep\b/i.test(String(h)));
      return col < 0 ? null : r.rows.map(x => ({ ...x, rep: String(x.raw[col] || '').trim() }));
    }).catch(e => { console.warn('[leadClaim] sheet read:', e.message); return null; });
  }
  for (const l of open) {
    let rep = l.claim && l.claim.rep, via = 'card';
    if (!rep && rows) { const r = rowFor(rows, l); if (r && r.rep) { rep = r.rep; via = 'sheet'; } }
    if (!rep && l.running) { rep = REP(); via = 'Ad Leads page'; }
    if (!rep) continue;
    if (isMe(rep)) await take(l, via, out);
    else await giveAway(l, rep, via);
  }
}

async function take(l, via, out) {
  const cadence = require('./cadence');
  await cadence.saveLead(l.email, { rep: REP(), unassigned: false, claim_token: null, claimed_at: new Date(), claimed_via: via });
  if (via !== 'sheet') await require('./adLeadsSheet').setRep({ email: cadence.realEmail(l), phone: l.phone, rep: REP() });
  try {
    if (!l.running) await cadence.startLead(l.email);
    const q = await cadence.queueDue(l.email);
    out.added.push(l.email); // so runIntake syncs the sheet
    const lead = await cadence.getLead(l.email);
    console.log(`[intake] ${l.email}: taken by ${REP()} (${via})${q.queued.length ? `, ${q.queued.join(', ')} queued` : ''}`);
    await closeCard(l, `✅ Yours (${cadence.esc(via)}). Cadence started. Next: ${cadence.esc(lead.next_touch_label || 'see the Ad Leads page')}`);
  } catch (e) {
    out.skipped.push(`${l.email}: start failed (${e.message})`);
    await closeCard(l, `⚠️ Yours, but the cadence didn't start: ${cadence.esc(e.message)}`);
  }
}

async function giveAway(l, rep, via) {
  const cadence = require('./cadence');
  if (l.running) {
    // Started already, then someone else's name went in H: Vincent decides.
    await cadence.saveLead(l.email, { unassigned: false, claim_token: null });
    await cadence.ping(`⚠️ <b>${cadence.esc(cadence.fullName(l))}</b> says ${cadence.esc(rep)} in Assigned Rep, but its cadence is running. Stop it on the Ad Leads page if it's theirs.`);
    return;
  }
  await cadence.saveLead(l.email, {
    rep, state: 'stopped', running: false, track: null, next_step: null, next_due_at: null, next_touch_label: '',
    unassigned: false, claim_token: null, claimed_at: new Date(), claimed_via: via,
  });
  console.log(`[intake] ${l.email}: ${rep}'s (${via}), left alone`);
  await closeCard(l, `👥 ${cadence.esc(rep)}'s (${cadence.esc(via)}). Nothing goes out from the system.`);
}

module.exports = { offer, tap, sweep };
