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

// How far back to create cards for lead-waiting threads we've never seen.
// This is a floor on how long a webhook outage can go unnoticed: anything that
// slipped through and is older than the window was invisible FOREVER, because
// every later run skipped it too. On 2026-08-05 that had silently stranded 123
// threads where the lead spoke last, all of them older than the 14-day window.
// Override per-run (see syncQueue options) to backfill wider.
const CREATE_WINDOW_DAYS = Number(process.env.QUEUE_SYNC_CREATE_WINDOW_DAYS) || 14;

// A pending card whose conversation is gone from HeyReach entirely belongs to a
// LinkedIn profile that's since been swapped out. It can never be replied to —
// SendMessage answers "This conversation does not exist" — so it has to leave
// the queue instead of being worked forever. Grace period so a fresh webhook row
// isn't cleared before it shows up in the list API.
const ORPHAN_GRACE_DAYS = Number(process.env.QUEUE_SYNC_ORPHAN_GRACE_DAYS) || 2;

function hrHeaders() {
  const k = process.env.HEYREACH_API_KEY;
  if (!k) throw new Error('HEYREACH_API_KEY not set');
  return { 'X-API-KEY': k, 'Content-Type': 'application/json' };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Returns { items, complete } — `complete` is false when we didn't manage to
// pull the whole inbox, which disables the orphan pass so a short read can never
// mass-clear the queue.
async function fetchAllConversations() {
  const items = [];
  let totalCount = 0;
  for (let offset = 0; offset < 20000; offset += 100) {
    const r = await axios.post(`${HR_BASE}/inbox/GetConversationsV2`,
      { offset, limit: 100, filters: {} }, { headers: hrHeaders() });
    const batch = r.data?.items || [];
    totalCount = r.data?.totalCount || totalCount;
    items.push(...batch);
    if (!batch.length || items.length >= totalCount) break;
    await sleep(300);
  }
  return { items, complete: totalCount > 0 && items.length >= totalCount };
}

function convoTags(c) {
  const auto = (c.correspondentProfile?.autoTags || []).map(t => t.name).filter(Boolean);
  const manual = (c.correspondentProfile?.tags || []).map(t => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
  return [...new Set([...auto, ...manual])];
}

const isInterested = (tags) => tags.some(t => /interested/i.test(t) && !/not.?interested/i.test(t));

/**
 * @param {object} [opts]
 * @param {number} [opts.createWindowDays] widen the backfill for a one-off catch-up
 * @param {boolean} [opts.dryRun] report counts, write nothing
 */
async function syncQueue(opts = {}) {
  const createWindowDays = Number(opts.createWindowDays) || CREATE_WINDOW_DAYS;
  const dryRun = opts.dryRun === true;
  const { items: convos, complete } = await fetchAllConversations();
  const byId = new Map();
  const byUrl = new Map();
  for (const c of convos) {
    byId.set(c.id, c);
    const url = c.correspondentProfile?.profileUrl;
    if (url) byUrl.set(url, c);
  }

  // Every heyreach doc, not the newest N. This set is what stops the create pass
  // below from re-adding a thread we already have; capping it at 800 meant older
  // cards fell outside the window and got duplicated on the next backfill.
  const snap = await db.collection('replies').where('source', '==', 'heyreach').get();
  const docsByConvo = new Set();
  const docsByUrl = new Set();
  let cleared = 0, refreshed = 0, tagged = 0, created = 0, orphaned = 0;
  const orphanCutoff = Date.now() - ORPHAN_GRACE_DAYS * 24 * 60 * 60 * 1000;

  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.source !== 'heyreach') continue;
    const raw = d.raw_payload?.data || d.raw_payload || {};
    const cid = d.heyreach_conversation_id || raw.conversation_id || null;
    if (cid) docsByConvo.add(cid);
    // Only OPEN cards suppress a new one for the same person. Including handled
    // cards here meant a prospect who replied, got worked and closed, then came
    // back in a new thread was silently skipped forever — 38 people were sitting
    // in that state, waiting on us, with nothing on the board.
    if (d.profile_url && d.handled !== true) docsByUrl.add(d.profile_url);
    if (d.handled === true) continue;

    const c = (cid && byId.get(cid)) || (d.profile_url && byUrl.get(d.profile_url));
    if (!c) {
      // Not in HeyReach at all — the sender profile was retired. Only act on a
      // complete pull, and only once past the grace period.
      const createdAt = d.created_at?.toDate ? d.created_at.toDate().getTime() : new Date(d.created_at || 0).getTime();
      if (complete && createdAt && createdAt < orphanCutoff) {
        orphaned++;
        if (!dryRun) await doc.ref.update({ handled: true, handled_reason: 'conversation_gone_profile_retired' });
      }
      continue;
    }

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
    if (Object.keys(update).length && !dryRun) await doc.ref.update(update);
  }

  // Direction 2: lead-waiting conversations with no dashboard card at all.
  const cutoff = Date.now() - createWindowDays * 24 * 60 * 60 * 1000;
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
    created++;
    if (dryRun) continue;
    await db.collection('replies').add({
      source: 'heyreach',
      email: null,
      lead_id: null,
      first_name: p.firstName || '',
      last_name: p.lastName || '',
      full_name: [p.firstName, p.lastName].filter(Boolean).join(' '),
      lead_name: [p.firstName, p.lastName].filter(Boolean).join(' '),
      profile_url: url || '',
      headline: p.headline || '',
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
  }

  // Give refreshed/created docs their drafts (bounded — rest caught next run)
  let reclassify = null;
  if (!dryRun && refreshed + created > 0) {
    try {
      const { reclassifyBacklog } = require('./reclassify');
      reclassify = await reclassifyBacklog({ limit: 10 });
    } catch (e) {
      console.error('[queueSync] reclassify pass failed:', e.message);
    }
  }

  const result = { conversations: convos.length, complete, createWindowDays, dryRun,
    cleared, refreshed, created, tagged, orphaned, reclassify };
  console.log('[queueSync]', JSON.stringify(result));
  return result;
}

module.exports = { syncQueue };
