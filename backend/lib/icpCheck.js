// lib/icpCheck.js
//
// A title-level ICP check for people who reply to us on LinkedIn.
//
// This is NOT the full v3 ICP filter (~/.claude/skills/storygroup-icp-filter).
// That one runs on Apollo exports and gates on employee count, email domain and
// web presence, none of which we have for an inbound LinkedIn reply. All we get
// from HeyReach is the person's headline and company, so this applies the
// subset of v3 that a headline can actually answer.
//
// Read it as "obviously not worth working", never as a qualification score.
//
// The thing that makes this hard: HeyReach's `headline` is often not a headline.
// It is frequently the person's whole LinkedIn About section, several hundred
// words of career history. A naive keyword match on that text kills real buyers,
// which the first version of this file did:
//
//   "Founder and investor. FORMER senior M&A lawyer at Linklaters."  -> killed
//   "Executive Director and Founder of the American STUDENT Gov Assoc" -> killed
//   "CEO | Founder | Keynote Speaker | FORMER White House"            -> killed
//
// All three are exactly who we want. So: an ownership signal anywhere outranks
// past-tense and student wording, and the student rule matches only phrasings
// that state someone IS currently a student, never a stray "student" inside an
// organisation name or a job title.

// Ownership / decision-maker signals.
const OWNER_RE = /\b(founder|co[- ]?founder|founded|ceo|chief executive|owner|proprietor|president|managing partner|chair(man|woman|person)?)\b/i;

// Phrases that point AT a decision maker rather than naming one: "Executive
// Assistant to the CEO" must not read as a CEO.
const POINTS_AT_OWNER = /\b(to|for) the\b[^,|.]*/gi;

// Support roles. Checked before the owner signal is even computed, because the
// support role IS the whole title.
const SUPPORT_RE = /\b(executive assistant|administrative assistant|assistant to the|chief of staff to|office manager|receptionist)\b/i;

// Competitors. Kills regardless of seniority.
const COMPETITOR_RE = /\b(pr (firm|agency|consultant|specialist)|public relations|publicist|publicity|media relations|comms agency|communications agency)\b/i;

// Currently a student or in training. Deliberately specific: it must say they
// ARE one, not merely contain the word.
const STUDENT_RE = new RegExp([
  /\b(mba|pharmd|md|jd|phd|dnp|edd|msn|bsn|do)\s*\/?\s*(mba|pharmd|md|jd|phd)?\s*candidate\b/.source,
  /\bclass of\s*20\d\d\b/.source,
  /\b(current|currently)\s+(a\s+)?(graduate\s+|doctoral\s+|medical\s+|nursing\s+|law\s+)?student\b/.source,
  /\b(graduate|doctoral|medical|nursing|law|undergraduate|pre[- ](med|law|physician assistant|pa|dental))\s+student\b/.source,
  /\bstudent\s+at\s+/.source,
  /\b(resident physician|in residency|residency program|fellowship trainee|apprentice|intern at)\b/.source,
  /\baspiring\s+\w+/.source,
].join('|'), 'i');

// Actively job hunting.
const JOB_SEEKING_RE = /\b(open to work|#opentowork|seeking (a |my )?(new |next )?(role|opportunit|position)|looking for (a |my )?next (role|opportunit|position)|between roles|in transition|currently unemployed|job seeker)\b/i;

// Past tense attached DIRECTLY to the ownership title: "Retired CEO", "Former
// Founder". This kills even when an ownership word is present, because the
// ownership word is the very thing being negated.
const RETIRED_OWNER_RE = /\b(retired|former(ly)?|ex[- ])\s*(the\s+)?(ceo|founder|co[- ]?founder|president|owner|chief executive|proprietor)\b/i;

// Past tense as the CURRENT identity anywhere in the text. Only trusted when
// there is no ownership signal, since a founder describing a previous career
// ("Founder and investor. Former senior M&A lawyer") is still a founder.
const FORMER_RE = /\b(retired|emeritus)\b/i;

// Wrong-suite C-level: v3 kills these unless "Founder" is also present.
// "Chief Marketing and Student Services Officer" puts four words between the
// function and "Officer", so the function word alone has to be the trigger.
const WRONG_SUITE_RE = /\b(cmo|coo|cfo|cto|cro|cio|ciso)\b|\bchief\s+(marketing|operating|financial|technology|revenue|information|people|human resources|nursing|quality|medical|student|academic|administrative)\b/i;

// Sub-founder seniority.
const SUB_FOUNDER_RE = /\b(vp|vice president|evp|svp|director of|head of|manager|team lead|coordinator|specialist|analyst|associate dean|deputy)\b/i;

/**
 * @returns {{verdict:'fit'|'review'|'kill', reason:string|null, basis:string}}
 *   'kill'   — a clear disqualifier
 *   'review' — no headline captured, nothing to judge on
 *   'fit'    — nothing disqualifying found. NOT a positive qualification.
 */
function icpCheck({ headline, company } = {}) {
  const h = (headline || '').trim();
  // A company name alone says nothing about this person's role, and guessing
  // from it produces exactly the confident-but-wrong verdicts this must avoid.
  if (!h) return { verdict: 'review', reason: null, basis: 'no headline captured' };

  const text = [h, company].filter(Boolean).join(' ');
  const kill = (reason) => ({ verdict: 'kill', reason, basis: h });

  // 1. Support role and competitor kill outright — ownership wording inside
  //    them ("assistant to the CEO") is pointing at someone else.
  if (SUPPORT_RE.test(text)) return kill('support role, not the buyer');
  if (COMPETITOR_RE.test(text)) return kill('PR or comms competitor');

  // 2. Currently a student. Strict phrasings only, and still yields to
  //    ownership: someone can found a company while finishing a degree.
  const ownerSignal = OWNER_RE.test(text.replace(POINTS_AT_OWNER, ''));
  // Checked before the ownership override, because it negates ownership itself.
  if (RETIRED_OWNER_RE.test(text)) return kill('former or retired');
  if (STUDENT_RE.test(text) && !ownerSignal) return kill('student or trainee');
  if (JOB_SEEKING_RE.test(text) && !ownerSignal) return kill('job seeking');
  if (FORMER_RE.test(text) && !ownerSignal) return kill('former or retired');

  // 3. Seniority. Ownership outranks both.
  if (!ownerSignal) {
    if (WRONG_SUITE_RE.test(text)) return kill('wrong-suite C-level');
    if (SUB_FOUNDER_RE.test(text)) return kill('sub-founder title');
  }

  return { verdict: 'fit', reason: null, basis: h };
}

module.exports = { icpCheck, OWNER_RE };
