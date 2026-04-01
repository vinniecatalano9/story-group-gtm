require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api/ingest', require('./routes/ingest'));
app.use('/api/enrich', require('./routes/enrich'));
app.use('/api/reply', require('./routes/replies'));
app.use('/api/scraper', require('./routes/scraper'));
app.use('/api/scrapers', require('./routes/scrapers'));
app.use('/api/cleaner', require('./routes/cleaner'));
app.use('/api/fireflies', require('./routes/fireflies'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Dashboard data endpoint (for frontend)
app.get('/api/dashboard', async (req, res) => {
  try {
    const { getLeadStats } = require('./services/db');
    const stats = await getLeadStats();
    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Email funnel endpoint — Instantly analytics + reply breakdown
app.get('/api/dashboard/funnel', async (req, res) => {
  try {
    const { getCampaignAnalytics, getCampaigns } = require('./services/instantly');
    const { replies, leads } = require('./services/db');

    // 1. Instantly campaign analytics
    let campaigns = [];
    let totalSent = 0, totalOpened = 0, totalReplied = 0, totalBounced = 0;
    try {
      const analyticsData = await getCampaignAnalytics();
      campaigns = Array.isArray(analyticsData) ? analyticsData : (analyticsData?.data || []);
      for (const c of campaigns) {
        totalSent += c.emails_sent_count || c.emails_sent || c.sent || 0;
        totalOpened += c.open_count || c.emails_opened || c.opened || 0;
        totalReplied += c.reply_count || c.emails_replied || c.replied || 0;
        totalBounced += c.bounced_count || c.emails_bounced || c.bounced || 0;
      }
    } catch (e) {
      console.warn('[funnel] Instantly analytics failed:', e.message);
    }

    // 2. Reply classification breakdown from Firestore
    const replySnap = await replies.get();
    const classificationCounts = {};
    const dailyPositive = {};
    let positiveTotal = 0;
    replySnap.forEach(doc => {
      const d = doc.data();
      const cls = d.classification || 'other';
      classificationCounts[cls] = (classificationCounts[cls] || 0) + 1;
      // Count positive (interested, referral, more_info, cost_question)
      if (['interested', 'referral', 'more_info', 'cost_question'].includes(cls)) {
        positiveTotal++;
        const day = d.created_at?.toDate?.()
          ? d.created_at.toDate().toISOString().slice(0, 10)
          : (d.created_at ? new Date(d.created_at).toISOString().slice(0, 10) : 'unknown');
        dailyPositive[day] = (dailyPositive[day] || 0) + 1;
      }
    });

    // 3. Booked + closed counts
    const bookedSnap = await leads.where('status', '==', 'booked').count().get();
    const booked = bookedSnap.data().count;
    const closedSnap = await leads.where('status', '==', 'closed').count().get();
    const closedDeals = closedSnap.data().count;

    // 3b. Meetings held + second calls booked (from replies collection)
    let meetingsHeld = 0;
    let secondCallsBooked = 0;
    replySnap.forEach(doc => {
      const d = doc.data();
      if (d.had_meeting) meetingsHeld++;
      if (d.second_call_booked) secondCallsBooked++;
    });

    // 4. Per-campaign breakdown
    const campaignBreakdown = campaigns.map(c => ({
      name: c.name || c.campaign_name || 'Unknown',
      id: c.id || c.campaign_id,
      sent: c.emails_sent_count || c.emails_sent || c.sent || 0,
      opened: c.open_count || c.emails_opened || c.opened || 0,
      replied: c.reply_count || c.emails_replied || c.replied || 0,
      bounced: c.bounced_count || c.emails_bounced || c.bounced || 0,
    }));

    res.json({
      success: true,
      funnel: {
        sent: totalSent,
        opened: totalOpened,
        replied: totalReplied,
        bounced: totalBounced,
        positive: positiveTotal,
        booked,
        meetings_held: meetingsHeld,
        second_calls_booked: secondCallsBooked,
        closed_deals: closedDeals,
        classificationCounts,
        dailyPositive,
        campaignBreakdown,
      }
    });
  } catch (e) {
    console.error('[funnel] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Leads list endpoint (for frontend)
app.get('/api/leads', async (req, res) => {
  try {
    const { getLeadsPage } = require('./services/db');
    const { status, tier, limit } = req.query;
    const leads = await getLeadsPage({
      status: status || undefined,
      tier: tier || undefined,
      limit: parseInt(limit) || 50,
    });
    res.json({ success: true, leads });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Replies list endpoint (for frontend)
const HIDDEN_CLASSIFICATIONS = ['not_interested', 'bounce', 'ooo'];
app.get('/api/replies', async (req, res) => {
  try {
    const { getRepliesPage } = require('./services/db');
    const { classification, limit, show_handled, source, ulinc_status } = req.query;
    let replies = await getRepliesPage({
      classification: classification || undefined,
      limit: parseInt(limit) || 100,
    });
    // Filter by source (email vs ulinc)
    if (source === 'ulinc') {
      replies = replies.filter(r => r.source === 'ulinc');
    } else if (source === 'email') {
      replies = replies.filter(r => r.source !== 'ulinc');
    }
    // Filter by Ulinc status
    if (ulinc_status) {
      replies = replies.filter(r => r.ulinc_status === ulinc_status);
    }
    // Filter out noise classifications unless explicitly requested
    if (!classification) {
      replies = replies.filter(r => !HIDDEN_CLASSIFICATIONS.includes(r.classification));
    }
    // Default to unhandled only unless show_handled=true
    if (show_handled !== 'true') {
      replies = replies.filter(r => !r.handled);
    }
    // Sort by message_date (actual Ulinc timestamp) falling back to created_at, newest first
    replies.sort((a, b) => {
      const da = a.message_date?._seconds ? a.message_date._seconds * 1000 : (a.message_date ? new Date(a.message_date).getTime() : 0);
      const db = b.message_date?._seconds ? b.message_date._seconds * 1000 : (b.message_date ? new Date(b.message_date).getTime() : 0);
      const ca = a.created_at?._seconds ? a.created_at._seconds * 1000 : (a.created_at ? new Date(a.created_at).getTime() : 0);
      const cb = b.created_at?._seconds ? b.created_at._seconds * 1000 : (b.created_at ? new Date(b.created_at).getTime() : 0);
      return (db || cb) - (da || ca);
    });
    res.json({ success: true, replies: replies.slice(0, parseInt(limit) || 50) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get conversation history for a Ulinc contact (pulls from Ulinc API, falls back to Firestore)
app.get('/api/ulinc/conversation/:contactId', async (req, res) => {
  try {
    const { getConversation } = require('./services/ulinc');
    const contactId = parseInt(req.params.contactId) || req.params.contactId;

    // Try Ulinc's Complete Conversation API first
    const ulincData = await getConversation(contactId);
    if (ulincData) {
      // Ulinc returns messages with: message, created_at, method, is_incoming, attachments
      const messages = Array.isArray(ulincData) ? ulincData : (ulincData.messages || ulincData.data || []);
      return res.json({
        success: true,
        source: 'ulinc',
        messages: messages.map(m => ({
          message: m.message || m.text || '',
          created_at: m.created_at || m.time || null,
          is_incoming: m.is_incoming ?? true,
          method: m.method || 'linkedin',
        })),
      });
    }

    // Fallback: pull from our Firestore
    const { replies } = require('./services/db');
    const snap = await replies
      .where('ulinc_contact_id', '==', contactId)
      .orderBy('created_at', 'asc')
      .limit(20)
      .get();
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, source: 'firestore', messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ulinc "Send to webhook" receiver — processes contact data pushed from Ulinc
app.post('/api/ulinc/webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('[ulinc-webhook] Received push:', JSON.stringify(data).substring(0, 500));

    const { claudeJSON } = require('./services/claude');
    const { replies, addReply, addLog, getLeadByEmail, updateLead } = require('./services/db');
    const { syncLead } = require('./services/hubspot');
    const { notifyNewReply } = require('./services/slack');
    const { getAvailableSlots } = require('./services/calendar');

    // Ulinc can send single contact or array
    const contacts = Array.isArray(data) ? data : [data];
    let processed = 0;

    for (const contact of contacts) {
      const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown';
      const email = contact.email || contact.li_email || null;
      const company = contact.company || contact.company_name || null;
      const firstName = contact.first_name || null;
      const contactId = contact.id || contact.contact_id || null;

      // Get the latest message from conversations array (Ulinc "Send to webhook" format)
      let messageText = '';
      let messageTime = null;
      const convos = contact.conversations || contact.conversation;
      if (convos && Array.isArray(convos)) {
        // Find the latest incoming message
        const incoming = convos.filter(m => m.type === 'incoming' || m.is_incoming || m.direction === 'incoming');
        if (incoming.length > 0) {
          const latest = incoming[incoming.length - 1];
          // Ulinc sends message text as base64 in text_base64 field
          if (latest.text_base64) {
            messageText = Buffer.from(latest.text_base64, 'base64').toString('utf-8').trim();
          } else {
            messageText = latest.text || latest.message || latest.body || '';
          }
          // Capture the actual message timestamp
          // Ulinc timestamps are 1 year behind — fix by adding 1 year
          if (latest.time) {
            messageTime = new Date(latest.time);
            messageTime.setFullYear(messageTime.getFullYear() + 1);
          }
        }
      }
      // Fallback to message field
      if (!messageText) {
        messageText = contact.message || contact.last_message || contact.reply_text || '';
      }

      if (!messageText.trim()) {
        // Skip contacts with no actual message — only process real replies
        continue;
      }

      console.log(`[ulinc-webhook] Processing ${contactName}: ${messageText.substring(0, 80)}...`);

      // Dedup: skip if we already have a reply with the same contact_id + same message text
      if (contactId) {
        const dupCheck = await replies.where('ulinc_contact_id', '==', String(contactId)).get();
        const existing = dupCheck.docs.find(d => d.data().reply_text === messageText);
        if (existing) {
          console.log(`[ulinc-webhook] Skipping duplicate for ${contactName} (contact ${contactId})`);
          continue;
        }
      }

      const lead = email ? await getLeadByEmail(email) : null;
      let slots = null;
      try { slots = await getAvailableSlots(); } catch (e) {}

      // Classify — use the same playbook prompt as the poller
      let classification;
      try {
        const { CLASSIFY_PROMPT } = require('./cron/ulinc-poll');
        const prompt = CLASSIFY_PROMPT ? CLASSIFY_PROMPT(contactName, company, messageText, firstName, null) : `Classify this LinkedIn reply. FROM: ${contactName}. MESSAGE: ${messageText}. Return JSON with classification, sentiment, summary, suggested_macro, suggested_action, draft_response.`;
        classification = await claudeJSON(prompt, { timeout: 120000 });
      } catch (e) {
        console.error(`[ulinc-webhook] Classification failed for ${contactName}:`, e.message);
        classification = { classification: 'other', sentiment: 'neutral', summary: 'Classification failed', suggested_macro: 'NONE', suggested_action: 'Review manually', draft_response: '' };
      }

      const replyId = await addReply({
        lead_id: lead?.id || null,
        email: email || `linkedin:${contactId}`,
        reply_text: messageText, source: 'ulinc',
        ulinc_contact_id: contactId, contact_name: contactName,
        linkedin_url: contact.li_url || contact.linkedin || null,
        message_date: messageTime || new Date(),
        ...classification, handled: false,
      });

      const cls = classification.classification;
      if (lead) {
        if (cls === 'not_interested') await updateLead(lead.id, { status: 'dead', last_reply: cls });
        else if (cls !== 'ooo') await updateLead(lead.id, { status: 'replied', last_reply: cls });
        try { await syncLead({ ...lead, last_reply: cls }); } catch (e) {}
      }

      if (cls !== 'ooo' && cls !== 'not_interested') {
        await notifyNewReply({
          email: `${contactName} (LinkedIn${email ? ` / ${email}` : ''})`,
          company: company || lead?.company_name,
          classification: cls, sentiment: classification.sentiment,
          summary: `[LinkedIn] ${classification.summary}`,
          draftResponse: classification.draft_response, pastReplies: [],
        });
      }

      await addLog('ulinc_webhook', { contact_id: contactId, name: contactName, classification: cls });
      console.log(`[ulinc-webhook] ${contactName} → ${cls} (${classification.sentiment})`);
      processed++;
    }

    res.json({ success: true, processed });
  } catch (e) {
    console.error('[ulinc-webhook] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Send an email reply via Instantly
app.post('/api/instantly/send', async (req, res) => {
  try {
    const { replyToEmail } = require('./services/instantly');
    const { addLog } = require('./services/db');
    const { email_uuid, eaccount, message, reply_id } = req.body;
    if (!email_uuid || !eaccount || !message) {
      return res.status(400).json({ error: 'email_uuid, eaccount, and message required' });
    }

    const result = await replyToEmail(email_uuid, eaccount, message);

    // Mark the reply as handled
    if (reply_id) {
      const { replies } = require('./services/db');
      await replies.doc(reply_id).update({ handled: true, handled_at: new Date(), sent_response: message });
    }

    await addLog('instantly_send', { email_uuid, message_length: message.length });
    console.log(`[instantly] Sent reply to thread ${email_uuid}`);
    res.json({ success: true, result });
  } catch (e) {
    console.error('[instantly] Send failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Send a LinkedIn reply via Ulinc
app.post('/api/ulinc/send', async (req, res) => {
  try {
    const { sendMessage } = require('./services/ulinc');
    const { addLog } = require('./services/db');
    const { contact_id, message, reply_id } = req.body;
    if (!contact_id || !message) return res.status(400).json({ error: 'contact_id and message required' });

    const result = await sendMessage(contact_id, message);

    // Mark the reply as handled if reply_id provided
    if (reply_id) {
      const { replies } = require('./services/db');
      await replies.doc(reply_id).update({ handled: true, handled_at: new Date(), sent_response: message });
    }

    await addLog('ulinc_send', { contact_id, message_length: message.length });
    console.log(`[ulinc] Sent reply to contact ${contact_id}`);
    res.json({ success: true, result });
  } catch (e) {
    console.error('[ulinc] Send failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Mark a reply as handled
app.patch('/api/replies/:id/handled', async (req, res) => {
  try {
    const { replies } = require('./services/db');
    await replies.doc(req.params.id).update({ handled: true, handled_at: new Date() });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Set Ulinc status on a reply (talking, replied, no_interest, later, old_connect)
app.patch('/api/replies/:id/ulinc-status', async (req, res) => {
  try {
    const { replies } = require('./services/db');
    const { ulinc_status } = req.body;
    const valid = ['talking', 'replied', 'meeting_booked', 'no_interest', 'later', 'old_connect'];
    if (!valid.includes(ulinc_status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` });
    await replies.doc(req.params.id).update({ ulinc_status, ulinc_status_at: new Date() });
    res.json({ success: true, ulinc_status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update reply tracking fields (had_meeting, sent_proposal, follow_up_date, notes)
app.patch('/api/replies/:id', async (req, res) => {
  try {
    const { replies } = require('./services/db');
    const allowed = ['had_meeting', 'sent_proposal', 'second_call_booked', 'closed_deal', 'follow_up_date', 'notes', 'meeting_date', 'proposal_date', 'second_call_date', 'closed_date'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date();
    await replies.doc(req.params.id).update(updates);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get conversation thread for a specific email address
app.get('/api/replies/thread/:email', async (req, res) => {
  try {
    const { replies } = require('./services/db');
    const email = req.params.email.toLowerCase();
    // Try lowercase match first, fall back to original case
    let snap = await replies.where('email', '==', email).get();
    if (snap.empty) {
      snap = await replies.where('email', '==', req.params.email).get();
    }
    const thread = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Sort client-side to avoid needing composite index
    thread.sort((a, b) => {
      const tA = a.created_at?._seconds || (a.created_at ? new Date(a.created_at).getTime() / 1000 : 0);
      const tB = b.created_at?._seconds || (b.created_at ? new Date(b.created_at).getTime() / 1000 : 0);
      return tA - tB;
    });
    res.json({ success: true, thread });
  } catch (e) {
    console.error('[thread] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Instantly replied leads + subsequence data
app.get('/api/instantly/leads', async (req, res) => {
  try {
    const { getAllRepliedLeads, getCampaigns, getSubsequences, getSubsequenceEntries } = require('./services/instantly');

    // Get all replied leads
    const repliedLeads = await getAllRepliedLeads();

    // Get all campaigns + subsequences with enrolled leads
    const campaignsRes = await getCampaigns();
    const campList = campaignsRes?.items || [];
    const subsequenceData = [];
    for (const c of campList) {
      const subs = await getSubsequences(c.id);
      for (const sub of subs) {
        const entries = await getSubsequenceEntries(sub.id);
        if (entries.length > 0) {
          subsequenceData.push({
            campaign_name: c.name,
            campaign_id: c.id,
            subsequence_name: sub.name,
            subsequence_id: sub.id,
            leads: entries,
          });
        }
      }
    }

    res.json({ success: true, repliedLeads, subsequenceData });
  } catch (e) {
    console.error('[instantly/leads] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get subsequences for a campaign
app.get('/api/instantly/subsequences', async (req, res) => {
  try {
    const { getSubsequences, getCampaigns } = require('./services/instantly');
    const { campaign_id } = req.query;
    if (campaign_id) {
      const subs = await getSubsequences(campaign_id);
      return res.json({ success: true, subsequences: subs });
    }
    // Get subsequences for all campaigns
    const campaigns = await getCampaigns();
    const campList = campaigns?.items || campaigns?.campaigns || (Array.isArray(campaigns) ? campaigns : []);
    const allSubs = {};
    for (const c of campList) {
      const id = c.id || c.campaign_id;
      const subs = await getSubsequences(id);
      if (subs.length > 0) allSubs[c.name || id] = { campaign_id: id, subsequences: subs };
    }
    res.json({ success: true, campaigns: allSubs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add lead to a subsequence
app.post('/api/instantly/subsequence/add', async (req, res) => {
  try {
    const { addLeadToSubsequence } = require('./services/instantly');
    const { email, subsequence_id, campaign_id } = req.body;
    if (!email || !subsequence_id) return res.status(400).json({ error: 'email and subsequence_id required' });
    const result = await addLeadToSubsequence(email, subsequence_id, campaign_id);
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger endpoints
app.post('/api/trigger/cleanup', async (req, res) => {
  try {
    const { runCleanup } = require('./cron/cleanup');
    await runCleanup();
    res.json({ success: true, message: 'Cleanup complete' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trigger/dashboard', async (req, res) => {
  try {
    const { runDashboard } = require('./cron/dashboard');
    const report = await runDashboard();
    res.json({ success: true, report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trigger/daily-metrics', async (req, res) => {
  try {
    const { runDailyMetrics } = require('./cron/daily-metrics');
    const snapshot = await runDailyMetrics();
    res.json({ success: true, snapshot });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daily metrics history (last N days)
app.get('/api/dashboard/daily-metrics', async (req, res) => {
  try {
    const { dailyMetrics } = require('./cron/daily-metrics');
    const days = parseInt(req.query.days) || 30;
    const snap = await dailyMetrics.orderBy('date', 'desc').limit(days).get();
    const metrics = snap.docs.map(d => d.data());
    res.json({ success: true, metrics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ulinc LinkedIn message poller (every 60 seconds)
if (process.env.ULINC_NEW_MESSAGE_URL) {
  const { processUlincMessages } = require('./cron/ulinc-poll');
  setInterval(async () => {
    try { await processUlincMessages(); } catch (e) {
      console.error('[ulinc-poll] Error:', e.message);
    }
  }, 60000);
  // Run once on startup after a short delay
  setTimeout(() => processUlincMessages().catch(e => console.error('[ulinc-poll] Startup error:', e.message)), 5000);
  console.log('   Ulinc: Polling every 60s');
}

// Cron Jobs
// Weekly cleanup: Sunday 11pm EST
cron.schedule('0 23 * * 0', async () => {
  console.log('[cron] Running weekly cleanup...');
  const { runCleanup } = require('./cron/cleanup');
  await runCleanup();
}, { timezone: 'America/New_York' });

// Weekly dashboard: Monday 8am EST
cron.schedule('0 8 * * 1', async () => {
  console.log('[cron] Running weekly dashboard...');
  const { runDashboard } = require('./cron/dashboard');
  await runDashboard();
}, { timezone: 'America/New_York' });

// Daily metrics snapshot: Every day 11:59pm EST
cron.schedule('59 23 * * *', async () => {
  console.log('[cron] Running daily metrics snapshot...');
  const { runDailyMetrics } = require('./cron/daily-metrics');
  await runDailyMetrics();
}, { timezone: 'America/New_York' });

// Auto-deploy: pull + rebuild backend + rebuild frontend + firebase deploy
// Triggered by GitHub webhook or manual POST
app.post('/api/deploy', async (req, res) => {
  console.log('[deploy] Triggered — running full deploy...');
  res.json({ success: true, message: 'Deploy started' });
  const { exec } = require('child_process');
  exec('/root/story-group-gtm/deploy.sh 2>&1', { timeout: 300000 }, (err, stdout, stderr) => {
    if (err) console.error('[deploy] Failed:', err.message);
    else console.log('[deploy] Complete:\n' + stdout.slice(-500));
  });
});

// Start
app.listen(PORT, () => {
  console.log(`\n🚀 Story Group GTM Engine running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Ingest: POST http://localhost:${PORT}/api/ingest`);
  console.log(`   Enrich: POST http://localhost:${PORT}/api/enrich`);
  console.log(`   Reply:  POST http://localhost:${PORT}/api/reply`);
  console.log(`   Scraper: POST http://localhost:${PORT}/api/scraper`);
  console.log(`   Scrapers: http://localhost:${PORT}/api/scrapers`);
  console.log(`   Ulinc: ${process.env.ULINC_NEW_MESSAGE_URL ? 'Active (polling)' : 'Not configured'}`);
  console.log(`\n   Cron: Cleanup Sun 11pm EST, Dashboard Mon 8am EST\n`);
});
