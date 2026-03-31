const express = require('express');
const router = express.Router();
const { leads, replies } = require('../services/db');
const fireflies = require('../services/fireflies');
const coteriehq = require('../services/coteriehq');

/**
 * POST /api/fireflies/webhook
 * Fireflies webhook — fires on transcription.complete
 * Matches participant emails to leads/replies and attaches transcript.
 */
router.post('/webhook', async (req, res) => {
  try {
    const { meetingId, transcriptId, eventType } = req.body;
    console.log(`[fireflies] Webhook received: event=${eventType}, meetingId=${meetingId}, transcriptId=${transcriptId}`);

    if (eventType !== 'Transcription completed') {
      return res.json({ success: true, skipped: true, reason: 'Not a transcription.complete event' });
    }

    const tid = transcriptId || meetingId;
    if (!tid) return res.status(400).json({ error: 'No transcriptId or meetingId' });

    // Fetch full transcript from Fireflies API
    let transcript;
    try {
      transcript = await fireflies.getTranscript(tid);
    } catch (e) {
      console.error('[fireflies] Failed to fetch transcript:', e.message);
      return res.status(502).json({ error: 'Failed to fetch transcript from Fireflies' });
    }

    if (!transcript) return res.status(404).json({ error: 'Transcript not found' });

    const participants = transcript.participants || [];
    console.log(`[fireflies] Transcript "${transcript.title}" — participants: ${participants.join(', ')}`);

    // Extract emails from participants (Fireflies returns email strings)
    const emails = participants
      .map(p => p.toLowerCase().trim())
      .filter(p => p.includes('@'));

    if (emails.length === 0) {
      console.log('[fireflies] No participant emails found, storing orphan transcript');
    }

    const transcriptData = {
      fireflies_id: transcript.id,
      title: transcript.title,
      date: transcript.date ? new Date(transcript.date).toISOString() : new Date().toISOString(),
      duration: transcript.duration,
      transcript_url: transcript.transcript_url || null,
      audio_url: transcript.audio_url || null,
      video_url: transcript.video_url || null,
      overview: transcript.summary?.overview || null,
      action_items: transcript.summary?.action_items || null,
      keywords: transcript.summary?.keywords || null,
      participants: participants,
      matched_at: new Date().toISOString(),
    };

    let matchedLeads = 0;
    let matchedReplies = 0;

    for (const email of emails) {
      // Match against replies collection
      const replySnap = await replies.where('email', '==', email).get();
      for (const doc of replySnap.docs) {
        const existing = doc.data().transcripts || [];
        // Don't duplicate
        if (existing.some(t => t.fireflies_id === transcript.id)) continue;
        await doc.ref.update({
          transcripts: [...existing, transcriptData],
          had_meeting: true,
          meeting_date: doc.data().meeting_date || transcriptData.date,
        });
        matchedReplies++;
        console.log(`[fireflies] Matched reply: ${email} (doc ${doc.id})`);

        // Sync to CoterieHQ CRM
        try {
          await coteriehq.syncReply({ ...doc.data(), email, had_meeting: true }, { createDeal: true });
        } catch (e) {
          console.warn(`[fireflies] CoterieHQ sync failed for ${email}:`, e.message);
        }
      }

      // Match against leads collection
      const leadSnap = await leads.where('email', '==', email).get();
      for (const doc of leadSnap.docs) {
        const existing = doc.data().transcripts || [];
        if (existing.some(t => t.fireflies_id === transcript.id)) continue;
        await doc.ref.update({
          transcripts: [...existing, transcriptData],
        });
        matchedLeads++;
        console.log(`[fireflies] Matched lead: ${email} (doc ${doc.id})`);
      }
    }

    console.log(`[fireflies] Done — matched ${matchedReplies} replies, ${matchedLeads} leads`);
    res.json({
      success: true,
      transcript_id: transcript.id,
      title: transcript.title,
      matched_replies: matchedReplies,
      matched_leads: matchedLeads,
    });
  } catch (e) {
    console.error('[fireflies] Webhook error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/fireflies/sync
 * Manual sync — pulls recent transcripts and matches them to contacts.
 */
router.post('/sync', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const transcripts = await fireflies.getRecentTranscripts(limit);
    console.log(`[fireflies] Syncing ${transcripts.length} recent transcripts...`);

    let totalMatched = 0;

    for (const t of transcripts) {
      const participants = t.participants || [];
      const emails = participants.map(p => p.toLowerCase().trim()).filter(p => p.includes('@'));

      const transcriptData = {
        fireflies_id: t.id,
        title: t.title,
        date: t.date ? new Date(t.date).toISOString() : null,
        duration: t.duration,
        transcript_url: t.transcript_url || null,
        overview: t.summary?.overview || null,
        action_items: t.summary?.action_items || null,
        keywords: t.summary?.keywords || null,
        participants: participants,
        matched_at: new Date().toISOString(),
      };

      for (const email of emails) {
        const replySnap = await replies.where('email', '==', email).get();
        for (const doc of replySnap.docs) {
          const existing = doc.data().transcripts || [];
          if (existing.some(x => x.fireflies_id === t.id)) continue;
          await doc.ref.update({
            transcripts: [...existing, transcriptData],
            had_meeting: true,
            meeting_date: doc.data().meeting_date || transcriptData.date,
          });
          totalMatched++;
        }

        const leadSnap = await leads.where('email', '==', email).get();
        for (const doc of leadSnap.docs) {
          const existing = doc.data().transcripts || [];
          if (existing.some(x => x.fireflies_id === t.id)) continue;
          await doc.ref.update({
            transcripts: [...existing, transcriptData],
          });
          totalMatched++;
        }
      }
    }

    res.json({ success: true, transcripts_checked: transcripts.length, contacts_matched: totalMatched });
  } catch (e) {
    console.error('[fireflies] Sync error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/fireflies/transcripts
 * Lists recent transcripts from Fireflies for the dashboard.
 */
router.get('/transcripts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const transcripts = await fireflies.getRecentTranscripts(limit);

    // Only show calls Vincent was on
    const MY_EMAILS = ['vincent@storygroup.io', 'vincent@winningrepublicans.com', 'vinnie.catalano3@gmail.com'];
    const myTranscripts = transcripts.filter(t => {
      const parts = (t.participants || []).map(p => p.toLowerCase().trim());
      return parts.some(p => MY_EMAILS.includes(p) || p.includes('vinnie') || p.includes('vincent'));
    });

    // Check which ones have matched contacts
    const results = [];
    for (const t of myTranscripts) {
      const participants = t.participants || [];
      const emails = participants.map(p => p.toLowerCase().trim()).filter(p => p.includes('@'));

      let matchedContacts = [];
      for (const email of emails) {
        const replySnap = await replies.where('email', '==', email).limit(1).get();
        if (!replySnap.empty) {
          matchedContacts.push({ email, source: 'reply' });
          continue;
        }
        const leadSnap = await leads.where('email', '==', email).limit(1).get();
        if (!leadSnap.empty) {
          matchedContacts.push({ email, source: 'lead' });
        }
      }

      results.push({
        id: t.id,
        title: t.title,
        date: t.date ? new Date(t.date).toISOString() : null,
        duration: t.duration,
        transcript_url: t.transcript_url || null,
        participants,
        overview: t.summary?.overview || null,
        action_items: t.summary?.action_items || null,
        keywords: t.summary?.keywords || null,
        matched_contacts: matchedContacts,
      });
    }

    res.json({ success: true, transcripts: results });
  } catch (e) {
    console.error('[fireflies] List error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
