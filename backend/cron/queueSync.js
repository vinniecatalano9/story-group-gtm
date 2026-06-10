// cron/queueSync.js — make the dashboard queue mirror HeyReach's inbox view:
// "Last message from: Lead" (+ tags), exactly like Vincent's filter panel.
//
// One paginated pull of ALL conversations, then reconcile both directions:
//   1. Reply doc pending but WE spoke last in HeyReach → mark handled.
//   2. Lead spoke last and sent something NEWER than we captured → refresh
//      reply_text and requeue for a fresh draft.
//   3. Lead spoke last but NO reply doc exists (missed webhook, manual thread)
//      → create one so it shows on the dashboard.
//   4. Sync tags / Interested auto-tag everywhere.
// Finishes with a bounded reclassify pass so refreshed/new docs get drafts.

const axios = require('axios');
const { db } = require('../services/db');

const HR_BASE = 'https://api.heyreach.io/api/public';
const CREATE_WINDOW_DAYS = 14; // don't resurrect ancient threads

function hrHeaders() {
  const k = process.env.HEYREACH_API_KEY;
  if (!k) throw new Error('HEYREACH_API_KEY not set');
  return { 'X-API-KEY': k, 'Content-Type': 'application/json' };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchAllConversations() {
  const items = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await axios.post(`${HR_BASE}/inbox/GetConversationsV2`,
      { offset, limit: 100, filters: {} }, { headers: hrHeaders() });
    const batch = r.data?.items || [];
    items.push(...batch);
    if (!batch.length || items.length >= (r.data?.totalCount || 0)) break;
    await sleep(300);
  }
  return items;
}

function convoTags(c) {
  const auto = (c.correspondentProfile?.autoTags || []).map(t => t.name).filter(Boolean);
  const manual = (c.correspondentProfile?.tags || []).map(t => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
  return [...new Set([...auto, ...manual])];
}

const isInterested = (tags) => tags.some(t => /interested/i.test(t) && !/not.?interested/i.test(t));

async function syncQueue() {
  const convos = await fetchAllConversations();
  const byId = new Map();
  const byUrl = new Map();
  for (const c of convos) {
    byId.set(c.id, c);
    const url = c.correspondentProfile?.profileUrl;
    if (url) byUrl.set(url, c);
  }

  const snap = await db.collection('replies').orderBy('created_at', 'desc').limit(800).get();
  const docsByConvo = new Set();
  const docsByUrl = new Set();
  let cleared = 0, refreshed = 0, tagged = 0, created = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.source !== 'heyreach') continue;
    const raw = d.raw_payload?.data || d.raw_payload || {};
    const cid = d.heyreach_conversation_id || raw.conversation_id || null;
    if (cid) docsByConvo.add(cid);
    if (d.profile_url) docsByUrl.add(d.profile_url);
    if (d.handled === true) continue;

    const c = (cid && byId.get(cid)) || (d.profile_url && byUrl.get(d.profile_url));
    if (!c) continue;

    const update = {};
    const tags = convoTags(c);
    if (isInterested(tags) && !d.auto_tag_interested) { update.auto_tag_interested = true; tagged++; }
    if (tags.length && JSON.stringify(tags) !== JSON.stringify(d.heyreach_tags || [])) update.heyreach_tags = tags;

    if (c.lastMessageSender && c.lastMessageSender !== 'CORRESPONDENT') {
      update.handled = true;
      update.handled_reason = 'answered_in_heyreach';
      cleared++;
    } else if (
      c.lastMessageSender === 'CORRESPONDENT' &&
      (c.lastMessageText || '').trim() &&
      c.lastMessageText.trim() !== (d.reply_text || '').trim()
    ) {
      update.reply_text = c.lastMessageText.trim();
      update.message_date = c.lastMessageAt || d.message_date;
      update.reclassified_at = null;
      refreshed++;
    }
    if (Object.keys(update).length) await doc.ref.update(update);
  }

  // Direction 2: lead-waiting conversations with no dashboard card at all.
  const cutoff = Date.now() - CREATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  for (const c of convos) {
    if (c.lastMessageSender !== 'CORRESPONDENT') continue;
    if (c.blockedByMe || c.blockedByParticipant || c.groupChat) continue;
    if (!(c.lastMessageText || '').trim()) continue;
    if (new Date(c.lastMessageAt || 0).getTime() < cutoff) continue;
    const url = c.correspondentProfile?.profileUrl;
    if (docsByConvo.has(c.id) || (url && docsByUrl.has(url))) continue;

    const p = c.correspondentProfile || {};
    const acct = c.linkedInAccount || {};
    const tags = convoTags(c);
    await db.collection('replies').add({
      source: 'heyreach',
      email: null,
      lead_id: null,
      first_name: p.firstName || '',
      last_name: p.lastName || '',
      full_name: [p.firstName, p.lastName].filter(Boolean).join(' '),
      lead_name: [p.firstName, p.lastName].filter(Boolean).join(' '),
      profile_url: url || '',
      company_name: p.companyName || '',
      reply_text: c.lastMessageText.trim(),
      message_date: c.lastMessageAt || new Date().toISOString(),
      heyreach_account_id: c.linkedInAccountId || acct.id || null,
      heyreach_account_name: [acct.firstName || acct.first_name, acct.lastName || acct.last_name].filter(Boolean).join(' ') || '',
      heyreach_campaign_id: null,
      heyreach_campaign_name: '',
      heyreach_conversation_id: c.id,
      heyreach_tags: tags,
      auto_tag_interested: isInterested(tags),
      raw_payload: { synced_from: 'queueSync' },
      handled: false,
      classification: 'other',
      created_at: new Date(),
    });
    created++;
  }

  // Give refreshed/created docs their drafts (bounded — rest caught next run)
  let reclassify = null;
  if (refreshed + created > 0) {
    try {
      const { reclassifyBacklog } = require('./reclassify');
      reclassify = await reclassifyBacklog({ limit: 10 });
    } catch (e) {
      console.error('[queueSync] reclassify pass failed:', e.message);
    }
  }

  const result = { conversations: convos.length, cleared, refreshed, created, tagged, reclassify };
  console.log('[queueSync]', JSON.stringify(result));
  return result;
}

module.exports = { syncQueue };
