/**
 * Reply follow-up auto-enroll.
 *
 * A lead who replies once and then goes quiet should land in that campaign's
 * reply follow-up sequence (Instantly subsequence) without a person setting a
 * label by hand. Which sequence: lib/subseqPolicy.js.
 *
 * The trigger is OUR ANSWER going out, never their reply arriving. Enrolling on
 * the inbound reply could send "what did you think of my last note?" when no
 * note was ever sent. So it works in two steps:
 *
 *   1. notePending()  - called by the reply webhook once the reply is
 *      classified. Saves a pending decision in Firestore (subseq_pending).
 *      Changes nothing in Instantly.
 *   2. checkPending() - a cron, every 5 minutes. For each pending decision it
 *      reads the lead's emails from Instantly (GET /emails?lead=) and looks for
 *      an email we sent (ue_type 3: sent from the inbox or through the API,
 *      which is how the Reply Bot phone card sends) in the SAME thread, AFTER
 *      their reply. Only then does it decide. Checked on real threads
 *      2026-11-18: the webhook's email_id is the id of the received email in
 *      that list, and our answer shows up there within the same thread.
 *      No answer after SUBSEQ_PENDING_DAYS (default 7) means the decision
 *      expires and nothing is enrolled.
 *
 * Safety:
 *   SUBSEQ_AUTO_ENROLL   off (default) | shadow (log "would enroll") | live
 *   SUBSEQ_ENROLL_METHOD move (default) | label. Only read in live mode.
 *     move:  POST /leads/subsequence/move { id, subsequence_id }
 *     label: POST /leads/update-interest-status with the label that triggers
 *            the target subsequence (its conditions.crm_status).
 *
 * The target is found by name on the lead's own campaign, so this works for any
 * campaign that has subsequences named "Call Time Sent" or "Objection
 * Followup". A campaign with none is logged and left alone.
 *
 * Skipped, with a log row: a lead the cross-channel stop moved out of its
 * campaign, a lead no longer in the campaign, a lead labeled Meeting Booked,
 * Not Interested and the like, a lead already in the target subsequence, and a
 * subsequence that is not active.
 *
 * Every decision is one row in `logs`, type subseq_enroll. Nothing in here
 * throws: the reply webhook and the cron keep working whatever happens.
 */
const crypto = require('crypto');
const policy = require('../lib/subseqPolicy');

const PENDING = 'subseq_pending';
const LOG_TYPE = 'subseq_enroll';

// ---------- config (read lazily) ----------

function mode() {
  const m = String(process.env.SUBSEQ_AUTO_ENROLL || 'off').trim().toLowerCase();
  return m === 'live' || m === 'shadow' ? m : 'off';
}

function method() {
  return String(process.env.SUBSEQ_ENROLL_METHOD || 'move').trim().toLowerCase() === 'label' ? 'label' : 'move';
}

const pendingDays = () => parseFloat(process.env.SUBSEQ_PENDING_DAYS) || 7;
const perRun = () => parseInt(process.env.SUBSEQ_CHECKS_PER_RUN) || 6; // GET /emails allows 20 a minute

// ---------- helpers ----------

function cleanEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
}

function pendingId(campaignId, email) {
  return crypto.createHash('sha1').update(`${String(campaignId).toLowerCase()}|${email}`).digest('hex').slice(0, 32);
}

function toDate(v) {
  if (!v) return null;
  const d = typeof v.toDate === 'function' ? v.toDate() : new Date(v);
  return isNaN(d) ? null : d;
}

const emailTime = e => toDate(e && (e.timestamp_created || e.timestamp_email));

// The part of a sent email that we wrote: tags stripped, quoted thread cut off.
function sentText(email) {
  const body = (email && email.body) || {};
  if (body.text && String(body.text).trim()) return String(body.text).split(/\n\s*On .{0,200}wrote:/)[0].trim();
  let html = String(body.html || '');
  if (!html) return '';
  html = html.split(/<blockquote|class="[^"]*gmail_quote|<div[^>]*id="?divRplyFwdMsg|<hr/i)[0];
  const text = html.replace(/<(br|\/p|\/div)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return text.split(/\n\s*On .{0,200}wrote:/)[0].replace(/[ \t]+/g, ' ').trim();
}

// ---------- stores and vendor calls (swapped out in the test) ----------

function firestoreStore() {
  const { db } = require('./db');
  const col = () => db.collection(PENDING);
  return {
    async get(id) { const d = await col().doc(id).get(); return d.exists ? { id: d.id, ...d.data() } : null; },
    async set(id, data) { await col().doc(id).set({ ...data, updated_at: new Date() }); },
    async patch(id, data) { await col().doc(id).set({ ...data, updated_at: new Date() }, { merge: true }); },
    async listPending(limit = 100) {
      const snap = await col().where('status', '==', 'pending').limit(limit).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async countByStatus() {
      const snap = await col().select('status').get();
      const out = {};
      snap.docs.forEach(d => { const s = d.data().status || 'unknown'; out[s] = (out[s] || 0) + 1; });
      return out;
    },
    // The newest classification of the reply (the draft backlog can reclassify it).
    async replyInfo(replyId) {
      if (!replyId) return null;
      const d = await db.collection('replies').doc(replyId).get();
      return d.exists ? d.data() : null;
    },
    // True when the cross-channel stop has moved this lead out of this campaign.
    async crossChannelStopped(email, campaignId) {
      const snap = await db.collection('channel_links').where('email', '==', email).limit(20).get();
      return snap.docs.some(d => {
        const l = d.data();
        return l.email_stopped_at && String(l.instantly_campaign_id || '').toLowerCase() === String(campaignId).toLowerCase();
      });
    },
  };
}

function realApi() {
  const instantly = require('./instantly');
  return {
    listLeadEmails: (email) => instantly.listLeadEmails(email),               // read only
    listSubsequences: (campaignId) => instantly.listSubsequences(campaignId), // read only
    findLead: (email, campaignId) => instantly.findLeadInCampaign(email, campaignId), // read only
    moveLeadToSubsequence: (leadId, subId) => instantly.moveLeadToSubsequence(leadId, subId),
    setLeadInterestStatus: (email, value, campaignId) => instantly.setLeadInterestStatus(email, value, campaignId),
  };
}

function resolveDeps(deps = {}) {
  return {
    store: deps.store || firestoreStore(),
    api: deps.api || realApi(),
    now: deps.now || (() => new Date()),
    log: deps.log || (async (row) => {
      const { addLog } = require('./db');
      await addLog(LOG_TYPE, row);
      if (row && (row.outcome === 'would_enroll' || row.outcome === 'enrolled' || row.outcome === 'failed')) {
        try { require('./telegram').noteForWorkBot(`Reply follow-up auto-enroll (${row.mode}): ${row.would || row.did || row.reason || row.outcome}`.trim()); } catch { /* never block */ }
      }
    }),
  };
}

async function safeLog(log, row) {
  try { await log(row); } catch (e) { console.warn('[subseq-enroll] log failed:', e.message); }
  return row;
}

// ---------- step 1: the reply webhook ----------

/**
 * @param evt { email, classification, classifierFailed, classifierSubsequence,
 *              campaignId, campaignName, replyId, emailUuid, replyAt }
 * @returns { mode, outcome }. Never throws. Never calls Instantly.
 */
async function notePending(evt = {}, deps) {
  const m = mode();
  if (m === 'off') return { mode: 'off', outcome: 'off' };
  try {
    const d = resolveDeps(deps);
    const email = cleanEmail(evt.email);
    const campaignId = evt.campaignId ? String(evt.campaignId).toLowerCase() : '';
    const cls = String(evt.classification || '').toLowerCase();
    if (policy.AUTO_REPLY.has(cls)) return { mode: m, outcome: 'ignored_auto_reply' };

    const base = {
      mode: m, step: 'reply_classified', lead_email: email || null,
      campaign_id: campaignId || null, campaign_name: evt.campaignName || null,
      classification: cls || null, reply_id: evt.replyId || null,
    };
    if (!email || !campaignId) {
      await safeLog(d.log, { ...base, outcome: 'no_action', subsequence: null, reason: 'The reply webhook had no lead email or no campaign id.' });
      return { mode: m, outcome: 'no_action' };
    }

    const picked = policy.pick({ classification: cls, failed: evt.classifierFailed === true, classifierSubsequence: evt.classifierSubsequence });
    const id = pendingId(campaignId, email);

    if (!picked.subsequence) {
      // A "no" or a referral also cancels a decision an earlier reply left waiting.
      let cancelled = false;
      const open = await d.store.get(id);
      if (open && open.status === 'pending') {
        await d.store.patch(id, { status: 'cancelled', cancelled_reason: picked.reason, cancelled_by_reply_id: evt.replyId || null });
        cancelled = true;
      }
      const outcome = picked.unclear ? 'skipped' : 'no_action';
      await safeLog(d.log, { ...base, outcome, ...(picked.unclear ? { skip: 'unclear_classification' } : {}), subsequence: null, reason: picked.reason, ...(cancelled ? { cancelled_pending: true } : {}) });
      return { mode: m, outcome };
    }

    // The same reply delivered twice (a webhook retry) never reopens a decision.
    const prior = await d.store.get(id);
    if (prior && prior.status !== 'pending' && evt.emailUuid && prior.email_uuid === evt.emailUuid) {
      return { mode: m, outcome: 'duplicate_webhook' };
    }
    // One open decision per lead per campaign: a newer reply replaces the older one.
    await d.store.set(id, {
      status: 'pending',
      email, campaign_id: campaignId, campaign_name: evt.campaignName || null,
      reply_id: evt.replyId || null, email_uuid: evt.emailUuid || null,
      reply_at: toDate(evt.replyAt) || d.now(),
      classification: cls, policy_pick: picked.subsequence, policy_reason: picked.reason,
      classifier_subsequence: evt.classifierSubsequence || '',
      checks: 0, created_at: d.now(),
    });
    return { mode: m, outcome: 'pending', subsequence: picked.subsequence };
  } catch (e) {
    console.warn('[subseq-enroll] notePending failed:', e.message);
    return { mode: m, outcome: 'error', error: e.message };
  }
}

// ---------- step 2: the cron ----------

/**
 * Our answer to this pending reply, or null. Pure: takes the email list.
 * The inbound email is matched by id (the webhook's email_id); without an id,
 * by the closest received email within 10 minutes of the webhook.
 */
function findSentAnswer(pending, emails) {
  const list = Array.isArray(emails) ? emails : [];
  let inbound = pending.email_uuid ? list.find(e => e.id === pending.email_uuid) : null;
  if (!inbound && !pending.email_uuid) {
    const at = toDate(pending.reply_at);
    const near = list
      .filter(e => e.ue_type === 2 && emailTime(e) && at && Math.abs(emailTime(e) - at) <= 10 * 60000)
      .sort((a, b) => Math.abs(emailTime(a) - at) - Math.abs(emailTime(b) - at));
    inbound = near[0] || null;
  }
  if (!inbound || !inbound.thread_id || !emailTime(inbound)) return { inbound: null, answer: null };
  const answers = list
    .filter(e => e.ue_type === 3 && e.thread_id === inbound.thread_id && emailTime(e) && emailTime(e) > emailTime(inbound))
    .sort((a, b) => emailTime(a) - emailTime(b));
  return { inbound, answer: answers[0] || null };
}

async function decideOne(p, d) {
  const m = mode();
  const base = {
    mode: m, step: 'answer_sent', lead_email: p.email, campaign_id: p.campaign_id,
    campaign_name: p.campaign_name || null, reply_id: p.reply_id || null,
  };
  const now = d.now();
  const finish = async (status, row) => {
    await d.store.patch(p.id, { status, decided_at: now, outcome: row.outcome, subsequence: row.subsequence || null });
    return safeLog(d.log, { ...base, classification: p.classification, ...row });
  };

  const replyAt = toDate(p.reply_at) || toDate(p.created_at) || now;
  const emails = await d.api.listLeadEmails(p.email);
  const { inbound, answer } = findSentAnswer(p, emails);
  if (!answer) {
    // Too old with no answer: give up.
    if (now - replyAt > pendingDays() * 86400000) {
      return finish('expired', {
        outcome: 'expired_no_answer', subsequence: null,
        reason: `No answer from us was seen in the thread within ${pendingDays()} days, so nothing was enrolled.`,
      });
    }
    await d.store.patch(p.id, { checks: (p.checks || 0) + 1, last_checked_at: now, last_note: inbound ? 'no answer sent yet' : 'their reply is not in the Instantly email list yet' });
    return { outcome: 'waiting' };
  }

  // The reply may have been reclassified since the webhook.
  let cls = p.classification;
  let failed = false;
  let hint = p.classifier_subsequence || '';
  try {
    const r = await d.store.replyInfo(p.reply_id);
    if (r && r.classification) { cls = String(r.classification).toLowerCase(); failed = r.failed === true; hint = r.subsequence || ''; }
  } catch (e) { console.warn('[subseq-enroll] reply lookup failed:', e.message); }

  let picked = policy.pick({ classification: cls, failed, classifierSubsequence: hint });
  // The sent answer this decision keyed on, so a later check can see why.
  const answerText = sentText(answer);
  const common = {
    classification: cls, answer_email_id: answer.id || null, answer_sent_at: emailTime(answer), thread_id: answer.thread_id,
    answer_from: answer.eaccount || answer.from_address_email || null, answer_text: answerText.slice(0, 300),
  };
  if (!picked.subsequence) {
    return finish(picked.unclear ? 'skipped' : 'cancelled', {
      ...common, outcome: picked.unclear ? 'skipped' : 'no_action', ...(picked.unclear ? { skip: 'unclear_classification' } : {}),
      subsequence: null, reason: picked.reason,
    });
  }
  picked = policy.refineBySentText(picked, answerText);
  const row = { ...common, subsequence: picked.subsequence, reason: picked.reason };

  if (await d.store.crossChannelStopped(p.email, p.campaign_id)) {
    return finish('skipped', { ...row, outcome: 'skipped', skip: 'cross_channel_stop', reason: 'The cross-channel stop moved this lead out of the campaign (they replied on LinkedIn).' });
  }

  const subs = await d.api.listSubsequences(p.campaign_id);
  const target = subs.find(s => policy.sameSequence(s.name, picked.subsequence));
  if (!target) {
    return finish('skipped', { ...row, outcome: 'no_subsequence', reason: `This campaign has no subsequence named "${picked.subsequence}" (it has ${subs.length}). Nothing to enroll into.` });
  }
  row.subsequence_id = target.id;
  if (target.status !== 1) {
    return finish('skipped', { ...row, outcome: 'skipped', skip: 'subsequence_not_active', reason: `"${target.name}" is not active (status ${target.status}).` });
  }

  const lead = await d.api.findLead(p.email, p.campaign_id);
  if (!lead || !lead.id) {
    return finish('skipped', { ...row, outcome: 'skipped', skip: 'not_in_campaign', reason: 'The lead is no longer in this campaign.' });
  }
  row.instantly_lead_id = lead.id;
  const label = policy.SKIP_INTEREST_STATUS[String(lead.lt_interest_status)];
  if (label) {
    return finish('skipped', { ...row, outcome: 'skipped', skip: 'lead_label', reason: `The lead is labeled ${label} in Instantly.` });
  }
  if (lead.subsequence_id && lead.subsequence_id === target.id) {
    return finish('skipped', { ...row, outcome: 'already_enrolled', reason: `The lead is already in "${target.name}".` });
  }

  const where = `"${target.name}" on ${p.campaign_name || p.campaign_id}`;
  if (m !== 'live') {
    return finish('shadow_logged', { ...row, outcome: 'would_enroll', would: `Would enroll ${p.email} into ${where}. ${picked.reason}` });
  }

  // ---- LIVE ONLY below this line. Unreachable unless SUBSEQ_AUTO_ENROLL=live. ----
  if (mode() !== 'live') return { outcome: 'waiting' };
  const how = method();
  // Mark it before the call, so a crash or a second cron run can never enroll twice.
  await d.store.patch(p.id, { status: 'enrolling', decided_at: now });
  try {
    if (how === 'label') {
      const value = (target.conditions && Array.isArray(target.conditions.crm_status)) ? target.conditions.crm_status[0] : undefined;
      if (typeof value !== 'number') throw new Error(`"${target.name}" has no label trigger, so the label method cannot start it`);
      await d.api.setLeadInterestStatus(p.email, value, p.campaign_id);
      row.label_value = value;
    } else {
      await d.api.moveLeadToSubsequence(lead.id, target.id);
    }
    return finish('enrolled', { ...row, outcome: 'enrolled', method: how, did: `Enrolled ${p.email} into ${where}. ${picked.reason}` });
  } catch (e) {
    return finish('failed', { ...row, outcome: 'failed', method: how, manual_check: true, reason: `Enroll call failed: ${e.message}. Not retried. Set the label by hand in Instantly.` });
  }
}

let running = false;

/**
 * Check the open decisions. Called by the cron in server.js.
 * @returns { mode, checked, results }. Never throws.
 */
async function checkPending({ limit } = {}, deps) {
  const m = mode();
  if (m === 'off') return { mode: 'off', checked: 0, results: [] };
  if (running) return { mode: m, checked: 0, results: [], busy: true };
  running = true;
  const results = [];
  try {
    const d = resolveDeps(deps);
    const now = d.now();
    const due = (await d.store.listPending(100))
      // Give our answer a minute to exist, and check the longest-waiting first.
      .filter(p => now - (toDate(p.reply_at) || toDate(p.created_at) || 0) >= 60000)
      .sort((a, b) => (toDate(a.last_checked_at) || 0) - (toDate(b.last_checked_at) || 0))
      .slice(0, limit || perRun());
    for (const p of due) {
      try {
        results.push({ email: p.email, ...(await decideOne(p, d)) });
      } catch (e) {
        // A failed read (Instantly down, rate limit): leave it pending and try next run.
        console.warn(`[subseq-enroll] check failed for ${p.email}:`, e.message);
        try { await d.store.patch(p.id, { last_checked_at: now, last_error: e.message }); } catch { /* next run */ }
        results.push({ email: p.email, outcome: 'error', error: e.message });
      }
    }
  } catch (e) {
    console.warn('[subseq-enroll] checkPending failed:', e.message);
  } finally {
    running = false;
  }
  return { mode: m, checked: results.length, results };
}

module.exports = {
  mode, method, notePending, checkPending, findSentAnswer, sentText, pendingId,
  firestoreStore, PENDING, LOG_TYPE,
};
