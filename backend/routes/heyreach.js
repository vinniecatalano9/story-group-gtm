const express = require('express');
const { classifyReply } = require('../services/replyClassifier');
const axios = require('axios');
const router = express.Router();

const HEYREACH_BASE = 'https://api.heyreach.io/api/public';

function headers() {
  const key = process.env.HEYREACH_API_KEY;
  if (!key) throw new Error('HEYREACH_API_KEY not set');
  return { 'X-API-KEY': key, 'Content-Type': 'application/json' };
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function isoDate(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return dt.toISOString();
}

router.get('/health', async (req, res) => {
  try {
    const r = await axios.get(`${HEYREACH_BASE}/auth/CheckApiKey`, { headers: headers() });
    res.json({ ok: true, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, status: e.response?.status });
  }
});

router.get('/accounts', async (req, res) => {
  try {
    const r = await axios.post(`${HEYREACH_BASE}/li_account/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
    const items = (r.data?.items || []).map(a => ({
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      fullName: [a.firstName, a.lastName].filter(Boolean).join(' '),
      emailAddress: a.emailAddress,
      status: a.status,
      headline: a.headline
    }));
    res.json({ totalCount: r.data?.totalCount || 0, items });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

router.get('/campaigns', async (req, res) => {
  try {
    const r = await axios.post(`${HEYREACH_BASE}/campaign/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
    const items = (r.data?.items || []).map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      createdAt: c.createdAt
    }));
    res.json({ totalCount: r.data?.totalCount || 0, items });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

/**
 * GET /api/heyreach/stats
 *   ?accountIds=1,2,3      (optional — defaults to all accounts)
 *   ?campaignIds=10,11     (optional — defaults to all campaigns)
 *   ?from=YYYY-MM-DD       (optional — defaults to today)
 *   ?to=YYYY-MM-DD         (optional — defaults to today)
 *
 * Returns the Heyreach stats payload plus a flattened summary tuned
 * for the daily tracker UI.
 */
router.get('/stats', async (req, res) => {
  try {
    let accountIds = req.query.accountIds
      ? String(req.query.accountIds).split(',').map(s => Number(s)).filter(Boolean)
      : [];
    let campaignIds = req.query.campaignIds
      ? String(req.query.campaignIds).split(',').map(s => Number(s)).filter(Boolean)
      : [];

    if (!accountIds.length) {
      const a = await axios.post(`${HEYREACH_BASE}/li_account/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
      accountIds = (a.data?.items || []).map(x => x.id);
    }
    if (!campaignIds.length) {
      const c = await axios.post(`${HEYREACH_BASE}/campaign/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
      campaignIds = (c.data?.items || []).map(x => x.id);
    }

    if (!accountIds.length) return res.json({ items: [], summary: {}, note: 'No LinkedIn sender accounts connected in Heyreach yet.' });
    if (!campaignIds.length) return res.json({ items: [], summary: {}, note: 'No campaigns in Heyreach yet.' });

    const from = req.query.from ? `${req.query.from}T00:00:00.000Z` : `${todayISO()}T00:00:00.000Z`;
    const to   = req.query.to   ? `${req.query.to}T23:59:59.999Z`   : `${todayISO()}T23:59:59.999Z`;

    const body = {
      accountIds: accountIds,
      campaignIds: campaignIds,
      startDate: from,
      endDate: to
    };

    const r = await axios.post(`${HEYREACH_BASE}/stats/GetOverallStats`, body, { headers: headers() });
    const data = r.data || {};

    const stats = data.overallStats || data;
    const totalReplies = (stats.totalMessageReplies || 0) + (stats.totalInmailReplies || 0);
    const positive = stats.autoTaggedInterested || 0;
    const summary = {
      requestsSent:     stats.connectionsSent       || 0,
      requestsAccepted: stats.connectionsAccepted   || 0,
      inmailsSent:      stats.inmailMessagesSent    || 0,
      positiveReplies:  positive,
      normalReplies:    Math.max(0, totalReplies - positive),
      meetingsBooked:   stats.totalMeetingsBooked   || 0
    };

    res.json({ from, to, accountIds, campaignIds, summary, raw: data });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

/**
 * GET /api/heyreach/stats/per-account
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Fans out one stats call per account so the tracker can pre-fill a row per sender.
 */
router.get('/stats/per-account', async (req, res) => {
  try {
    const a = await axios.post(`${HEYREACH_BASE}/li_account/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
    const accounts = a.data?.items || [];
    if (!accounts.length) return res.json({ items: [], note: 'No LinkedIn sender accounts connected in Heyreach yet.' });

    const c = await axios.post(`${HEYREACH_BASE}/campaign/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
    const campaignIds = (c.data?.items || []).map(x => x.id);
    if (!campaignIds.length) return res.json({ items: accounts.map(acc => ({
      id: acc.id, fullName: [acc.firstName, acc.lastName].filter(Boolean).join(' '), summary: null
    })), note: 'No campaigns in Heyreach yet.' });

    const from = req.query.from ? `${req.query.from}T00:00:00.000Z` : `${todayISO()}T00:00:00.000Z`;
    const to   = req.query.to   ? `${req.query.to}T23:59:59.999Z`   : `${todayISO()}T23:59:59.999Z`;

    const items = await Promise.all(accounts.map(async (acc) => {
      try {
        const r = await axios.post(`${HEYREACH_BASE}/stats/GetOverallStats`, {
          accountIds: [acc.id], campaignIds, startDate: from, endDate: to
        }, { headers: headers() });
        const d = r.data || {};
        const s = d.overallStats || d;
        const totalReplies = (s.totalMessageReplies || 0) + (s.totalInmailReplies || 0);
        const positive = s.autoTaggedInterested || 0;
        return {
          id: acc.id,
          fullName: [acc.firstName, acc.lastName].filter(Boolean).join(' '),
          summary: {
            requestsSent:     s.connectionsSent       || 0,
            requestsAccepted: s.connectionsAccepted   || 0,
            inmailsSent:      s.inmailMessagesSent    || 0,
            positiveReplies:  positive,
            normalReplies:    Math.max(0, totalReplies - positive),
            meetingsBooked:   s.totalMeetingsBooked   || 0
          }
        };
      } catch (e) {
        return { id: acc.id, fullName: [acc.firstName, acc.lastName].filter(Boolean).join(' '), error: e.message };
      }
    }));

    res.json({ from, to, items });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

/**
 * POST /api/heyreach/campaign/:id/push
 * Push an array of leads to an existing Heyreach campaign.
 * Body: { leads: [{ linkedinUrl, firstName, lastName, company, position, location }] }
 * Optional body field: linkedInAccountId (number) — if specified, all leads
 *   are assigned to that sender account.
 */
router.post('/campaign/:id/push', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });

    const leads = Array.isArray(req.body?.leads) ? req.body.leads : null;
    if (!leads || !leads.length) return res.status(400).json({ error: 'leads array required' });

    const accountId = req.body?.linkedInAccountId ? Number(req.body.linkedInAccountId) : null;

    // Heyreach API takes leads in batches of up to 100.
    const BATCH = 100;
    let added = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < leads.length; i += BATCH) {
      const batch = leads.slice(i, i + BATCH);
      const accountLeadPairs = batch
        .filter(l => l && l.linkedinUrl)
        .map(l => ({
          leadDto: {
            firstName: l.firstName || '',
            lastName: l.lastName || '',
            profileUrl: l.linkedinUrl,
            location: l.location || '',
            summary: l.headline || '',
            companyName: l.company || '',
            position: l.position || l.title || ''
          },
          linkedInAccountId: accountId
        }));

      if (!accountLeadPairs.length) {
        skipped += batch.length;
        continue;
      }

      try {
        const r = await axios.post(
          `${HEYREACH_BASE}/campaign/AddLeadsToCampaignV2`,
          { campaignId, accountLeadPairs },
          { headers: headers() }
        );
        added += accountLeadPairs.length;
      } catch (e) {
        errors.push({
          batchStart: i,
          batchSize: accountLeadPairs.length,
          status: e.response?.status,
          message: e.response?.data?.detail || e.response?.data?.error || e.message
        });
        skipped += accountLeadPairs.length;
      }
    }

    res.json({
      ok: errors.length === 0,
      campaignId,
      totalLeads: leads.length,
      added,
      skipped,
      errors
    });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});



/**
 * POST /api/heyreach/reply
 * Send a reply into the lead's HeyReach conversation from the dashboard.
 * Body: { reply_id, message, single?, done? }
 *   single=true — send `message` as ONE LinkedIn message, no splitting.
 *     The dashboard sends each playbook message individually so Vincent
 *     controls the pacing instead of all 3 firing at once.
 *   done=true — mark the reply handled after this send (the dashboard sets
 *     it on the final message). Legacy mode (no `single`) splits on blank
 *     lines and marks handled.
 */
router.post('/reply', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { reply_id, message, single, done } = req.body || {};
    if (!reply_id || !(message || '').trim()) {
      return res.status(400).json({ error: 'reply_id and message required' });
    }

    const { db } = require('../services/db');
    const ref = db.collection('replies').doc(reply_id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'reply not found' });
    const d = doc.data();

    const raw = d.raw_payload?.data || d.raw_payload || {};
    const conversationId = d.heyreach_conversation_id || raw.conversation_id || null;
    const linkedInAccountId = Number(d.heyreach_account_id || raw.sender?.id) || null;
    if (!conversationId || !linkedInAccountId) {
      return res.status(400).json({ error: 'No HeyReach conversation/account on this reply — answer it in HeyReach directly.' });
    }

    const blocks = single
      ? [message.replace(/^Message\s*\d+\s*:\s*/i, '').trim()].filter(Boolean)
      : message.split(/\n{2,}/)
          .map(b => b.replace(/^Message\s*\d+\s*:\s*/i, '').trim())
          .filter(Boolean);

    const sentBlocks = [];
    for (const block of blocks) {
      await axios.post(`${HEYREACH_BASE}/inbox/SendMessage`,
        { conversationId, linkedInAccountId, message: block },
        { headers: headers() });
      sentBlocks.push(block);
      if (blocks.length > 1) await new Promise(r => setTimeout(r, 1500));
    }

    const priorSent = d.sent_text ? d.sent_text + '\n\n' : '';
    const markHandled = single ? done === true : true;
    await ref.update({
      ...(markHandled ? { handled: true } : {}),
      sent_at: new Date(),
      sent_text: priorSent + sentBlocks.join('\n\n'),
      sent_via: 'heyreach',
    });

    console.log(`[heyreach reply] Sent ${sentBlocks.length} message(s) to ${d.full_name || conversationId}`);
    res.json({ ok: true, sent: sentBlocks.length });
  } catch (e) {
    console.error('[heyreach reply] Error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.detail || e.response?.data?.error || e.message });
  }
});

/**
 * POST /api/heyreach/webhook
 *
 * Heyreach posts here on every Message/InMail reply received.
 * We accept the payload defensively (field names vary by Heyreach release),
 * normalize the important fields, and write a row to the replies collection
 * with source='heyreach' so the LinkedIn Replies page picks it up.
 *
 * Configured in Heyreach: Settings -> Webhooks -> Every Message/InMail Reply Received.
 */
// Pull the newest inbound message out of Heyreach's recent_messages array
// (the real payload shape — event_type: every_message_reply_received).
function extractReplyText(evt) {
  const msgs = Array.isArray(evt.recent_messages) ? evt.recent_messages : [];
  const replies = msgs.filter(m => m && m.is_reply && (m.message || '').trim());
  const pick = replies.length ? replies[replies.length - 1] : (msgs[msgs.length - 1] || null);
  if (pick && (pick.message || '').trim()) {
    return { text: pick.message.trim(), date: pick.creation_time || null };
  }
  // Legacy / alternate shapes
  const message = evt.message || evt.reply || evt;
  const text = message.text || message.body || message.content ||
    (typeof message.message === 'string' ? message.message : '') ||
    message.replyText || '';
  return { text: (text || '').trim(), date: message.timestamp || message.sentAt || message.createdAt || message.created_at || null };
}

// Heyreach tags come as ["Interested"] or [{ name: "Interested" }]
function extractTags(lead) {
  const raw = Array.isArray(lead.tags) ? lead.tags : [];
  return raw.map(t => (typeof t === 'string' ? t : (t && (t.name || t.tag)) || '')).filter(Boolean);
}

router.post('/webhook', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const payload = req.body || {};

    // Heyreach sends nested data. Try common field shapes:
    const evt = payload.data || payload.event || payload.payload || payload;

    const lead = evt.lead || evt.contact || evt.prospect || evt.linkedInLead || {};
    const account = evt.account || evt.linkedInAccount || evt.sender || {};
    const message = evt.message || evt.reply || evt;

    const firstName = lead.firstName || lead.first_name || (lead.name || '').split(' ')[0] || '';
    const lastName  = lead.lastName  || lead.last_name  || (lead.name || '').split(' ').slice(1).join(' ') || '';
    const fullName  = [firstName, lastName].filter(Boolean).join(' ') || lead.fullName || lead.full_name || lead.name || '';
    const profileUrl = lead.profileUrl || lead.linkedin_url || lead.linkedinUrl || lead.profile_url || '';
    const companyName = lead.companyName || lead.company_name || lead.company || '';

    const tags = extractTags(lead);
    const isInterestedTag = tags.some(t => /interested/i.test(t) && !/not.?interested/i.test(t));
    const eventType = (evt.event_type || payload.event_type || '').toLowerCase();

    // Tag-change webhook (e.g. auto-tag "Interested" applied after the reply):
    // update the lead's most recent reply doc instead of creating a duplicate.
    if (eventType.includes('tag') && !Array.isArray(evt.recent_messages)) {
      const { db } = require('../services/db');
      if (profileUrl) {
        // No orderBy — avoids needing a composite Firestore index; sort in code.
        const snap = await db.collection('replies')
          .where('profile_url', '==', profileUrl).limit(20).get();
        if (!snap.empty) {
          const newest = snap.docs.slice().sort((a, b) => {
            const ta = a.data().created_at?.toMillis ? a.data().created_at.toMillis() : 0;
            const tb = b.data().created_at?.toMillis ? b.data().created_at.toMillis() : 0;
            return tb - ta;
          })[0];
          await newest.ref.update({
            heyreach_tags: tags,
            auto_tag_interested: isInterestedTag,
            ...(isInterestedTag ? { handled: false } : {}),
          });
          console.log(`[heyreach webhook] Tag update for ${fullName || profileUrl}: ${tags.join(', ')}`);
          return res.json({ ok: true, updated: newest.id, tags });
        }
      }
      console.log(`[heyreach webhook] Tag update with no matching reply (${fullName || profileUrl}): ${tags.join(', ')}`);
      return res.json({ ok: true, ignored: 'tag update, no matching reply', tags });
    }

    const extracted = extractReplyText(evt);
    const replyText = extracted.text;
    const messageDate = extracted.date || evt.timestamp || new Date().toISOString();

    const accountName = [account.firstName, account.lastName].filter(Boolean).join(' ') || account.fullName || account.name || '';
    const accountId = account.id || account.accountId || null;
    const campaignId = evt.campaignId || evt.campaign_id || (evt.campaign && evt.campaign.id) || null;
    const campaignName = (evt.campaign && (evt.campaign.name || evt.campaign.campaignName)) || evt.campaignName || '';

    // Skip if this is our own outbound (direction=outgoing) — only ingest INCOMING replies
    const direction = (message.direction || evt.direction || '').toLowerCase();
    if (direction && direction !== 'incoming' && direction !== 'inbound' && direction !== 'received') {
      return res.json({ ok: true, ignored: 'outbound message' });
    }

    if (!replyText && !profileUrl) {
      console.warn('[heyreach webhook] Empty payload — saving nothing. Body:', JSON.stringify(payload).slice(0, 500));
      return res.json({ ok: true, ignored: 'empty' });
    }

    // Save to Firestore via the same db.addReply path the Instantly handler uses.
    const { db } = require('../services/db');
    const replyDoc = {
      source: 'heyreach',
      email: null,
      lead_id: null,
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      lead_name: fullName,
      profile_url: profileUrl,
      company_name: companyName,
      reply_text: replyText,
      message_date: messageDate,
      heyreach_account_id: accountId,
      heyreach_account_name: accountName,
      heyreach_campaign_id: campaignId,
      heyreach_campaign_name: campaignName,
      heyreach_tags: tags,
      heyreach_conversation_id: evt.conversation_id || null,
      auto_tag_interested: isInterestedTag,
      raw_payload: payload,
      handled: false,
      classification: 'other',          // default until classifier runs
      created_at: new Date(),
    };
    const ref = await db.collection('replies').add(replyDoc);
    console.log(`[heyreach webhook] Saved reply ${ref.id} from ${fullName || profileUrl}`);

    // Fire-and-forget classify-and-draft using the shared playbook
    (async () => {
      try {
        const cls = await classifyReply({
          channel: 'linkedin',
          email: null,
          company: companyName,
          replyText,
          firstName,
          slots: null,
        });
        const update = {
          classification: cls.classification || 'other',
          sentiment: cls.sentiment || 'neutral',
          summary: cls.summary || '',
          suggested_macro: cls.suggested_macro || 'NONE',
          suggested_action: cls.suggested_action || '',
          draft_response: cls.draft_response || '',
        };
        // Heyreach auto-tagged this lead Interested — never let it land without
        // a draft. Fall back to the playbook's INTERESTED soft ask (LinkedIn split).
        if (isInterestedTag && !update.draft_response) {
          const fn = firstName || 'there';
          update.classification = 'interested';
          update.sentiment = 'positive';
          update.suggested_macro = 'INTERESTED_SOFT_ASK';
          update.suggested_action = 'Reply with soft ask, no link yet.';
          update.draft_response =
            `Message 1: Hey ${fn}, glad to hear it. We pitch founders' stories straight to reporters and producers who cover your space and earn the coverage, no paid placement.\n\n` +
            `Message 2: Are you free for a quick call this week?`;
        }
        await ref.update(update);
        console.log(`[heyreach webhook] Classified ${ref.id} as ${cls.classification}`);
      } catch (e) {
        console.error(`[heyreach webhook] Classify failed for ${ref.id}:`, e.message);
      }
    })();

    res.json({ ok: true, id: ref.id });
  } catch (e) {
    console.error('[heyreach webhook] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
