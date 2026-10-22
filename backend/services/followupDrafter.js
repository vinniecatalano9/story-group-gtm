const { claudeJSON } = require('./claude');

const MAX_TRANSCRIPT_CHARS = 24000;

/**
 * Flatten a Fireflies transcript into prompt text.
 * Prefers full sentences; falls back to summary/action items.
 * Long calls keep the start + end (intros and next-steps matter most).
 */
function transcriptText(transcript) {
  const sentences = transcript.sentences || [];
  if (sentences.length) {
    let text = sentences.map(s => `${s.speaker_name}: ${s.text}`).join('\n');
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
      text = text.slice(0, half) + '\n[... middle of call trimmed ...]\n' + text.slice(-half);
    }
    return text;
  }
  return [transcript.overview || transcript.summary?.overview, transcript.action_items || transcript.summary?.action_items]
    .filter(Boolean).join('\n\n');
}

/**
 * Generate a post-call follow-up email draft from a transcript.
 * Returns { subject, body }. With onlyIfAsked (the automatic path), Claude
 * first decides whether the prospect asked for something on the call (info,
 * pricing, a proposal, a follow up); if not, returns { asked: false, ask }
 * and no draft (Vincent, 10/22: drafts only "if they ask on the call").
 */
async function generateFollowupDraft(transcript, contactEmail, { onlyIfAsked = false } = {}) {
  const text = transcriptText(transcript);
  if (!text) throw new Error('No transcript content to draft from');

  const gate = onlyIfAsked ? `
FIRST decide: did the prospect ask Vincent to send or do something after the call? Counts: info, details or anything "in writing", pricing, a proposal, examples or case studies, a follow up call or email. Does not count: Vincent offering to send something they didn't want, small talk, "I'll think about it", or a meeting that is already booked with nothing to send.
If they asked for nothing, return ONLY {"asked": false, "ask": null}.
If they asked, the email delivers or answers exactly that.
` : '';

  const prompt = `You are drafting a post-call follow-up email from Vincent Catalano (VP of Growth, Story Group — earned media / PR for executives) to a prospect he just had a call with.

CALL: "${transcript.title || 'Sales call'}" on ${transcript.date || 'recently'}
PROSPECT EMAIL: ${contactEmail}

TRANSCRIPT:
${text}
${gate}
Write the follow-up email. Rules:
- 75-150 words. Plain text, no markdown.
- Reference 2-3 specifics from THIS call (their words, their goals, their concerns) — never generic.
- Recap any commitments made on the call (theirs and ours).
- One clear, low-effort next step (confirm the next call, or a specific yes/no ask). Never "let me know your thoughts."
- Tone: warm, direct, peer-to-peer. No hype words, no "I hope this finds you well," no exclamation marks.
- If a next meeting was already booked on the call, the CTA confirms it instead of asking for one.
- Never make up facts, prices, links or results. Anything Vincent must fill in or attach goes in [square brackets], e.g. [attach Kickstart one pager].
- No dashes of any kind in the email (no em dashes, en dashes or spaced hyphens); use commas, periods or parentheses.
- Sign off as "Vincent".

Return ONLY valid JSON: {${onlyIfAsked ? '"asked": true, "ask": "what they asked for, a few words", ' : ''}"subject": "...", "body": "..."}
Subject: 4-8 words, references the call topic, no clickbait.`;

  const draft = await claudeJSON(prompt, { timeout: 180000 });
  if (onlyIfAsked && draft && draft.asked === false) return { asked: false, ask: null };
  if (!draft?.subject || !draft?.body) throw new Error('Draft missing subject or body');
  const noDash = v => String(v).replace(/[ \t]+[\u2013\u2014-]+[ \t]+/g, ', ').replace(/[\u2013\u2014]/g, ', ');
  return { asked: true, ask: draft.ask || null, subject: noDash(draft.subject), body: noDash(draft.body) };
}

module.exports = { generateFollowupDraft, transcriptText };
