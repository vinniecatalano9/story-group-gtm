const { leads, replies, db } = require('../services/db');
const instantly = require('../services/instantly');
const axios = require('axios');

const dailyMetrics = db.collection('daily_metrics');

const HR_BASE = 'https://api.heyreach.io/api/public';
const hrHeaders = () => ({ 'X-API-KEY': process.env.HEYREACH_API_KEY, 'Content-Type': 'application/json' });

// Replies that represent a real buying signal. This used to be a hardcoded four
// (interested / referral / more_info / cost_question), which silently under-counted
// once the classifier learned to tell a guarantee objection from a timing one.
// Keep it in step with NEEDS_REPLY in the LinkedIn Replies page.
const POSITIVE = [
  'interested', 'cost_question', 'cost_question_repeat', 'more_info', 'send_info',
  'guarantee', 'timing_objection', 'times_rejected', 'why_reach_out', 'referral', 're_engage',
];

// A card marked handled is not proof we replied. The August 2026 cleanup closed
// hundreds of cards as duplicates, retired profiles and dead conversations —
// counting those as responses would have inflated the response rate to fiction.
// Only these reasons mean a human actually dealt with it.
const REAL_RESPONSE_REASONS = [undefined, null, '', 'answered_in_heyreach'];

const toMs = (v) => v?.toDate ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0);

/**
 * Daily metrics snapshot.
 *
 * Every figure is stored twice: the running total (`*_total`, what this job
 * always recorded) and the day's movement (`*_today`, total minus yesterday's).
 * Without the delta the dashboard showed emails_sent pinned at 90,363 every
 * single day and no way to tell a busy day from a dead one.
 *
 * Runs nightly at 11:59pm EST.
 */
async function runDailyMetrics() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[daily-metrics] Snapshotting metrics for ${today}...`);

  try {
    // ---- Email (Instantly) ----
    let emailsSent = 0;
    try {
      const analytics = await instantly.getCampaignAnalytics();
      const campaigns = Array.isArray(analytics) ? analytics : (analytics?.data || []);
      for (const c of campaigns) {
        emailsSent += c.emails_sent_count || c.emails_sent || c.sent || 0;
      }
    } catch (e) {
      console.warn('[daily-metrics] Instantly analytics failed:', e.message);
    }

    // ---- Replies: totals, plus the health of the LinkedIn queue ----
    const replySnap = await replies.get();
    let positiveReplies = 0, meetingsHeld = 0, secondCallsBooked = 0, closedDeals = 0;
    let liOpen = 0, liNeedsReply = 0, liWaiting3d = 0, liNoDraft = 0, liUntagged = 0, liNoSubsequence = 0;
    let repliesRespondedTotal = 0, repliesRespondedToday = 0;
    const dayStart = new Date(today + 'T00:00:00Z').getTime();

    replySnap.forEach(doc => {
      const d = doc.data();
      if (POSITIVE.includes(d.classification)) positiveReplies++;
      if (d.had_meeting) meetingsHeld++;
      if (d.second_call_booked) secondCallsBooked++;
      if (d.closed_deal) closedDeals++;

      // An actual outbound response — the only honest denominator for reply rate.
      const sentMs = toMs(d.sent_at);
      const answeredInHeyreach = d.handled === true && REAL_RESPONSE_REASONS.includes(d.handled_reason);
      if (sentMs || answeredInHeyreach) {
        repliesRespondedTotal++;
        if (sentMs && sentMs >= dayStart) repliesRespondedToday++;
      }

      const isLinkedIn = d.source === 'heyreach' || d.source === 'ulinc';
      if (isLinkedIn && d.handled !== true) {
        liOpen++;
        const positive = d.auto_tag_interested === true || POSITIVE.includes(d.classification);
        if (positive) {
          liNeedsReply++;
          // SOP Rules 3 and 4 — a positive reply with no tag or no sub-sequence
          // is the leak that loses leads we already paid for.
          if (!d.tag) liUntagged++;
          if (!d.subsequence) liNoSubsequence++;
        }
        if (!(d.draft_response || '').trim()) liNoDraft++;
        const age = toMs(d.message_date || d.created_at);
        if (age && Date.now() - age >= 3 * 86400000 && positive) liWaiting3d++;
      }
    });

    const bookedSnap = await leads.where('status', '==', 'booked').count().get();
    const meetingsBooked = bookedSnap.data().count;
    const closedLeadSnap = await leads.where('status', '==', 'closed').count().get();
    const closedLeads = closedLeadSnap.data().count;

    // ---- LinkedIn outbound (HeyReach) — the SOP weekly table needs these and
    // nothing was capturing them. Per-account so a frozen or throttled sender
    // shows up instead of hiding inside the total.
    const li = { requests_sent: 0, requests_accepted: 0, inmails_sent: 0, positive_replies: 0, per_account: {} };
    try {
      const a = await axios.post(`${HR_BASE}/li_account/GetAll`, { offset: 0, limit: 100 }, { headers: hrHeaders() });
      const accounts = a.data?.items || [];
      const c = await axios.post(`${HR_BASE}/campaign/GetAll`, { offset: 0, limit: 100 }, { headers: hrHeaders() });
      const campaignIds = (c.data?.items || []).map(x => x.id);
      const from = `${today}T00:00:00.000Z`, to = `${today}T23:59:59.999Z`;
      for (const acc of accounts) {
        try {
          const r = await axios.post(`${HR_BASE}/stats/GetOverallStats`,
            { accountIds: [acc.id], campaignIds, startDate: from, endDate: to }, { headers: hrHeaders() });
          const s = r.data?.overallStats || r.data || {};
          const name = [acc.firstName, acc.lastName].filter(Boolean).join(' ') || String(acc.id);
          const row = {
            requests_sent: s.connectionsSent || 0,
            requests_accepted: s.connectionsAccepted || 0,
            inmails_sent: s.inmailMessagesSent || 0,
            positive_replies: s.autoTaggedInterested || 0,
          };
          li.per_account[name] = row;
          li.requests_sent += row.requests_sent;
          li.requests_accepted += row.requests_accepted;
          li.inmails_sent += row.inmails_sent;
          li.positive_replies += row.positive_replies;
        } catch (e) { /* one bad account must not lose the whole snapshot */ }
      }
    } catch (e) {
      console.warn('[daily-metrics] HeyReach stats failed:', e.message);
    }

    // ---- Deltas against yesterday ----
    const prevSnap = await dailyMetrics.orderBy('date', 'desc').limit(2).get();
    const prev = prevSnap.docs.map(d => d.data()).find(d => d.date !== today) || {};
    const delta = (now, before) => (typeof before === 'number' ? Math.max(0, now - before) : null);

    const snapshot = {
      date: today,
      // Running totals — the original field names, unchanged.
      emails_sent: emailsSent,
      positive_replies: positiveReplies,
      meetings_booked: meetingsBooked,
      meetings_held: meetingsHeld,
      second_calls_booked: secondCallsBooked,
      closed_deals: closedDeals + closedLeads,
      replies_responded: repliesRespondedTotal,

      // What actually moved today.
      emails_sent_today: delta(emailsSent, prev.emails_sent),
      positive_replies_today: delta(positiveReplies, prev.positive_replies),
      meetings_booked_today: delta(meetingsBooked, prev.meetings_booked),
      replies_responded_today: repliesRespondedToday,

      // LinkedIn outbound, today, per the SOP weekly table.
      linkedin: li,

      // Reply-queue health — the numbers Sameer's Jul 22 audit was built on.
      queue: {
        open: liOpen,
        needs_reply: liNeedsReply,
        waiting_3d_plus: liWaiting3d,
        awaiting_draft: liNoDraft,
        positives_untagged: liUntagged,
        positives_no_subsequence: liNoSubsequence,
        response_rate: liNeedsReply + repliesRespondedTotal > 0
          ? Number((repliesRespondedTotal / (repliesRespondedTotal + liNeedsReply)).toFixed(3))
          : null,
      },
      created_at: new Date(),
    };

    await dailyMetrics.doc(today).set(snapshot);
    console.log('[daily-metrics] Snapshot saved:', JSON.stringify({
      date: today, emails_today: snapshot.emails_sent_today, li: li.requests_sent,
      queue: snapshot.queue,
    }));
    return snapshot;
  } catch (e) {
    console.error('[daily-metrics] Error:', e);
  }
}

module.exports = { runDailyMetrics, dailyMetrics };
