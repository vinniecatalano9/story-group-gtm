// cron/insights.js — Weekly GTM Insights engine
//
// The "analyst" layer. Runs autonomously on the VPS: gathers ALL real responders
// (LinkedIn conversations w/ profiles + email replies), reads its OWN notes from
// last run (continuity), runs a real Claude pass to surface "what I'm noticing" +
// a self-updating ICP, stores a versioned record in Firestore, and posts to Slack.
//
// Designed to be LLM-native: structured in, structured out, with memory — so this
// week's run builds on last week's instead of starting cold.

const axios = require('axios');
const { db } = require('../services/db');
const { claudeJSON } = require('../services/claude');

const HR_BASE = 'https://api.heyreach.io/api/public';
function hrHeaders() {
  const k = process.env.HEYREACH_API_KEY;
  if (!k) throw new Error('HEYREACH_API_KEY not set');
  return { 'X-API-KEY': k, 'Content-Type': 'application/json' };
}

async function gatherResponders() {
  const out = [];
  // LinkedIn conversations — richest ICP signal (headline + company + intent)
  try {
    let off = 0;
    for (let i = 0; i < 8; i++) {
      const r = await axios.post(`${HR_BASE}/inbox/GetConversationsV2`,
        { filters: { linkedInAccountIds: [], campaignIds: [], seenStatus: 'ALL' }, offset: off, limit: 100 },
        { headers: hrHeaders() });
      const items = r.data?.items || [];
      for (const c of items) {
        const p = c.correspondentProfile || {};
        const tags = (p.autoTags || []).map(t => t.name).filter(Boolean);
        out.push({
          ch: 'LI',
          awaiting: c.lastMessageSender === 'CORRESPONDENT',
          name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Unknown',
          headline: (p.headline || p.companyName || '').replace(/\s+/g, ' ').trim().slice(0, 90),
          msg: (c.lastMessageText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          tags,
        });
      }
      if (items.length < 100) break;
      off += 100;
    }
  } catch (e) { console.error('[insights] LinkedIn gather failed:', e.message); }

  // Email replies (classified, from the real-time store) — last 300, filter client-side
  try {
    const snap = await db.collection('replies').orderBy('created_at', 'desc').limit(300).get();
    snap.forEach(doc => {
      const x = doc.data();
      if (x.source !== 'instantly' && x.source !== 'email') return;
      out.push({
        ch: 'EM',
        awaiting: x.handled !== true,
        name: x.full_name || x.email || 'Unknown',
        headline: (x.company_name || '').slice(0, 90),
        msg: (x.reply_text || x.summary || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        cls: x.classification,
      });
    });
  } catch (e) { console.error('[insights] email gather failed:', e.message); }

  return out;
}

async function loadLastInsights() {
  try {
    const snap = await db.collection('insights').orderBy('created_at', 'desc').limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  } catch (e) { return null; }
}

function buildPrompt(responders, last) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = responders.map(r =>
    `${r.ch}|${r.awaiting ? 'AWAITING-US ' : ''}${r.cls ? 'cls:' + r.cls + ' ' : ''}${(r.tags && r.tags.length) ? '[' + r.tags.join(',') + '] ' : ''}${r.name} | ${r.headline} | "${r.msg}"`
  ).join('\n');

  const lastBlock = last
    ? `YOUR NOTES FROM LAST RUN (${last.date}):\n${JSON.stringify({ noticing: last.noticing, icp: last.icp, objections: last.objections }).slice(0, 3000)}\n`
    : `(No prior run — this is the first weekly analysis.)\n`;

  return `You are the GTM analyst for Story Group, a PR / earned-media agency selling $8-15K/mo retainers to the FOUNDER / CEO / OWNER who signs the check. Every week you read the REAL outbound responses and tell Vincent what you notice and how to sharpen his ICP. Be specific, evidence-based, and honest — no generic advice.

ESTABLISHED FINDINGS (your baseline — confirm, refine, or challenge with this week's data):
- The buyer signature is BEHAVIORAL, not demographic: score on REPLY INTENT (proposes/accepts a time, asks for logistics, wants a call = HOT), NOT title or vertical. Perfect-title founders pass; oddball titles book.
- Health / healthtech founder-CEOs convert densest; tech/AI founders #2. Compliance-bound finance (RIAs, insurance, credit unions, CPAs) is dead as a SOURCE.
- LinkedIn dramatically outperforms email on reply quality.
- Recurring objection: "is this paid / free / pay-to-play?" — the cold copy reads like paid placement when it isn't.

${lastBlock}
THIS WEEK'S RESPONDERS (ch: LI=LinkedIn, EM=email; AWAITING-US = they replied last, ball in our court; cls=classification; [tags]=vendor auto-tags, unreliable — judge from the message text):
${lines}

Return ONE JSON object, nothing else:
{
  "date": "${today}",
  "noticing": ["3-6 concrete, evidence-based observations citing real names/headlines from the data — what's working, what's shifting, what's surprising"],
  "icp": {
    "converting": ["segments/titles/verticals actually replying with real intent now (with evidence)"],
    "dead": ["segments to STOP sourcing (with evidence)"],
    "triggers": ["reply-intent signals that predict a real positive this week"],
    "shift": "1-2 sentences on how the ICP should move vs. your baseline / last run"
  },
  "objections": ["objection patterns rising or fading this week, with examples"],
  "chase": ["specific people (real names from the data) or segments to pursue NOW"],
  "changed_since_last": ["what changed vs your last run, or 'first run' if none"]
}

Cite real names. If the data doesn't support a claim, don't make it. Return only the JSON.`;
}

async function runInsights({ send = true } = {}) {
  const responders = await gatherResponders();
  if (!responders.length) {
    console.warn('[insights] No responders gathered — skipping');
    return { error: 'no responders' };
  }
  const last = await loadLastInsights();
  // Prioritize signal-rich responders and cap the prompt so `claude -p` runs reliably.
  const rank = (r) => (r.awaiting ? 3 : 0) + ((r.tags && r.tags.length) ? 1 : 0) + ((r.cls && !['other', 'ooo', 'bounce'].includes(r.cls)) ? 2 : 0) + ((r.msg && r.msg.length > 15) ? 1 : 0);
  const used = responders.slice().sort((a, b) => rank(b) - rank(a)).slice(0, 150);
  const result = await claudeJSON(buildPrompt(used, last), { timeout: 300000, maxTokens: 4096 });

  result.created_at = new Date();
  result.responder_count = responders.length;
  result.analyzed_count = used.length;
  const docId = result.date || new Date().toISOString().slice(0, 10);
  await db.collection('insights').doc(docId).set(result);
  console.log(`[insights] Saved insights ${docId} (${responders.length} responders)`);

  console.log('[insights] Stored — surfaced on the Command tab (no Slack)');
  return result;
}

module.exports = { runInsights, gatherResponders };
