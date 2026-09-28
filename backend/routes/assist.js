// Live-call "ask" box on the call scorecard. The page sends the question, the
// playbook entries its own search matched, and the prospect's notes; Claude
// answers from those only, short enough to say out loud.
const express = require('express');
const { claudePrompt } = require('../services/claude');

const router = express.Router();
const ALLOWED = /^(https:\/\/story-group-gtm\.(web\.app|firebaseapp\.com)|http:\/\/localhost(:\d+)?)$/;
router.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !ALLOWED.test(origin)) return res.status(403).json({ error: 'Origin not allowed' });
  next();
});

// Light brake so a stuck key or a loop can't run up Claude usage.
const recent = [];
const tooMany = () => {
  const now = Date.now();
  while (recent.length && now - recent[0] > 60000) recent.shift();
  recent.push(now);
  return recent.length > 30;
};

const cut = (s, n) => String(s || '').slice(0, n);

router.post('/ask', async (req, res) => {
  const { question, sources = [], prospect = '', packages = '' } = req.body || {};
  if (!question || String(question).trim().length < 3) return res.status(400).json({ error: 'Type a question first' });
  if (tooMany()) return res.status(429).json({ error: 'Too many questions in the last minute. Try again shortly.' });

  const src = (Array.isArray(sources) ? sources : []).slice(0, 8)
    .map((d, i) => `[${i + 1}] (${cut(d.k, 20)}) ${cut(d.h, 160)}\n${cut(d.b, 900)}`).join('\n\n');

  const prompt = `You help a Story Group sales rep who is LIVE on a call with a prospect right now. They typed a question into their notes. Answer so they can glance at it and say it in their own words.

FORMAT: 2 to 4 short bullets, under 80 words total. Plain language. Start each bullet with "- ". If a bullet is something to say, put it in quotes. No headings, no preamble.

RULES:
- Use ONLY the playbook sources, the package list, and the prospect notes below. If they don't cover it, say so in one bullet and give the rep a safe line, e.g. "Great question. Let me get you a precise answer after this call." Never make up facts, numbers, clients, or outlets.
- Never promise or guarantee placements, outlets, or results.
- Prices: only a package's Start-here price from the package list. Never mention lower prices or discounts.
- If they're asking us to lay out their specific strategy or big idea, suggest saving that for the plan (that's what they pay for) and give one proof point instead.

PACKAGES (final 9/18/2026):
${cut(packages, 2500)}

PROSPECT NOTES SO FAR:
${cut(prospect, 3000) || 'None yet.'}

PLAYBOOK SOURCES (from the rep's search):
${src || 'No matching entries.'}

REP'S QUESTION: ${cut(question, 500)}`;

  try {
    const answer = await claudePrompt(prompt, { timeout: 45000, model: 'sonnet' });
    res.json({ answer });
  } catch (e) {
    console.error('[assist] ask failed:', e.message);
    res.status(502).json({ error: 'Couldn\'t get an answer right now. Use the search results below.' });
  }
});

module.exports = router;
