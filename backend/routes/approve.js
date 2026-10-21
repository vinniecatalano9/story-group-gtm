// routes/approve.js — the Send / Edit / Skip panel behind each reply card on
// Work Bot (services/replyApprovals.js). Every call except the page itself must
// carry Telegram's signed initData from Vincent's own Telegram account.
//
// Send and Edit reuse the dashboard's own routes (/api/heyreach/reply and
// /api/heyreach/redraft) over localhost, so the phone sends exactly what the
// LinkedIn Replies page would.

const path = require('path');
const express = require('express');
const axios = require('axios');
const router = express.Router();
const { verifyInitData, markCard, cleanDraft, isOn } = require('../services/replyApprovals');
const { fetchConversation } = require('../services/autoReply');

const LOCAL = () => `http://127.0.0.1:${process.env.PORT || 3001}`;

router.get('/panel', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'approve.html'));
});

// Signed by Telegram, from Vincent, or nothing.
function auth(req, res, next) {
  try {
    const v = verifyInitData(req.get('X-Telegram-Init-Data'));
    if (!v.ok) return res.status(401).json({ error: v.error });
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function load(id) {
  const { db } = require('../services/db');
  const ref = db.collection('reply_approvals').doc(String(id));
  const doc = await ref.get();
  return { db, ref, a: doc.exists ? doc.data() : null };
}

router.get('/:id', auth, async (req, res) => {
  try {
    const { db, a } = await load(req.params.id);
    if (!a) return res.status(404).json({ error: 'Reply not found.' });
    // The whole thread, live from HeyReach, so Vincent can read it all here.
    const rdoc = await db.collection('replies').doc(a.reply_id).get().catch(() => null);
    const r = rdoc && rdoc.exists ? rdoc.data() : {};
    const convo = await fetchConversation({ conversationId: a.conversation_id, name: a.full_name, accountId: a.heyreach_account_id });
    const thread = (convo && convo.messages || [])
      .filter(m => (m.body || '').trim())
      .map(m => ({ from: m.sender === 'ME' ? 'us' : 'them', text: m.body, at: m.createdAt }));
    res.json({
      full_name: a.full_name, company_name: a.company_name, account_name: a.account_name,
      their_text: a.their_text, draft: a.draft, kind: a.kind, status: a.status, enabled: isOn(),
      headline: r.headline || '', profile_url: r.profile_url || '', thread,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/send', express.json(), auth, async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Nothing to send.' });
  if (!isOn()) return res.status(403).json({ error: 'Phone replies are switched off (REPLY_PHONE).' });
  const { db, ref } = await load(req.params.id);
  let a;
  try {
    // One send per card, even on a double tap.
    a = await db.runTransaction(async t => {
      const doc = await t.get(ref);
      if (!doc.exists) throw Object.assign(new Error('Reply not found.'), { code: 404 });
      const d = doc.data();
      if (d.status !== 'pending') throw Object.assign(new Error(`Already ${d.status}.`), { code: 409 });
      t.update(ref, { status: 'sending', sending_at: new Date() });
      return d;
    });
  } catch (e) {
    return res.status(e.code || 500).json({ error: e.message });
  }

  try {
    // If someone already answered in HeyReach after their message, stop.
    const rdoc = await db.collection('replies').doc(a.reply_id).get();
    const r = rdoc.exists ? rdoc.data() : {};
    const convo = await fetchConversation({ conversationId: a.conversation_id, name: a.full_name, accountId: a.heyreach_account_id });
    if (convo && Array.isArray(convo.messages) && convo.messages.length) {
      const last = convo.messages[convo.messages.length - 1];
      const theirAt = r.message_date ? new Date(r.message_date).getTime() : 0;
      if (last.sender === 'ME' && new Date(last.createdAt).getTime() > theirAt) {
        await ref.update({ status: 'answered_elsewhere' });
        await markCard(a, '↪️ Already answered in HeyReach. Nothing sent.');
        return res.status(409).json({ error: 'Someone already answered this in HeyReach. Nothing sent.' });
      }
    }

    const out = await axios.post(`${LOCAL()}/api/heyreach/reply`, { reply_id: a.reply_id, message: text }, { timeout: 60000, validateStatus: () => true });
    if (out.status !== 200 || !out.data?.ok) throw new Error(out.data?.error || `send failed (${out.status})`);

    await ref.update({ status: 'sent', sent_text: text, sent_at: new Date(), edited_before_send: text !== a.draft });
    await markCard(a, `✅ Sent${text !== a.draft ? ' (edited)' : ''}`);
    console.log(`[replyPhone] Sent to ${a.full_name} from phone`);
    res.json({ ok: true });
  } catch (e) {
    await ref.update({ status: 'pending', last_error: e.message }).catch(() => {});
    console.error('[replyPhone] send failed:', e.message);
    res.status(502).json({ error: `Not sent: ${e.message}` });
  }
});

router.post('/:id/edit', express.json(), auth, async (req, res) => {
  try {
    const note = String((req.body || {}).note || '').trim();
    if (!note) return res.status(400).json({ error: 'Say what to change.' });
    const { ref, a } = await load(req.params.id);
    if (!a) return res.status(404).json({ error: 'Reply not found.' });
    if (a.status !== 'pending') return res.status(409).json({ error: `Already ${a.status}.` });
    const out = await axios.post(`${LOCAL()}/api/heyreach/redraft`, { reply_id: a.reply_id, feedback: note }, { timeout: 180000, validateStatus: () => true });
    if (out.status !== 200 || !out.data?.ok) throw new Error(out.data?.error || `rewrite failed (${out.status})`);
    const draft = cleanDraft(out.data.draft_response);
    if (!draft) return res.status(502).json({ error: 'The rewrite came back empty. Edit the text directly.' });
    await ref.update({ draft, kind: 'draft', last_note: note, edited_at: new Date() });
    res.json({ ok: true, draft, note: out.data.suggested_action || '' });
  } catch (e) {
    console.error('[replyPhone] edit failed:', e.message);
    res.status(502).json({ error: e.message });
  }
});

router.post('/:id/skip', express.json(), auth, async (req, res) => {
  try {
    const { ref, a } = await load(req.params.id);
    if (!a) return res.status(404).json({ error: 'Reply not found.' });
    if (a.status !== 'pending') return res.status(409).json({ error: `Already ${a.status}.` });
    await ref.update({ status: 'skipped', skipped_at: new Date() });
    await markCard(a, '⏭ Skipped. Nothing sent.');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
