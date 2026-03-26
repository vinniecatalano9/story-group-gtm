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
    const { classification, limit, show_handled, source } = req.query;
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
    // Filter out noise classifications unless explicitly requested
    if (!classification) {
      replies = replies.filter(r => !HIDDEN_CLASSIFICATIONS.includes(r.classification));
    }
    // Default to unhandled only unless show_handled=true
    if (show_handled !== 'true') {
      replies = replies.filter(r => !r.handled);
    }
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
    const { addReply, addLog, getLeadByEmail, updateLead } = require('./services/db');
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

      // Get the latest message from conversation if available
      let messageText = '';
      if (contact.conversation && Array.isArray(contact.conversation)) {
        // Find the latest incoming message
        const incoming = contact.conversation.filter(m => m.is_incoming || m.direction === 'incoming');
        if (incoming.length > 0) {
          messageText = incoming[incoming.length - 1].message || incoming[incoming.length - 1].text || '';
        }
      }
      // Fallback to message field
      if (!messageText) {
        messageText = contact.message || contact.last_message || contact.reply_text || '';
      }

      if (!messageText.trim()) {
        console.log(`[ulinc-webhook] No message text for ${contactName}, skipping classification`);
        // Still store it as a contact received
        await addReply({
          lead_id: null, email: email || `linkedin:${contactId}`,
          reply_text: '(No message text — contact data only)',
          source: 'ulinc', ulinc_contact_id: contactId,
          contact_name: contactName, linkedin_url: contact.li_url || contact.linkedin || null,
          classification: 'other', sentiment: 'neutral',
          summary: `Contact data received for ${contactName}`,
          suggested_macro: 'NONE', suggested_action: 'Review contact',
          draft_response: '', handled: false,
        });
        processed++;
        continue;
      }

      console.log(`[ulinc-webhook] Processing ${contactName}: ${messageText.substring(0, 80)}...`);

      const lead = email ? await getLeadByEmail(email) : null;
      let slots = null;
      try { slots = await getAvailableSlots(); } catch (e) {}

      // Classify
      const { processUlincMessages } = require('./cron/ulinc-poll');
      let classification;
      try {
        const CLASSIFY_PROMPT = `You are a sales reply classifier for Story Group, a PR/media services company.
This is a LinkedIn message. Classify it and generate a draft response.
FROM: ${contactName} (${company || 'Unknown'}, first name: ${firstName || 'there'})
MESSAGE: ${messageText}
TONE: Casual, confident, conversational. Keep it LinkedIn-appropriate. 40-100 words max.
Return JSON: { "classification": "interested"|"not_interested"|"why_reach_out"|"more_info"|"cost_question"|"question_other"|"referral"|"re_engage"|"ooo"|"other", "sentiment": "positive"|"neutral"|"negative", "summary": "<1 sentence>", "suggested_macro": "CALL_TIME"|"WHY_REACH_OUT"|"MORE_INFO"|"COST_QUESTION"|"RE_ENGAGE"|"CASE_STUDY"|"REFERRAL"|"NONE", "suggested_action": "<brief>", "draft_response": "<personalized reply using macro style, mentioning go.storygroup.io/meetings/vincent-catalano if scheduling>" }
Return ONLY the JSON.`;
        classification = await claudeJSON(CLASSIFY_PROMPT, { timeout: 120000 });
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
