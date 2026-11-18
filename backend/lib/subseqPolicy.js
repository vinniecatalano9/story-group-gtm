/**
 * Which reply follow-up sequence (Instantly calls it a subsequence) a replied
 * lead belongs in. Plain tables on purpose: read them, change them.
 *
 * Used by services/subseqEnroll.js. Nothing in here talks to Instantly or
 * Firestore. Runbook: docs/SUBSEQ_AUTO_ENROLL.md
 *
 * The rule (Vincent, 2026-11-18): the pick is about what WE just sent.
 *   We pitched call times           -> "Call Time Sent"
 *   We answered a question or an    -> "Objection Followup"
 *   objection
 *   Not interested, out of office,  -> nothing
 *   remove me, bounce, referral
 */

// The two sequence names. A campaign's own subsequence is found by this name,
// ignoring case, spaces and hyphens ("Objection Follow-Up" matches too).
const CALL_TIME = 'Call Time Sent';
const OBJECTION = 'Objection Followup';

// Reply classification (services/replyClassifier.js, Step 1) -> sequence.
const BY_CLASS = {
  // Our answer proposes call times
  interested: CALL_TIME,
  re_engage: CALL_TIME,
  times_rejected: CALL_TIME,

  // Our answer handles a question or an objection
  cost_question: OBJECTION,
  cost_question_repeat: OBJECTION,
  spec_demand: OBJECTION,
  more_info: OBJECTION,
  send_info: OBJECTION,
  why_reach_out: OBJECTION,
  guarantee: OBJECTION,
  competence_test: OBJECTION,
  evaluator: OBJECTION,
  timing_objection: OBJECTION,
  budget_cycle: OBJECTION,
  question_other: OBJECTION,
};

// Never enrolled, whatever else is true.
const NEVER = {
  not_interested: 'They said no or asked to be removed.',
  referral: 'They pointed us to someone else.',
  ooo: 'Out of office auto-reply.',
  bounce: 'Bounced email.',
  ghost_followup: 'No new message from the prospect.',
  other: 'The reply did not fit a class, so a person should look.',
};

// Auto-replies. They are ignored completely: they do not start a pending
// decision and they do not cancel one that a real reply started.
const AUTO_REPLY = new Set(['ooo', 'bounce']);

// Instantly lead labels that mean "leave this lead alone", checked right
// before enrolling. (1 Interested and 0 Out of Office do not block.)
const SKIP_INTEREST_STATUS = {
  2: 'Meeting Booked',
  3: 'Meeting Completed',
  4: 'Won',
  '-1': 'Not Interested',
  '-2': 'Wrong Person',
  '-3': 'Lost',
  '-4': 'No Show',
};

// When true, the answer we really sent gets the last word: a clock time in it
// ("2pm", "10:30 am", "noon") means Call Time Sent, no clock time means
// Objection Followup. This catches a cost answer that also pitched times, and
// an "interested" answer that was edited into a question. Set to false to go
// by the class table alone.
const REFINE_BY_SENT_TEXT = true;

// When true, a lead is enrolled only if the classifier ALSO said a follow-up
// sequence applies (its own "subsequence" field names one of the two). If the
// class table says enroll but the classifier left that field empty, the reply
// is treated as unclear: nobody is enrolled and the row is logged as skipped.
const REQUIRE_CLASSIFIER_AGREEMENT = true;

const CLOCK_TIME = /\b(1[0-2]|0?[1-9])(:[0-5]\d)?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])|\bnoon\b/i;

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sameSequence(a, b) {
  return !!normalizeName(a) && normalizeName(a) === normalizeName(b);
}

/**
 * Pick the sequence for one classified reply.
 * @param {{classification: string, failed?: boolean, classifierSubsequence?: string}} r
 * @returns {{subsequence: string|null, reason: string}}
 */
function pick(r = {}) {
  const cls = String(r.classification || '').trim().toLowerCase();
  if (r.failed) return { subsequence: null, reason: 'The classifier failed on this reply, so nothing is enrolled.' };
  if (!cls) return { subsequence: null, reason: 'No classification.' };
  if (NEVER[cls]) return { subsequence: null, reason: NEVER[cls] };
  const hinted = [CALL_TIME, OBJECTION].some(name => sameSequence(r.classifierSubsequence, name));
  if (BY_CLASS[cls] && REQUIRE_CLASSIFIER_AGREEMENT && !hinted) {
    return { subsequence: null, unclear: true, reason: `Unclear: "${cls}" maps to a follow-up sequence but the classifier did not pick one, so nobody is enrolled.` };
  }
  if (BY_CLASS[cls]) {
    return {
      subsequence: BY_CLASS[cls],
      reason: BY_CLASS[cls] === CALL_TIME
        ? `"${cls}": our answer proposes call times.`
        : `"${cls}": our answer handles a question or an objection.`,
    };
  }
  // A class this table does not know yet: take the classifier's own hint if it
  // names one of the two sequences, otherwise do nothing.
  for (const name of [CALL_TIME, OBJECTION]) {
    if (sameSequence(r.classifierSubsequence, name)) {
      return { subsequence: name, reason: `"${cls}" is not in the policy table. Used the classifier's pick.` };
    }
  }
  return { subsequence: null, reason: `"${cls}" is not in the policy table.` };
}

function proposesTimes(text) {
  return CLOCK_TIME.test(String(text || ''));
}

/**
 * Adjust a pick by the answer that was really sent. No text means no change.
 * @returns {{subsequence: string|null, reason: string, changed: boolean}}
 */
function refineBySentText(picked, sentText) {
  const text = String(sentText || '').trim();
  if (!REFINE_BY_SENT_TEXT || !picked || !picked.subsequence || !text) return { ...picked, changed: false };
  const want = proposesTimes(text) ? CALL_TIME : OBJECTION;
  if (want === picked.subsequence) return { ...picked, changed: false };
  return {
    subsequence: want,
    reason: want === CALL_TIME
      ? `${picked.reason} The answer we sent pitches a call time, so Call Time Sent.`
      : `${picked.reason} The answer we sent has no call time in it, so Objection Followup.`,
    changed: true,
  };
}

module.exports = {
  CALL_TIME, OBJECTION, BY_CLASS, NEVER, AUTO_REPLY, SKIP_INTEREST_STATUS, REFINE_BY_SENT_TEXT, REQUIRE_CLASSIFIER_AGREEMENT,
  normalizeName, sameSequence, pick, proposesTimes, refineBySentText,
};
