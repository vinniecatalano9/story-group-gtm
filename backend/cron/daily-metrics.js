const { leads, replies, db } = require('../services/db');
const instantly = require('../services/instantly');

const dailyMetrics = db.collection('daily_metrics');

/**
 * Daily metrics snapshot — captures Sameer's 6 KPIs.
 * Runs nightly at 11:59pm EST.
 */
async function runDailyMetrics() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[daily-metrics] Snapshotting metrics for ${today}...`);

  try {
    // 1. Emails sent (from Instantly)
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

    // 2-5. Reply-based metrics from Firestore
    const replySnap = await replies.get();
    let positiveReplies = 0;
    let meetingsHeld = 0;
    let secondCallsBooked = 0;
    let closedDeals = 0;
    replySnap.forEach(doc => {
      const d = doc.data();
      if (['interested', 'referral', 'more_info', 'cost_question'].includes(d.classification)) {
        positiveReplies++;
      }
      if (d.had_meeting) meetingsHeld++;
      if (d.second_call_booked) secondCallsBooked++;
      if (d.closed_deal) closedDeals++;
    });

    // 3. Meetings booked (leads with status 'booked')
    const bookedSnap = await leads.where('status', '==', 'booked').count().get();
    const meetingsBooked = bookedSnap.data().count;

    // 6. Closed deals also from lead status
    const closedLeadSnap = await leads.where('status', '==', 'closed').count().get();
    const closedLeads = closedLeadSnap.data().count;

    const snapshot = {
      date: today,
      emails_sent: emailsSent,
      positive_replies: positiveReplies,
      meetings_booked: meetingsBooked,
      meetings_held: meetingsHeld,
      second_calls_booked: secondCallsBooked,
      closed_deals: closedDeals + closedLeads,
      created_at: new Date(),
    };

    // Use date as doc ID so we overwrite if run twice
    await dailyMetrics.doc(today).set(snapshot);
    console.log('[daily-metrics] Snapshot saved:', JSON.stringify(snapshot));
    return snapshot;
  } catch (e) {
    console.error('[daily-metrics] Error:', e);
  }
}

module.exports = { runDailyMetrics, dailyMetrics };
