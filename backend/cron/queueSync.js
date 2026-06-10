// cron/queueSync.js — keep the LinkedIn reply queue honest against HeyReach.
//
// For every unhandled HeyReach reply, pull the live chatroom and:
//   1. If WE sent the last message (answered directly in HeyReach), mark the
//      reply handled — it doesn't belong in the queue anymore.
//   2. If the LEAD has sent a NEWER message than what we captured, update
//      reply_text and requeue it for the classifier so the draft matches the
//      latest message, not a stale one.
//   3. Sync auto-tags (Interested) from the chatroom profile.
//
// Bounded per run and rate-limited so it stays friendly to the HeyReach API.

const axios = require('axios');
const { db } = require('../services/db');

const HR_BASE = 'https://api.heyreach.io/api/public';

function hrHeaders() {
  const k = process.env.HEYREACH_API_KEY;
  if (!k) throw new Error('HEYREACH_API_KEY not set');
  return { 'X-API-KEY': k, 'Content-Type': 'application/json' };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function syncQueue({ limit = 60 } = {}) {
  const snap = await db.collection('replies').orderBy('created_at', 'desc').limit(400).get();

  const candidates = [];
  snap.forEach(doc => {
    const d = doc.data();
    if (d.source !== 'heyreach' || d.handled === true) return;
    const raw = d.raw_payload?.data || d.raw_payload || {};
    const cid = d.heyreach_conversation_id || raw.conversation_id || null;
    const aid = Number(d.heyreach_account_id || raw.sender?.id) || null;
    if (!cid || !aid) return;
    candidates.push({ ref: doc.ref, d, cid, aid });
  });

  let cleared = 0, refreshed = 0, tagged = 0, failed = 0;

  for (const { ref, d, cid, aid } of candidates.slice(0, limit)) {
    try {
      const r = await axios.get(
        `${HR_BASE}/inbox/GetChatroom/${aid}/${encodeURIComponent(cid)}`,
        { headers: hrHeaders() }
      );
      const room = r.data || {};
      const update = {};

      // Auto-tag sync — the chatroom carries autoTags the reply webhook misses
      const autoTags = (room.correspondentProfile?.autoTags || []).map(t => t.name).filter(Boolean);
      const manualTags = (room.correspondentProfile?.tags || []).map(t => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
      const allTags = [...new Set([...autoTags, ...manualTags])];
      const interested = allTags.some(t => /interested/i.test(t) && !/not.?interested/i.test(t));
      if (interested && !d.auto_tag_interested) { update.auto_tag_interested = true; tagged++; }
      if (allTags.length && JSON.stringify(allTags) !== JSON.stringify(d.heyreach_tags || [])) {
        update.heyreach_tags = allTags;
      }

      if (room.lastMessageSender && room.lastMessageSender !== 'CORRESPONDENT') {
        // We spoke last — already answered in HeyReach. Out of the queue.
        update.handled = true;
        update.handled_reason = 'answered_in_heyreach';
        cleared++;
      } else if (
        room.lastMessageSender === 'CORRESPONDENT' &&
        (room.lastMessageText || '').trim() &&
        room.lastMessageText.trim() !== (d.reply_text || '').trim()
      ) {
        // Lead sent something newer than what we captured — refresh + redraft.
        update.reply_text = room.lastMessageText.trim();
        update.message_date = room.lastMessageAt || d.message_date;
        update.reclassified_at = null;
        refreshed++;
      }

      if (Object.keys(update).length) await ref.update(update);
      await sleep(400);
    } catch (e) {
      failed++;
      // 404 = conversation gone (lead withdrew, account disconnected) — leave it
      if (e.response?.status !== 404) {
        console.error('[queueSync] fail', d.full_name || cid, e.response?.status || e.message);
      }
      await sleep(400);
    }
  }

  const result = { candidates: candidates.length, processed: Math.min(candidates.length, limit), cleared, refreshed, tagged, failed };
  console.log('[queueSync]', JSON.stringify(result));
  return result;
}

module.exports = { syncQueue };
