const express = require('express');
const router = express.Router();
const { leads, replies, upsertTranscript, getStoredTranscripts } = require('../services/db');
const fireflies = require('../services/fireflies');
const coteriehq = require('../services/coteriehq');

const MY_EMAILS = ['vincent@storygroup.io', 'vincent@winningrepublicans.com', 'vinnie.catalano3@gmail.com'];

function isMyCall(participants) {
  const parts = (participants || []).map(p => p.toLowerCase().trim());
  return parts.some(p => MY_EMAILS.includes(p) || p.includes('vinnie') || p.includes('vincent'));
}

/**
 * Store a transcript in Firestore and match contacts.
 * Returns { matchedReplies, matchedLeads, matchedContacts }
 */
async function storeAndMatch(transcript) {
  const participants = transcript.participants || [];
  const emails = participants.map(p => p.toLowerCase().trim()).filter(p => p.includes('@'));

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
    participants,
  };

  // Find matched contacts
  const matchedContacts = [];
  let matchedReplies = 0;
  let matchedLeads = 0;

  for (const email of emails) {
    if (MY_EMAILS.includes(email)) continue;

    const replySnap = await replies.where('email', '==', email).limit(1).get();
    if (!replySnap.empty) {
      matchedContacts.push({ email, source: 'reply' });
      // Attach transcript to reply doc
      for (const doc of replySnap.docs) {
        const existing = doc.data().transcripts || [];
        if (!existing.some(t => t.fireflies_id === transcript.id)) {
          await doc.ref.update({
            transcripts: [...existing, transcriptData],
            had_meeting: true,
            meeting_date: doc.data().meeting_date || transcriptData.date,
          });
          matchedReplies++;
          // Sync to CoterieHQ
          try {
            await coteriehq.syncReply({ ...doc.data(), email, had_meeting: true }, { createDeal: true });
          } catch (e) {
            console.warn(`[fireflies] CoterieHQ sync failed for ${email}:`, e.message);
          }
        }
      }
      continue;
    }

    const leadSnap = await leads.where('email', '==', email).limit(1).get();
    if (!leadSnap.empty) {
      matchedContacts.push({ email, source: 'lead' });
      for (const doc of leadSnap.docs) {
        const existing = doc.data().transcripts || [];
        if (!existing.some(t => t.fireflies_id === transcript.id)) {
          await doc.ref.update({ transcripts: [...existing, transcriptData] });
          matchedLeads++;
        }
      }
    }
  }

  // Store in transcripts collection (persisted — no more live API calls to read)
  transcriptData.matched_contacts = matchedContacts;
  transcriptData.is_my_call = isMyCall(participants);
  await upsertTranscript(transcriptData);

  return { matchedReplies, matchedLeads, matchedContacts };
}

/**
 * POST /api/fireflies/webhook
 * Fireflies webhook — fires on transcription.complete.
 * Downloads and stores the transcript immediately.
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

    let transcript;
    try {
      transcript = await fireflies.getTranscript(tid);
    } catch (e) {
      console.error('[fireflies] Failed to fetch transcript:', e.message);
      return res.status(502).json({ error: 'Failed to fetch transcript from Fireflies' });
    }

    if (!transcript) return res.status(404).json({ error: 'Transcript not found' });

    console.log(`[fireflies] Storing transcript "${transcript.title}" (${(transcript.participants || []).length} participants)`);
    const { matchedReplies, matchedLeads } = await storeAndMatch(transcript);

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
 * Pull recent transcripts from Fireflies API and store them in Firestore.
 */
router.post('/sync', async (req, res) => {
  try {
    const all = req.query.all === 'true';
    console.log(`[fireflies] Syncing ${all ? 'ALL' : 'recent'} transcripts from Fireflies API...`);
    const transcripts = all ? await fireflies.getAllTranscripts() : await fireflies.getRecentTranscripts(50);
    console.log(`[fireflies] Got ${transcripts.length} transcripts from API`);

    let totalMatched = 0;
    let stored = 0;
    for (const t of transcripts) {
      const { matchedReplies, matchedLeads } = await storeAndMatch(t);
      totalMatched += matchedReplies + matchedLeads;
      stored++;
    }

    console.log(`[fireflies] Sync complete — stored ${stored}, matched ${totalMatched} contacts`);
    res.json({ success: true, transcripts_synced: stored, contacts_matched: totalMatched });
  } catch (e) {
    console.error('[fireflies] Sync error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/fireflies/transcripts
 * Serves transcripts from Firestore (no live API call).
 * Hit "Sync & Match" to pull latest from Fireflies.
 */
router.get('/transcripts', async (req, res) => {
  try {
    const { transcripts: tCol } = require('../services/db');
    const snap = await tCol.where('is_my_call', '==', true).limit(200).get();
    const myTranscripts = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    res.json({ success: true, transcripts: myTranscripts });
  } catch (e) {
    console.error('[fireflies] List error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
