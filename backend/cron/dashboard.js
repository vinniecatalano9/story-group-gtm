const { getLeadStats, leads, replies } = require('../services/db');
const instantly = require('../services/instantly');
const { notifyDashboard } = require('../services/slack');
const { addLog } = require('../services/db');

/**
 * Weekly dashboard report — pipeline funnel + signal breakdown.
 * Runs Monday 8am.
 */
async function runDashboard() {
  console.log('[dashboard] Generating weekly report...');

  try {
    // Pipeline stats
    const stats = await getLeadStats();

    // Signal breakdown
    const signalSnap = await leads.where('signal_type', '!=', null).get();
    const signalCounts = {};
    signalSnap.forEach(doc => {
      const s = doc.data().signal_type || 'no_signal';
      signalCounts[s] = (signalCounts[s] || 0) + 1;
    });

    // Tier breakdown
    const tierCounts = {};
    for (const tier of ['priority', 'standard', 'nurture', 'manual_review']) {
      const snap = await leads.where('tier', '==', tier).count().get();
      tierCounts[tier] = snap.data().count;
    }

    // Reply classification breakdown
    const replySnap = await replies.get();
    const replyCounts = {};
    replySnap.forEach(doc => {
      const c = doc.data().classification || 'unknown';
      replyCounts[c] = (replyCounts[c] || 0) + 1;
    });

    // Instantly analytics (if available)
    let instantlyStats = null;
    try {
      instantlyStats = await instantly.getCampaignAnalytics();
    } catch (e) {
      console.warn('[dashboard] Could not fetch Instantly analytics:', e.message);
    }

    const report = {
      pipeline: stats,
      signals: signalCounts,
      tiers: tierCounts,
      replies: replyCounts,
      instantly: instantlyStats,
      generated_at: new Date().toISOString(),
    };

    await addLog('dashboard', report);
    await notifyDashboard(stats);

    console.log('[dashboard] Report generated:', JSON.stringify(stats));
    return report;
  } catch (e) {
    console.error('[dashboard] Error:', e);
  }
}

module.exports = { runDashboard };
