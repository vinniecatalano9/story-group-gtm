// cron/autoSendCheck.js: the daily auto-send checker (Vincent, 11/23/2026).
//
// The ad lead cadence went to CADENCE_MODE=live on 11/23: no more approving
// each message. Every morning this looks back 24 hours and messages Vincent in
// Reply Bot's chat ONLY when something looks off. All OK = no message.
//
// Checks:
//   1. What went out: rule checks on every sent message (unfilled {placeholders},
//      wrong first name, a dash, the same step twice to one lead), then a
//      Sonnet read of all of them for anything a person would wince at.
//   2. Speed to lead: a lead tagged 2+ hours ago with no Email 1 or text sent.
//   3. Stuck: cards still pending or approved 2+ hours after they were made,
//      and leads blocked on something.
//   4. People waiting on Vincent: a lead who replied 24+ hours ago with no
//      outcome set, and Reply Bot cards (LinkedIn and email replies) with a
//      real draft still pending after 24 hours.
//
// Switch: AUTOSEND_CHECK=off in .env. Run by hand:
//   node -e "require('dotenv').config();require('./cron/autoSendCheck').run({ dryRun: true }).then(r=>console.log(JSON.stringify(r,null,2)))"

const DAY = 864e5;
const HOUR = 36e5;
const toDate = v => (v ? (v.toDate ? v.toDate() : new Date(v)) : null);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Our own people show up as "replies" from internal mail; never count them.
const TEAM = /^(vincent catalano|mckenna moonan|aaron evans|lydia fisher|michelle brown|annette fildisis|schneider jean|safaque)/i;
const first = s => String(s || '').trim().split(/\s+/)[0] || '';

function ruleProblems(card, lead) {
  const out = [];
  const text = `${card.subject || ''}\n${card.text || ''}`;
  if (/\{\{?[a-z_]+\}?\}/i.test(text)) out.push('unfilled placeholder');
  if (/\s[–—]\s|\s-\s|[–—]/.test(card.text || '')) out.push('has a dash');
  const greet = (card.text || '').match(/^(?:Hey|Hi|Hello)\s+([A-Za-z'’-]+)/);
  const want = first(lead && lead.first_name);
  if (greet && want && greet[1].toLowerCase() !== want.toLowerCase()) out.push(`greets "${greet[1]}" but the lead is ${want}`);
  return out;
}

async function run({ dryRun = false } = {}) {
  if (String(process.env.AUTOSEND_CHECK || 'on').toLowerCase() === 'off') return { skipped: 'AUTOSEND_CHECK=off' };
  const { db } = require('../services/db');
  const now = Date.now();
  const since = new Date(now - DAY);
  const issues = [];

  const leadsSnap = await db.collection('ad_leads').get();
  const leads = new Map(leadsSnap.docs.map(d => [d.id, d.data()]));

  // 1. What went out.
  const cardsSnap = await db.collection('cadence_approvals').where('created_at', '>=', new Date(now - 14 * DAY)).get();
  const cards = cardsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const sent = cards.filter(c => c.status === 'sent' && toDate(c.sent_at) >= since);
  const seen = new Map();
  for (const c of cards.filter(x => x.status === 'sent')) {
    const k = `${c.email}|${c.step}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const c of sent) {
    const p = ruleProblems(c, leads.get(c.email));
    if (seen.get(`${c.email}|${c.step}`) > 1) p.push(`${c.step} went to them more than once`);
    if (p.length) issues.push(`${esc(c.name)} (${c.step}): ${esc(p.join('; '))}`);
  }
  if (sent.length) {
    try {
      const { claudeJSON } = require('../services/claude');
      const list = sent.map((c, i) => `#${i + 1} to ${c.name} (${c.step}, ${c.channel}, sent ${toDate(c.sent_at).toISOString()})\n${c.subject ? `Subject: ${c.subject}\n` : ''}${c.text}`).join('\n\n---\n\n');
      const r = await claudeJSON(`You check automated follow-ups that Vincent Catalano (VP of Growth, Story Group, a PR firm) sends to leads who filled out a "Become Impossible to Ignore" Facebook/Instagram form. They now go out with no human approval, so flag anything a careful sales rep would not have sent: wrong or odd name, garbled or cut-off text, offered times that were already in the past when it was sent, a weekday with no date when it clearly matters, a tone problem, a broken promise, or the same lead getting near-duplicate messages. Do NOT flag normal template wording, short messages, or "Hello," with no name. Today is ${new Date(now).toISOString().slice(0, 10)}.\n\nMessages:\n\n${list}\n\nReturn JSON only: {"problems":[{"n":<message number>,"why":"<one short sentence>"}]} with an empty list when all are fine.`, { model: 'sonnet', timeout: 180000 });
      for (const p of (r && r.problems) || []) {
        const c = sent[(p.n || 0) - 1];
        if (c) issues.push(`${esc(c.name)} (${c.step}): ${esc(p.why)}`);
      }
    } catch (e) {
      issues.push(`Couldn't run the AI read of today's messages (${esc(e.message)}). Rule checks still ran.`);
    }
  }

  // 2. Speed to lead.
  for (const [email, l] of leads) {
    const tagged = toDate(l.track_started_at) || toDate(l.created_at);
    if (!l.running || l.track !== 'intro' || !tagged || now - tagged < 2 * HOUR || now - tagged > 7 * DAY) continue;
    const done = l.steps_done || {};
    const touched = Object.values(done).some(x => x && x.status === 'sent');
    if (!touched) issues.push(`${esc([l.first_name, l.last_name].filter(Boolean).join(' ') || email)}: tagged ${Math.round((now - tagged) / HOUR)}h ago, nothing sent yet${l.blocked_reason ? ` (blocked: ${esc(l.blocked_reason)})` : ''}`);
  }

  // 3. Stuck cards and blocked leads.
  for (const c of cards) {
    if (!['pending', 'approved'].includes(c.status)) continue;
    const age = now - (toDate(c.status === 'approved' && c.approved_at) || toDate(c.created_at));
    if (age < 2 * HOUR) continue;
    if (c.status === 'pending' && c.step === 'noshow') { issues.push(`${esc(c.name)}: no-show text waiting for your OK`); continue; }
    issues.push(`${esc(c.name)} (${c.step}): card ${c.status} for ${Math.round(age / HOUR)}h`);
  }
  for (const [email, l] of leads) {
    if (l.running && l.blocked_reason) issues.push(`${esc([l.first_name, l.last_name].filter(Boolean).join(' ') || email)}: blocked, ${esc(l.blocked_reason)}`);
  }

  // 4. People waiting on Vincent.
  for (const [email, l] of leads) {
    const at = toDate(l.replied_at);
    if (l.state === 'replied' && at && now - at > DAY) issues.push(`${esc([l.first_name, l.last_name].filter(Boolean).join(' ') || email)} replied ${Math.round((now - at) / DAY)}d ago and has no outcome set`);
  }
  try {
    const ra = await db.collection('reply_approvals').where('status', '==', 'pending').get();
    const waiting = ra.docs.map(d => d.data()).filter(a => a.draft && String(a.draft).trim() && !TEAM.test(a.full_name || '') && now - toDate(a.created_at) > DAY && now - toDate(a.created_at) < 14 * DAY);
    if (waiting.length) issues.push(`${waiting.length} Reply Bot repl${waiting.length === 1 ? 'y' : 'ies'} with a draft waiting 24h+: ${esc(waiting.slice(0, 8).map(a => a.full_name).join(', '))}${waiting.length > 8 ? ', ...' : ''}`);
  } catch (e) {
    console.warn('[autoSendCheck] reply_approvals:', e.message);
  }

  const summary = { sent: sent.length, issues };
  await db.collection('autosend_checks').add({ at: new Date(), sent: sent.length, issues, dry_run: !!dryRun }).catch(() => {});
  if (!issues.length) { console.log(`[autoSendCheck] all OK (${sent.length} sent in 24h)`); return summary; }

  const text = [
    `🔎 <b>Auto-send check: ${issues.length} thing${issues.length === 1 ? '' : 's'} to look at</b>`,
    `${sent.length} follow-up${sent.length === 1 ? '' : 's'} went out in the last 24h.`,
    '',
    ...issues.slice(0, 25).map(i => `• ${i}`),
    ...(issues.length > 25 ? [`...and ${issues.length - 25} more`] : []),
  ].join('\n');
  if (dryRun) return { ...summary, text };
  const { tg } = require('../services/replyApprovals');
  const chat = process.env.FEED_TELEGRAM_CHAT || '1027800577';
  await tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true });
  return summary;
}

module.exports = { run };
