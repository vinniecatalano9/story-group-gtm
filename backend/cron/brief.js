// cron/brief.js — Morning GTM Brief
//
// The "tells me what to do" heartbeat output. Pulls LinkedIn (HeyReach, 7-day) +
// email (Instantly overview) numbers, computes the "winnable, not-yet-handled"
// board from the Firestore replies the webhooks already capture + classify, and
// posts a single brief to Slack.
//
// Composition is fully DETERMINISTIC (no AI / CLI dependency) so the daily
// heartbeat can never silently fail. Each data source is independently
// try/caught — a down channel degrades the brief, it doesn't kill it.

const axios = require('axios');
const { db } = require('../services/db');
const slack = require('../services/slack');
const { isMediaOutreach } = require('../lib/mediaFilter');

const HR_BASE = 'https://api.heyreach.io/api/public';
const INST_BASE = 'https://api.instantly.ai/api/v2';

function hrHeaders() {
  const k = process.env.HEYREACH_API_KEY;
  if (!k) throw new Error('HEYREACH_API_KEY not set');
  return { 'X-API-KEY': k, 'Content-Type': 'application/json' };
}

async function linkedinWeek() {
  try {
    const a = await axios.post(`${HR_BASE}/li_account/GetAll`, { offset: 0, limit: 100 }, { headers: hrHeaders() });
    const accountIds = (a.data?.items || []).map(x => x.id);
    const c = await axios.post(`${HR_BASE}/campaign/GetAll`, { offset: 0, limit: 100 }, { headers: hrHeaders() });
    const campaignIds = (c.data?.items || []).map(x => x.id);
    if (!accountIds.length || !campaignIds.length) return null;
    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = new Date();
    const r = await axios.post(`${HR_BASE}/stats/GetOverallStats`,
      { accountIds, campaignIds, startDate: start.toISOString(), endDate: end.toISOString() },
      { headers: hrHeaders() });
    const days = r.data?.byDayStats || {};
    const agg = { connectionsSent: 0, connectionsAccepted: 0, messagesSent: 0, totalMessageReplies: 0, inmailMessagesSent: 0, totalInmailReplies: 0, autoTaggedInterested: 0 };
    for (const d of Object.values(days)) for (const k of Object.keys(agg)) agg[k] += (d[k] || 0);
    const replies = agg.totalMessageReplies + agg.totalInmailReplies;
    return {
      ...agg,
      replies,
      acceptance: agg.connectionsSent ? Math.round((agg.connectionsAccepted / agg.connectionsSent) * 100) : 0,
      replyRate: agg.messagesSent ? Math.round((replies / agg.messagesSent) * 100) : 0,
    };
  } catch (e) {
    console.error('[brief] linkedinWeek failed:', e.message);
    return null;
  }
}

async function emailOverview() {
  try {
    const key = process.env.INSTANTLY_API_KEY;
    if (!key) return null;
    const r = await axios.get(`${INST_BASE}/campaigns/analytics/overview`, { headers: { Authorization: `Bearer ${key}` } });
    const d = r.data || {};
    const sent = d.emails_sent_count || 0;
    const replies = d.reply_count_unique || d.reply_count || 0;
    const bounced = d.bounced_count || 0;
    return {
      sent,
      replyRate: sent ? ((replies / sent) * 100).toFixed(2) : '0',
      bounceRate: sent ? ((bounced / sent) * 100).toFixed(2) : '0',
      opportunities: d.total_opportunities || 0,
      booked: d.total_meeting_booked || 0,
    };
  } catch (e) {
    console.error('[brief] emailOverview failed:', e.message);
    return null;
  }
}

const WINNABLE = ['interested', 'cost_question', 'cost_question_repeat', 'more_info', 'why_reach_out', 're_engage', 'question_other', 'guarantee'];

async function getBoard() {
  try {
    const snap = await db.collection('replies').orderBy('created_at', 'desc').limit(300).get();
    const seen = new Set();
    const board = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.handled === true) return;
      if (!WINNABLE.includes(d.classification)) return;
      if (isMediaOutreach({ email: d.email, company: d.company_name })) return; // Lydia's reporter pitches — not sales
      const key = d.profile_url || d.email || d.full_name || doc.id;
      if (seen.has(key)) return;
      seen.add(key);
      board.push({
        id: doc.id,
        name: d.full_name || d.lead_name || d.email || 'Unknown',
        company: d.company_name || '',
        channel: d.source || '',
        classification: d.classification,
        hot: d.classification === 'interested' || d.auto_tag_interested === true,
        reply: (d.reply_text || d.summary || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        draft: d.draft_response || '',
        hasDraft: !!d.draft_response,
        email_uuid: d.email_uuid || null,
        eaccount: d.eaccount || null,
      });
    });
    return board;
  } catch (e) {
    console.error('[brief] getBoard failed:', e.message);
    return [];
  }
}

async function classMix7d() {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const snap = await db.collection('replies').where('created_at', '>=', since).get();
    const mix = {};
    snap.forEach(doc => {
      const c = doc.data().classification || 'other';
      mix[c] = (mix[c] || 0) + 1;
    });
    return mix;
  } catch (e) {
    console.error('[brief] classMix7d failed:', e.message);
    return {};
  }
}

function fmtDate() {
  try {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function chLabel(src) {
  if (src === 'heyreach') return 'LinkedIn';
  if (src === 'instantly' || src === 'email') return 'Email';
  return src || '?';
}

async function gatherData() {
  const [li, email, board, mix] = await Promise.all([linkedinWeek(), emailOverview(), getBoard(), classMix7d()]);
  return { board, li, email, mix };
}

async function runBrief({ send = true } = {}) {
  const { board, li, email, mix } = await gatherData();

  const pricingObjections = (mix.cost_question || 0) + (mix.cost_question_repeat || 0) + (mix.guarantee || 0);

  const lines = [`*☀️ Morning GTM Brief — ${fmtDate()}*`];

  const hot = board.filter(b => b.hot);
  const rest = board.filter(b => !b.hot);

  if (hot.length) {
    lines.push(`\n*🔥 ${hot.length} INTERESTED — answer these first:*`);
    for (const b of hot.slice(0, 8)) {
      const co = b.company ? ` — ${b.company.slice(0, 40)}` : '';
      lines.push(`• *${b.name}*${co}  _(${chLabel(b.channel)})_${b.hasDraft ? '  ✏️ draft ready' : ''}\n   ›_${b.reply || '(no text captured)'}_`);
    }
  }

  if (rest.length) {
    lines.push(`\n*🎯 ${rest.length} more winnable repl${rest.length === 1 ? 'y' : 'ies'} awaiting you${rest.length > 8 ? ' (top 8)' : ''}:*`);
    for (const b of rest.slice(0, 8)) {
      const co = b.company ? ` — ${b.company.slice(0, 40)}` : '';
      lines.push(`• *${b.name}*${co}  _(${chLabel(b.channel)} · ${b.classification})_${b.hasDraft ? '  ✏️ draft ready' : ''}\n   ›_${b.reply || '(no text captured)'}_`);
    }
  }

  if (!board.length) {
    lines.push(`\n*🎯 Board clear* — no winnable replies awaiting a response.`);
  }

  if (li) lines.push(`\n*🔗 LinkedIn (7d):* ${li.connectionsSent} connects → ${li.connectionsAccepted} accepted (*${li.acceptance}%*) · ${li.messagesSent} msgs → ${li.replies} replies (*${li.replyRate}%*) · ${li.autoTaggedInterested} interested`);
  if (email) lines.push(`*📧 Email (all-time):* ${email.sent.toLocaleString()} sent · ${email.replyRate}% reply · ${email.bounceRate}% bounce · ${email.opportunities} opps · ${email.booked} booked`);

  if (pricingObjections >= 2) lines.push(`\n*⚠️ Alert:* ${pricingObjections} pricing / pay-to-play objections this week — copy is still triggering "is this paid?". Reframe: earned, not bought.`);

  const todo = [];
  if (board.length) todo.push(`Reply to the ${Math.min(board.length, 8)} winnable above (drafts ready).`);
  if (li && li.acceptance && li.acceptance < 30) todo.push(`LinkedIn acceptance ${li.acceptance}% is under 30% — tighten connect targeting.`);
  todo.push(`Load new ICP-fit founders (health / tech-AI) into HeyReach.`);
  lines.push(`\n*✅ Do today:*\n${todo.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);

  const text = lines.join('\n');
  if (send) {
    await slack.notify(text);
    console.log(`[brief] Sent morning brief (${board.length} board items)`);
  }
  return { text, boardCount: board.length, li, email, mix };
}

module.exports = { runBrief, gatherData };
